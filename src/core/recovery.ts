/**
 * Crash recovery and provider cleanup (W2).
 *
 *  - cleanup_queue: provider resources that must still be released (Apify runs,
 *    local worker processes `local:<pid>:<nonce>`, MailSlurp inboxes, file locks).
 *    An entry is marked done only when the provider confirms the resource is gone;
 *    failures are retried with exponential backoff (30 s .. 1 h) and reported as
 *    pending cleanup by job_status and the execution report.
 *  - reconcile(): startup sequence (reap sessions, inbox reservations, orphaned
 *    jobs, drain the queue). Orphaned jobs are claimed with a compare-and-set; only
 *    side-effect-free continuations are resumed automatically (re-attaching a crawl
 *    whose run is still running). A job that may have sent a mutation becomes
 *    outcome_unknown and is never repeated; one that sent nothing becomes interrupted.
 *  - a bounded gate so mutating tools wait for reconciliation (job_status and
 *    job_cancel never wait).
 */
import type { BrowserProvider } from '../providers/types.js';
import type { Ctx } from './context.js';
import { newId, nowIso, type Db } from './db.js';
import type { JobRow } from './jobs.js';
import { redact } from './redact.js';

export type CleanupKind = 'apify_run' | 'local_worker' | 'mailslurp_inbox' | 'lease' | 'file_lock';

export interface CleanupRow {
  id: string;
  kind: CleanupKind;
  ref: string;
  job_id: string | null;
  session_id: string | null;
  account_id: string | null;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  done_at: string | null;
}

export interface PendingCleanup {
  kind: CleanupKind;
  ref: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  since: string;
}

export const BACKOFF = { baseMs: 30_000, maxMs: 3_600_000 };

export function runCleanupKind(p: Pick<BrowserProvider, 'kind'>): CleanupKind {
  return p.kind === 'local' ? 'local_worker' : 'apify_run';
}

/** Queue a resource for release (idempotent per kind+ref; re-opens a finished entry). */
export function enqueueCleanup(
  db: Db,
  c: { kind: CleanupKind; ref: string; jobId?: string | null; sessionId?: string | null; accountId?: string | null; error?: string | null },
): void {
  const t = nowIso();
  db.run(
    `INSERT INTO cleanup_queue (id, kind, ref, job_id, session_id, account_id, attempts, next_attempt_at, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(kind, ref) DO UPDATE SET done_at = NULL,
       job_id = COALESCE(excluded.job_id, job_id), session_id = COALESCE(excluded.session_id, session_id),
       account_id = COALESCE(excluded.account_id, account_id), last_error = COALESCE(excluded.last_error, last_error)`,
    newId('cln'),
    c.kind,
    c.ref,
    c.jobId ?? null,
    c.sessionId ?? null,
    c.accountId ?? null,
    t,
    c.error ? redact(c.error).slice(0, 500) : null,
    t,
  );
}

/** Open cleanup entries, optionally for one job and/or session. */
export function pendingCleanupRows(db: Db, f: { jobId?: string | null; sessionId?: string | null } = {}): PendingCleanup[] {
  let rows: CleanupRow[];
  try {
    if (f.jobId || f.sessionId) {
      rows = db.all<CleanupRow>('SELECT * FROM cleanup_queue WHERE done_at IS NULL AND (job_id = ? OR session_id = ?) ORDER BY created_at', f.jobId ?? '\u0000', f.sessionId ?? '\u0000');
    } else rows = db.all<CleanupRow>('SELECT * FROM cleanup_queue WHERE done_at IS NULL ORDER BY created_at');
  } catch {
    return []; // table missing (database not migrated yet)
  }
  return rows.map((r) => ({ kind: r.kind, ref: r.ref, attempts: r.attempts, lastError: r.last_error, nextAttemptAt: r.next_attempt_at, since: r.created_at }));
}

/** Pending provider cleanup for the execution report (ExecutionReport.cleanup.pending). */
export function pendingCleanup(ctx: Pick<Ctx, 'db'>, f: { jobId?: string; sessionId?: string } = {}): PendingCleanup[] {
  return pendingCleanupRows(ctx.db, f);
}

