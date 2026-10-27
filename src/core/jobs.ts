import { randomBytes } from 'node:crypto';
import { newId, nowIso, type Db } from './db.js';
import { RbaError, asRbaError } from './errors.js';
import { redact, redactDeep } from './redact.js';
import { pendingCleanupRows } from './recovery.js';

export type JobKind = 'register' | 'crawl' | 'email_wait' | 'sanitize' | 'portal_upload' | (string & {});

/**
 * Job lifecycle (`status`) and business result (`outcome`) are separate:
 *  - completed              the requested postcondition was OBSERVED (for register /
 *                           portal_upload: a caller-specified confirmation matched);
 *  - completed_unconfirmed  the workflow ran to its end and the mutation was sent,
 *                           but no confirmation was observed (a click, an HTTP 200,
 *                           a navigation or a displayed filename is not one);
 *  - outcome_unknown        a mutation may have reached the site and the job could
 *                           not determine what happened (timeout, crash, lost link);
 *                           never repeated automatically;
 *  - interrupted            the orchestrator ended before any side effect; safe to re-run;
 *  - failed / cancelled / blocked.
 */
export type JobStatus =
  | 'created'
  | 'running'
  | 'awaiting_email'
  | 'verifying'
  | 'completed'
  | 'completed_unconfirmed'
  | 'outcome_unknown'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export const TERMINAL: readonly JobStatus[] = ['completed', 'completed_unconfirmed', 'outcome_unknown', 'interrupted', 'failed', 'cancelled', 'blocked'];
/** SQL list for `status IN ${TERMINAL_SQL}` / `NOT IN`. */
export const TERMINAL_SQL = `(${TERMINAL.map((s) => `'${s}'`).join(', ')})`;
export function isTerminal(s: string): boolean {
  return (TERMINAL as readonly string[]).includes(s);
}

/** What is known about the job's side effect on the destination. */
export type JobOutcome = 'confirmed' | 'submitted_unconfirmed' | 'outcome_unknown' | 'not_sent' | 'rejected' | 'blocked';

/**
 * Durable steps (monotonic per workflow, persisted BEFORE the side effect they guard):
 *  upload: preflight -> session_ready -> file_transferred -> file_selected -> form_submitted -> confirmation_observed
 *  signup: preflight -> session_ready -> form_submitted -> verification_pending -> verification_followed -> confirmation_observed
 */
export type JobStep =
  | 'preflight'
  | 'session_ready'
  | 'file_transferred'
  | 'file_selected'
  | 'form_submitted'
  | 'verification_pending'
  | 'verification_followed'
  | 'confirmation_observed'
  | 'confirmation_missing';

/** Kinds whose job performs a mutation on a third-party site. */
const MUTATING: string[] = ['register', 'portal_upload'];

const NEXT: Record<JobStatus, JobStatus[]> = {
  created: ['running'],
  running: ['awaiting_email', 'verifying'],
  awaiting_email: ['verifying', 'running'],
  verifying: [],
  completed: [],
  completed_unconfirmed: [],
  outcome_unknown: [],
  interrupted: [],
  failed: [],
  cancelled: [],
  blocked: [],
};

export interface JobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  account_id: string | null;
  session_id: string | null;
  params_json: string;
  progress_json: string | null;
  result_json: string | null;
  error: string | null;
  attempts: number;
  submitted_at: string | null;
  cancel_requested: number;
  owner_pid: number | null;
  created_at: string;
  updated_at: string;
  step: JobStep | null;
  outcome: JobOutcome | null;
  idempotency_key: string | null;
  owner_instance: string | null;
  heartbeat_at: number | null;
  interrupted_at: string | null;
}

export class JobBlocked extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Thrown by a workflow when a mutation may have reached the site and its result is not known. */
export class OutcomeUnknown extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** This process's identity: pid plus a random nonce (pid reuse cannot impersonate it). */
export const INSTANCE = `${process.pid}:${randomBytes(6).toString('hex')}`;