function isGone(e: unknown): boolean {
  return /\b404\b|not found/i.test((e as Error)?.message ?? '');
}

/** Try one entry. Returns true once the resource is confirmed released. */
async function attempt(ctx: Ctx, r: CleanupRow): Promise<true | string> {
  switch (r.kind) {
    case 'apify_run':
    case 'local_worker': {
      const p = r.kind === 'local_worker' ? ctx.providers.local : ctx.providers.remote;
      if (!p) return `${r.kind === 'local_worker' ? 'local' : 'remote'} provider not configured in this process`;
      try {
        await p.abortRun(r.ref);
      } catch (e) {
        if (!isGone(e)) {
          // The abort call failed; the run may still have ended on its own.
          const info = await p.getRun(r.ref).catch(() => null);
          if (!info || ['running', 'starting'].includes(info.state)) return `abort failed: ${(e as Error).message}`;
        }
      }
      const info = await p.getRun(r.ref).catch((e) => (isGone(e) ? { state: 'finished' as const } : null));
      if (!info) return 'run state could not be confirmed after abort';
      if (['running', 'starting'].includes(info.state)) return `run still ${info.state} after abort`;
      if (r.session_id) ctx.sessions.confirmRunStopped(r.session_id, 'run confirmed stopped by cleanup queue');
      return true;
    }
    case 'mailslurp_inbox': {
      if (!ctx.mail) return 'MailSlurp not configured in this process';
      try {
        await ctx.mail.deleteInbox(r.ref);
      } catch (e) {
        if (!isGone(e)) return `inbox delete failed: ${(e as Error).message}`;
      }
      ctx.db.run(
        `UPDATE usage SET detail_json = json_set(COALESCE(detail_json, '{}'), '$.providerInboxDeleted', json('true'), '$.deletedByCleanupAt', ?) WHERE kind = 'mailslurp_inbox_created' AND ref = ?`,
        nowIso(),
        r.ref,
      );
      return true;
    }
    case 'lease':
      ctx.accounts.release(r.ref);
      return true;
    case 'file_lock':
      ctx.db.run('UPDATE files SET locked_by = NULL, lock_expires = NULL WHERE id = ?', r.ref);
      return true;
  }
}

/** Attempt one queued entry now (e.g. right after queuing it). True when released, else the error. */
export async function drainCleanupFor(ctx: Ctx, kind: CleanupKind, ref: string): Promise<true | string> {
  const r = ctx.db.get<CleanupRow>('SELECT * FROM cleanup_queue WHERE kind = ? AND ref = ? AND done_at IS NULL', kind, ref);
  if (!r) return true;
  return settleEntry(ctx, r);
}

async function settleEntry(ctx: Ctx, r: CleanupRow): Promise<true | string> {
  let res: true | string;
  try {
    res = await attempt(ctx, r);
  } catch (e) {
    res = (e as Error).message;
  }
  if (res === true) {
    ctx.db.run('UPDATE cleanup_queue SET done_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?', nowIso(), r.id);
    if (r.job_id) ctx.jobs.event(r.job_id, 'cleanup', `${r.kind} ${r.ref} released`);
  } else {
    const delay = Math.min(BACKOFF.baseMs * 2 ** r.attempts, BACKOFF.maxMs);
    ctx.db.run('UPDATE cleanup_queue SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?', redact(res).slice(0, 500), new Date(Date.now() + delay).toISOString(), r.id);
  }
  return res;
}

/** Process due entries (all open entries with `force`). */
export async function drainCleanup(ctx: Ctx, o: { force?: boolean } = {}): Promise<{ done: number; failed: number; pending: number }> {
  const now = nowIso();
  const due = o.force
    ? ctx.db.all<CleanupRow>('SELECT * FROM cleanup_queue WHERE done_at IS NULL ORDER BY created_at')
    : ctx.db.all<CleanupRow>('SELECT * FROM cleanup_queue WHERE done_at IS NULL AND next_attempt_at <= ? ORDER BY created_at', now);
  let done = 0;
  let failed = 0;
  for (const r of due) {
    if ((await settleEntry(ctx, r)) === true) done++;
    else failed++;
  }
  const pending = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM cleanup_queue WHERE done_at IS NULL')?.n ?? 0;
  return { done, failed, pending };
}

/**
 * Inbox reservations: Usage.recoverInboxReservations adopts orphan inboxes and tries
 * to delete them once. Deletions that failed are queued here so they are retried.
 */
export function queueUndeletedInboxes(ctx: Ctx): number {
  const rows = ctx.db.all<{ ref: string }>(
    `SELECT ref FROM usage WHERE kind = 'mailslurp_inbox_created' AND json_extract(detail_json, '$.orphanRecovered') = 1 AND json_extract(detail_json, '$.providerInboxDeleted') = 0`,
  );
  for (const r of rows) enqueueCleanup(ctx.db, { kind: 'mailslurp_inbox', ref: r.ref, error: 'orphan inbox deletion failed during reservation recovery' });
  return rows.length;
}

/** Orphaned jobs: claim (compare-and-set), resume safe continuations, settle the rest. */
export async function recoverJobs(ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  for (const j of ctx.jobs.orphans()) {
    if (!ctx.jobs.claim(j.id, j)) continue; // another process took it
    out.push(j.id);
    ctx.jobs.setStep(j.id, (j.step ?? 'preflight') as never, { interrupted: true, previousStatus: j.status, previousOwnerPid: j.owner_pid, submittedAt: j.submitted_at }, 'failed');
    if (await tryResume(ctx, j)) continue;
    settleOrphan(ctx, j);
  }
  return out;
}

async function tryResume(ctx: Ctx, j: JobRow): Promise<boolean> {
  // Re-attach to a crawl whose remote/local run is still working: reading results is side-effect free
  // and no new run is started.
  if (j.kind !== 'crawl' || !j.session_id) return false;
  const s = ctx.db.get<{ status: string }>('SELECT status FROM sessions WHERE id = ?', j.session_id);
  if (s?.status !== 'ready') return false;
  const { pollCrawl } = await import('./crawl.js');
  const progress = j.progress_json ? (JSON.parse(j.progress_json) as { resultsOffset?: number }) : {};
  const sid = j.session_id;
  ctx.sessions.adopt(sid);
  ctx.jobs.event(j.id, j.status, 'orchestrator restarted; re-attached to running crawl (job_cancel stops it)');
  ctx.jobs.start(
    j.id,
    async (signal) => {
      try {
        await pollCrawl(ctx, j.id, sid, signal, progress.resultsOffset ?? 0);
      } finally {
        await ctx.sessions.close(sid).catch(() => undefined);
      }
    },
    { resume: true },
  );
  return true;
}

function settleOrphan(ctx: Ctx, j: JobRow): void {
  // File locks held by the dead job are released.
  ctx.db.run('UPDATE files SET locked_by = NULL, lock_expires = NULL WHERE locked_by = ?', j.id);
  const mutating = j.kind === 'register' || j.kind === 'portal_upload';
  const sent = !!j.submitted_at && j.outcome !== 'not_sent' && j.outcome !== 'rejected';
  if (j.cancel_requested) {
    const text = `cancelled (owning process ended)${sent ? '; the side effect had already been sent: it may have taken effect' : ''}`;
    ctx.jobs.finish(j.id, 'cancelled', { message: text, error: text, outcome: sent ? 'outcome_unknown' : mutating ? 'not_sent' : null });
  } else if (sent) {
    if (j.kind === 'register' && j.account_id) {
      const a = ctx.db.get<{ status: string }>('SELECT status FROM accounts WHERE id = ?', j.account_id);
      if (a && a.status !== 'active') ctx.accounts.setStatus(j.account_id, 'unknown', 'orchestrator stopped after signup submission; outcome unknown');
    }
    const why =
      j.kind === 'portal_upload'
        ? `interrupted at step ${j.step ?? 'file_selected'} after the file was (possibly) sent: OUTCOME UNKNOWN. Check the portal before uploading again (portal_upload refuses a repeat unless allowRepeat is set)`
        : `interrupted at step ${j.step ?? 'form_submitted'} after the signup form was submitted: OUTCOME UNKNOWN. Re-run account_register with accountId to check the inbox (it never resubmits)`;
    ctx.jobs.finish(j.id, 'outcome_unknown', { message: why, error: `interrupted: orchestrator process ended; ${why}`, outcome: 'outcome_unknown' });
  } else {
    const why = `interrupted: orchestrator process ended at step ${j.step ?? j.status}; nothing was sent to the destination; safe to start again`;
    ctx.jobs.finish(j.id, 'interrupted', { message: why, error: why, outcome: mutating ? 'not_sent' : null });
  }
  // Its session belonged to the dead process: stop the run (queued if the stop cannot be confirmed).
  if (j.session_id) {
    const s = ctx.db.get<{ status: string }>('SELECT status FROM sessions WHERE id = ?', j.session_id);
    if (s && ['starting', 'ready', 'closing'].includes(s.status)) void ctx.sessions.close(j.session_id).catch(() => undefined);
  }
}