/** A job whose owner has not written a heartbeat for this long is treated as orphaned. */
export const HEARTBEAT = { everyMs: 5_000, staleMs: 60_000 };

export interface CancelResult {
  row: JobRow;
  effect: 'already_terminal' | 'cancelled' | 'cancel_requested';
  sideEffectsPossible: boolean;
}

export class Jobs {
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly db: Db) {}

  /**
   * Create a job. `idempotencyKey` (caller-supplied) returns the existing job for
   * the same key instead of creating a second one. Derived keys guard against
   * concurrent duplicates atomically (unique index):
   *  - portal_upload without allowRepeat: one upload of the same bytes to the same
   *    target while running, and forever once it was possibly sent;
   *  - register with accountId: one active registration job per account.
   */
  createIdempotent(kind: JobKind, params: unknown, refs: { accountId?: string | null; sessionId?: string | null } = {}, idempotencyKey?: string): { jobId: string; deduplicated: boolean } {
    const key = idempotencyKey ? `user:${idempotencyKey}` : derivedKey(kind, params, refs);
    return this.db.tx(() => {
      if (key) {
        const prior = this.db.get<{ id: string; status: string }>('SELECT id, status FROM jobs WHERE idempotency_key = ?', key);
        if (prior) {
          if (key.startsWith('user:')) return { jobId: prior.id, deduplicated: true };
          throw new RbaError(
            'conflict',
            key.startsWith('auto:once:')
              ? `the same file bytes were already sent (or may have been sent) to this target by job ${prior.id} (${prior.status}). Check the portal before uploading again; pass allowRepeat: true only if a second copy is intended.`
              : `job ${prior.id} (${prior.status}) is still active for this account`,
            { priorJobId: prior.id },
          );
        }
      }
      const id = newId('job');
      const t = nowIso();
      this.db.run(
        `INSERT INTO jobs (id, kind, status, account_id, session_id, params_json, owner_pid, owner_instance, heartbeat_at, idempotency_key, created_at, updated_at) VALUES (?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        kind,
        refs.accountId ?? null,
        refs.sessionId ?? null,
        JSON.stringify(redactDeep(params)),
        process.pid,
        INSTANCE,
        Date.now(),
        key,
        t,
        t,
      );
      this.event(id, 'created', `${kind} job created`);
      return { jobId: id, deduplicated: false };
    });
  }

  create(kind: JobKind, params: unknown, refs: { accountId?: string | null; sessionId?: string | null } = {}): string {
    return this.createIdempotent(kind, params, refs).jobId;
  }

  row(id: string): JobRow {
    const r = this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
    if (!r) throw new RbaError('not_found', `job ${id} not found`);
    return r;
  }

  event(id: string, state: string, message: string): void {
    this.db.run('INSERT INTO job_events (job_id, ts, state, message) VALUES (?, ?, ?, ?)', id, nowIso(), state, redact(message).slice(0, 1000));
  }

  /** Non-terminal transitions (compare-and-set); terminal ones go through finish(). */
  transition(id: string, to: JobStatus, message: string, o: { outcome?: JobOutcome } = {}): void {
    if (isTerminal(to)) {
      const r = this.row(id);
      if (isTerminal(r.status)) throw new RbaError('conflict', `job ${id} already ${r.status}`);
      // Invariant: a job that sent (or may have sent) a mutation is `completed` only with an observed confirmation.
      if (to === 'completed' && r.submitted_at && (o.outcome ?? r.outcome) !== 'confirmed') {
        throw new RbaError('internal', `job ${id}: completed requires an observed confirmation (outcome is ${o.outcome ?? r.outcome ?? 'unset'})`);
      }
      if (!this.finish(id, to as FinalStatus, { message, outcome: o.outcome })) throw new RbaError('conflict', `job ${id} already ${this.row(id).status}`);
      return;
    }
    this.db.tx(() => {
      const r = this.row(id);
      if (isTerminal(r.status)) throw new RbaError('conflict', `job ${id} already ${r.status}`);
      if (!NEXT[r.status].includes(to)) throw new RbaError('internal', `illegal job transition ${r.status} -> ${to}`);
      this.db.run('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?', to, nowIso(), id, r.status);
      this.event(id, to, message);
    });
  }

  /**
   * Atomically move a job to a terminal state. Returns false if it already was
   * terminal (the first terminal write wins: a cancel racing a completion never
   * overwrites it). Derived "active" idempotency keys are released; "once" keys
   * are kept when the side effect may have happened.
   */
  finish(id: string, status: FinalStatus, o: { message: string; error?: string | null; outcome?: JobOutcome | null }): boolean {
    const done = this.db.tx(() => {
      const r = this.row(id);
      if (isTerminal(r.status)) return false;
      const keepKey = r.idempotency_key && (r.idempotency_key.startsWith('user:') || (r.idempotency_key.startsWith('auto:once:') && r.submitted_at));
      const err = o.error === undefined ? null : o.error === null ? null : redact(o.error).slice(0, 2000);
      this.db.run(
        `UPDATE jobs SET status = ?, error = COALESCE(?, error), outcome = COALESCE(?, outcome), idempotency_key = ?, updated_at = ? WHERE id = ? AND status NOT IN ${TERMINAL_SQL}`,
        status,
        err,
        o.outcome ?? null,
        keepKey ? r.idempotency_key : null,
        nowIso(),
        id,
      );
      this.event(id, status, o.message);
      return true;
    });
    if (done) this.onTerminal?.(id);
    return done;
  }

  /** Called after a job's first terminal write (the context snapshots its run report). */
  onTerminal: ((jobId: string) => void) | null = null;

  setProgress(id: string, progress: unknown): void {
    this.db.run('UPDATE jobs SET progress_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(redactDeep(progress)), nowIso(), id);
  }

  setResult(id: string, result: unknown): void {
    this.db.run('UPDATE jobs SET result_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(redactDeep(result)), nowIso(), id);
  }

  setOutcome(id: string, outcome: JobOutcome): void {
    this.db.run('UPDATE jobs SET outcome = ?, updated_at = ? WHERE id = ?', outcome, nowIso(), id);
  }

  /** Persist a step (and its evidence) before/after the action it describes. */
  setStep(id: string, step: JobStep, evidence?: unknown, status: 'started' | 'done' | 'failed' = 'done'): void {
    const t = nowIso();
    let ev: string | null = null;
    if (evidence !== undefined) {
      ev = JSON.stringify(redactDeep(evidence));
      if (ev.length > 8000) ev = JSON.stringify({ truncated: true, head: ev.slice(0, 7900) });
    }
    this.db.tx(() => {
      this.db.run('INSERT INTO job_steps (job_id, step, status, started_at, ended_at, evidence_json) VALUES (?, ?, ?, ?, ?, ?)', id, step, status, t, status === 'started' ? null : t, ev);
      this.db.run('UPDATE jobs SET step = ?, updated_at = ? WHERE id = ?', step, t, id);
    });
  }

  steps(id: string): Array<{ step: string; status: string; at: string; evidence: unknown }> {
    return this.db
      .all<{ step: string; status: string; started_at: string; evidence_json: string | null }>('SELECT step, status, started_at, evidence_json FROM job_steps WHERE job_id = ? ORDER BY id', id)
      .map((s) => ({ step: s.step, status: s.status, at: s.started_at, evidence: s.evidence_json ? JSON.parse(s.evidence_json) : null }));
  }

  /** Record "possibly sent" BEFORE the side effect (and the step it belongs to). */
  markSubmitted(id: string, step: JobStep = 'form_submitted'): void {
    const t = nowIso();
    this.db.tx(() => {
      this.db.run('UPDATE jobs SET submitted_at = ?, attempts = attempts + 1, step = ?, updated_at = ? WHERE id = ?', t, step, t, id);
      this.db.run('INSERT INTO job_steps (job_id, step, status, started_at) VALUES (?, ?, ?, ?)', id, step, 'started', t);
    });
  }

  /** Withdraw a submission mark when the side effect is known not to have happened. */
  clearSubmitted(id: string, why: string): void {
    this.db.tx(() => {
      this.db.run('UPDATE jobs SET submitted_at = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
      this.db.run('INSERT INTO job_steps (job_id, step, status, started_at, ended_at, evidence_json) VALUES (?, ?, ?, ?, ?, ?)', id, 'not_sent', 'done', nowIso(), nowIso(), JSON.stringify({ reason: redact(why).slice(0, 300) }));
    });
  }

  /** Legacy helper: terminal failure with an error message. */
  fail(id: string, status: 'failed' | 'cancelled' | 'blocked' | 'interrupted' | 'outcome_unknown', error: string, outcome?: JobOutcome): boolean {
    return this.finish(id, status, { message: error, error, outcome });
  }

  /**
   * Run `fn` in the background and map its end to a terminal state. With
   * `resume`, the job keeps its current status (recovery re-attaching a job it
   * claimed). The watcher polls the cross-process cancel flag, writes the
   * heartbeat and stops the job if another instance took it over.
   */
  start(id: string, fn: (signal: AbortSignal) => Promise<void>, o: { resume?: boolean } = {}): void {
    const ac = new AbortController();
    let lost = false;
    this.controllers.set(id, ac);
    let ticks = 0;
    const watch = setInterval(() => {
      try {
        const r = this.row(id);
        if (r.owner_instance && r.owner_instance !== INSTANCE) {
          lost = true;
          ac.abort();
          return;
        }
        if (r.cancel_requested) ac.abort();
        if (++ticks % Math.max(1, Math.round(HEARTBEAT.everyMs / 1000)) === 0) this.db.run('UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND owner_instance = ?', Date.now(), id, INSTANCE);
      } catch {
        /* db closed */
      }
    }, 1000);
    watch.unref();
    const p = (async () => {
      try {
        if (!o.resume) this.transition(id, 'running', 'started');
        else this.event(id, this.row(id).status, `resumed by ${INSTANCE.split(':')[0]}`);
        await fn(ac.signal);
        const r = this.row(id);
        if (!isTerminal(r.status) && !lost) this.finish(id, 'failed', { message: 'job ended without a final state', error: 'internal: job ended without a final state' });
      } catch (e) {
        if (!lost) this.settleError(id, e, ac.signal.aborted);
      } finally {
        clearInterval(watch);
        this.controllers.delete(id);
        this.running.delete(id);
      }
    })();
    this.running.set(id, p);
  }

  /** Map a workflow error to a terminal state without losing what may have been sent. */
  private settleError(id: string, e: unknown, aborted: boolean): void {
    const r = this.row(id);
    if (isTerminal(r.status)) return;
    const mutating = MUTATING.includes(r.kind);
    const submitted = !!r.submitted_at;
    const known = r.outcome && r.outcome !== 'outcome_unknown' && r.outcome !== 'submitted_unconfirmed' ? r.outcome : null;
    const unresolved: JobOutcome | null = submitted ? (known ?? 'outcome_unknown') : mutating ? (known ?? 'not_sent') : known;
    const msg = e instanceof Error ? asRbaError(e).message : String(e);
    if (e instanceof JobBlocked) {
      this.finish(id, 'blocked', { message: e.message, error: e.message, outcome: submitted ? (known ?? 'blocked') : mutating ? 'not_sent' : null });
      return;
    }
    if (aborted || r.cancel_requested) {
      const isCancelErr = asRbaError(e).code === 'cancelled';
      const text = `cancelled by request${isCancelErr ? '' : ` (while: ${msg})`}${submitted && !known ? '; the side effect had already been sent: it may have taken effect (not undone)' : ''}`;
      this.finish(id, 'cancelled', { message: text, error: text, outcome: unresolved });
      return;
    }
    if (e instanceof OutcomeUnknown || (submitted && !known)) {
      this.finish(id, 'outcome_unknown', { message: msg, error: msg, outcome: 'outcome_unknown' });
      return;
    }
    this.finish(id, 'failed', { message: msg, error: msg, outcome: unresolved });
  }

  /** Throw if a cancel was requested; call right before irreversible side effects. */
  assertNotCancelled(id: string, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.row(id).cancel_requested) throw new RbaError('cancelled', 'cancelled by request');
  }

  /** Wait for a background job (tests and graceful shutdown). */
  async settle(id: string): Promise<JobRow> {
    await this.running.get(id);
    return this.row(id);
  }

  isLocal(id: string): boolean {
    return this.controllers.has(id);
  }

  cancel(id: string): CancelResult {
    const r = this.row(id);
    if (isTerminal(r.status)) return { row: r, effect: 'already_terminal', sideEffectsPossible: !!r.submitted_at && r.outcome !== 'not_sent' };
    this.db.run('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?', nowIso(), id);
    const ac = this.controllers.get(id);
    let effect: CancelResult['effect'] = 'cancel_requested';
    if (ac) ac.abort();
    else if (!this.ownerAlive(r)) {
      const submitted = !!r.submitted_at;
      const text = `cancelled (owning process is gone)${submitted ? '; the side effect had already been sent: it may have taken effect' : ''}`;
      if (this.finish(id, 'cancelled', { message: text, error: text, outcome: submitted ? 'outcome_unknown' : MUTATING.includes(r.kind) ? 'not_sent' : null })) effect = 'cancelled';
    } else this.event(id, r.status, 'cancellation requested; the owning process will stop the job');
    const after = this.row(id);
    return { row: after, effect: isTerminal(after.status) && effect === 'cancel_requested' ? 'cancelled' : effect, sideEffectsPossible: !!after.submitted_at };
  }

  view(id: string): Record<string, unknown> {
    const r = this.row(id);
    const events = this.db.all<{ ts: string; state: string; message: string }>('SELECT ts, state, message FROM job_events WHERE job_id = ? ORDER BY id', id);
    const terminal = isTerminal(r.status);
    const sideEffectsPossible = !!r.submitted_at && r.outcome !== 'not_sent';
    return {
      jobId: r.id,
      kind: r.kind,
      status: r.status,
      step: r.step,
      outcome: r.outcome,
      accountId: r.account_id,
      sessionId: r.session_id,
      progress: r.progress_json ? JSON.parse(r.progress_json) : null,
      result: r.result_json ? JSON.parse(r.result_json) : null,
      error: r.error,
      submittedAt: r.submitted_at,
      sideEffectsPossible,
      safeToRetry: retryAdvice(r),
      nextAction: nextAction(r),
      interrupted: r.interrupted_at ? { at: r.interrupted_at } : null,
      idempotencyKey: r.idempotency_key?.startsWith('user:') ? r.idempotency_key.slice(5) : null,
      cancelRequested: !!r.cancel_requested,
      pendingCleanup: pendingCleanupRows(this.db, { jobId: r.id, sessionId: r.session_id }),
      attempts: r.attempts,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      terminal,
      steps: this.steps(id),
      events,
    };
  }

  list(limit = 50): Array<Record<string, unknown>> {
    return this.db
      .all<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', limit)
      .map((r) => ({ jobId: r.id, kind: r.kind, status: r.status, step: r.step, outcome: r.outcome, accountId: r.account_id, error: r.error, updatedAt: r.updated_at }));
  }

  /** Is the job's owner still running it? (heartbeat-based; pid reuse cannot fake it) */
  ownerAlive(r: JobRow): boolean {
    if (r.owner_instance === INSTANCE) return this.controllers.has(r.id);
    if (!r.owner_pid) return false;
    if (r.owner_pid !== process.pid) {
      try {
        process.kill(r.owner_pid, 0);
      } catch {
        return false;
      }
    } else if (r.owner_instance && r.owner_instance !== INSTANCE) {
      return false; // our pid, another (earlier) instance: that process is gone
    }
    if (r.heartbeat_at === null) return r.owner_pid !== process.pid; // legacy row: pid check only
    return Date.now() - r.heartbeat_at < HEARTBEAT.staleMs;
  }

  /** Non-terminal jobs whose owner is gone. */
  orphans(): JobRow[] {
    return this.db.all<JobRow>(`SELECT * FROM jobs WHERE status NOT IN ${TERMINAL_SQL}`).filter((r) => !this.controllers.has(r.id) && !this.ownerAlive(r));
  }

  /** Compare-and-set ownership: only one process can claim an orphan. */
  claim(id: string, from: JobRow): boolean {
    const r = this.db.run(
      'UPDATE jobs SET owner_pid = ?, owner_instance = ?, heartbeat_at = ?, interrupted_at = COALESCE(interrupted_at, ?), updated_at = ? WHERE id = ? AND owner_instance IS ? AND owner_pid IS ? AND status = ?',
      process.pid,
      INSTANCE,
      Date.now(),
      nowIso(),
      nowIso(),
      id,
      from.owner_instance,
      from.owner_pid,
      from.status,
    );
    return r.changes === 1;
  }
}

export type FinalStatus = Exclude<JobStatus, 'created' | 'running' | 'awaiting_email' | 'verifying'>;

function derivedKey(kind: JobKind, params: unknown, refs: { accountId?: string | null }): string | null {
  const p = (params ?? {}) as { dedupeKey?: string; allowRepeat?: boolean; accountId?: string };
  if (kind === 'portal_upload' && p.dedupeKey && !p.allowRepeat) return `auto:once:portal:${p.dedupeKey}`;
  if (kind === 'register' && (refs.accountId ?? p.accountId)) return `auto:active:register:${refs.accountId ?? p.accountId}`;
  return null;
}

function retryAdvice(r: JobRow): { safe: boolean; reason: string } {
  if (!isTerminal(r.status)) return { safe: false, reason: 'the job is still active' };
  if (r.status === 'completed') return { safe: false, reason: 'the job completed; repeating it would perform the action again' };
  if (r.submitted_at && r.outcome !== 'not_sent' && r.outcome !== 'rejected') {
    return { safe: false, reason: 'the side effect was (or may have been) sent; check the destination before any repeat. It is never repeated automatically.' };
  }
  if (r.status === 'blocked') return { safe: false, reason: 'the site blocked access or requires human verification; stop and report' };
  if (r.outcome === 'rejected') return { safe: false, reason: 'the site rejected the request; repeating will not change that' };
  return { safe: true, reason: 'nothing was sent to the destination' };
}

function nextAction(r: JobRow): string | null {
  if (!isTerminal(r.status)) return r.cancel_requested ? 'cancellation requested; poll job_status' : 'poll job_status';
  const submitted = !!r.submitted_at && r.outcome !== 'not_sent';
  if (r.kind === 'register') {
    if (r.status === 'completed') return null;
    if (submitted && r.account_id) return `The signup form was submitted; do not resubmit. Re-run account_register with accountId=${r.account_id} to check the inbox (it never resubmits).`;
  }
  if (r.kind === 'portal_upload') {
    if (r.status === 'completed') return null;
    if (submitted) return 'The file may have reached the portal. Check the portal before uploading again; a repeat is refused unless allowRepeat is set.';
  }
  if (r.status === 'interrupted') return 'Interrupted before any side effect; safe to start again.';
  return null;
}