export interface ReconcileReport {
  sessions: { reaped: number; expiredLeases: number };
  inboxes: { released: number; orphansDeleted: number; orphansKept: number; deferred: number; queued: number };
  jobs: string[];
  emailModes: { closed: number; retired: number; trimmed: number; failed: number };
  cleanup: { done: number; failed: number; pending: number };
}

/** Startup reconciliation, in order. Each stage is isolated: one failing does not skip the others. */
export async function reconcile(ctx: Ctx): Promise<ReconcileReport> {
  const rep: ReconcileReport = {
    sessions: { reaped: 0, expiredLeases: 0 },
    inboxes: { released: 0, orphansDeleted: 0, orphansKept: 0, deferred: 0, queued: 0 },
    jobs: [],
    emailModes: { closed: 0, retired: 0, trimmed: 0, failed: 0 },
    cleanup: { done: 0, failed: 0, pending: 0 },
  };
  const stage = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      ctx.db.log('warn', `recovery stage ${name} failed: ${(e as Error).message}`);
    }
  };
  await stage('sessions', async () => {
    rep.sessions = await ctx.sessions.reapAll();
  });
  await stage('inboxes', async () => {
    rep.inboxes = { ...(await ctx.usage.recoverInboxReservations(ctx.mail)), queued: 0 };
    rep.inboxes.queued = queueUndeletedInboxes(ctx);
  });
  await stage('jobs', async () => {
    rep.jobs = await recoverJobs(ctx);
  });
  await stage('email_modes', async () => {
    // Close/retire disposable inboxes whose windows passed while no process ran (queues provider deletions).
    const { sweepInboxes } = await import('../email/inboxes.js');
    rep.emailModes = await sweepInboxes(ctx);
  });
  await stage('cleanup', async () => {
    rep.cleanup = await drainCleanup(ctx);
  });
  return rep;
}

// ---- recovery gate -------------------------------------------------------

/** Tools that start browser work, mutate third-party sites or provider resources. */
export const GATED_TOOLS = ['session_start', 'account_register', 'account_delete', 'account_acquire', 'crawl_start', 'portal_upload', 'email_wait_for_verification', 'email_inbox_reopen', 'email_inbox_delete', 'media_sanitize'];

/**
 * Wrap mutating tool handlers so they wait (at most `maxWaitMs`) for startup
 * reconciliation. job_status / job_cancel and read-only tools are never gated.
 */
export function gateTools<T extends { name: string; handler: (...a: any[]) => Promise<unknown> }>(tools: T[], gate: Promise<unknown>, maxWaitMs = 10_000): void {
  let open = false;
  void gate.finally(() => {
    open = true;
  });
  for (const t of tools) {
    if (!GATED_TOOLS.includes(t.name)) continue;
    const inner = t.handler;
    t.handler = (async (...args: unknown[]) => {
      if (!open) await Promise.race([gate.catch(() => undefined), new Promise((r) => setTimeout(r, maxWaitMs).unref())]);
      return inner(...args);
    }) as T['handler'];
  }
}

