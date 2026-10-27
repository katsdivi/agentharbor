/**
 * W2 workflow state, idempotency, recovery and cleanup queue (no browser, no network).
 * Faults are injected through wrapper providers / mail clients defined here.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../../src/core/db.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContext, type Ctx } from '../../src/core/context.js';
import { nowIso } from '../../src/core/db.js';
import { HEARTBEAT, INSTANCE, JobBlocked, OutcomeUnknown, TERMINAL, isTerminal } from '../../src/core/jobs.js';
import { migrate, currentVersion } from '../../src/core/migrations.js';
import { drainCleanup, enqueueCleanup, gateTools, pendingCleanup, recoverJobs } from '../../src/core/recovery.js';
import { TOOLS } from '../../src/mcp/tools/index.js';
import type { BrowserProvider, RunInfo } from '../../src/providers/types.js';
import { testConfig } from '../helpers/ctx.js';

const made: Ctx[] = [];
afterEach(() => {
  for (const c of made.splice(0)) {
    try {
      c.sessions.stopHeartbeat();
      c.db.close();
    } catch {
      /* closed */
    }
    rmSync(join(c.cfg.dataDir, '..'), { recursive: true, force: true });
  }
});

function ctxWith(o: { provider?: BrowserProvider | null; mail?: unknown; cfg?: ReturnType<typeof testConfig> } = {}): Ctx {
  const c = buildContext({ cfg: o.cfg ?? testConfig(), provider: o.provider ?? null, localProvider: null, mail: (o.mail ?? null) as never });
  made.push(c);
  return c;
}

/** A pid that certainly belonged to a process that has exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}

/** Make a job look like it belonged to a process that died. */
function orphan(ctx: Ctx, id: string, patch: Record<string, string | number | null> = {}): void {
  const sets = Object.keys(patch).map((k) => `${k} = ?`);
  ctx.db.run(`UPDATE jobs SET owner_pid = ?, owner_instance = ?, heartbeat_at = ?${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = ?`, deadPid(), `${deadPid()}:deadbeef0000`, Date.now() - 3600_000, ...Object.values(patch), id);
}

/** Wrapper provider: abort fails `failAborts` times; the run stops once an abort succeeds. */
function flakyProvider(failAborts: number): BrowserProvider & { calls: { abort: number }; running: Set<string> } {
  const running = new Set<string>();
  const calls = { abort: 0 };
  const info = (runId: string): RunInfo => ({ runId, state: running.has(runId) ? 'running' : 'aborted', statusMessage: null, usageUsd: 0, computeUnits: 0, residentialProxyGb: null, runtimeSecs: 1, preliminary: false, finishedAt: null });
  return {
    name: 'apify',
    kind: 'remote',
    calls,
    running,
    async startRun() {
      throw new Error('not used');
    },
    async getRun(runId) {
      return info(runId);
    },
    async abortRun(runId) {
      calls.abort++;
      if (calls.abort <= failAborts) throw new Error('provider 503 (simulated)');
      running.delete(runId);
    },
    async accountUsage() {
      return { monthlyUsageUsd: 0, monthlyLimitUsd: 100, cycleStart: null, cycleEnd: null };
    },
  };
}

function settled(ctx: Ctx, id: string) {
  return ctx.jobs.settle(id);
}

describe('migration v4', () => {
  it('applies once, is idempotent, and labels legacy interrupted-after-submit rows', () => {
    const ctx = ctxWith();
    expect(currentVersion(ctx.db.sql)).toBeGreaterThanOrEqual(4);
    const cols = (ctx.db.sql.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['step', 'outcome', 'idempotency_key', 'owner_instance', 'heartbeat_at', 'interrupted_at']));
    expect(migrate(ctx.db.sql)).toEqual([]); // nothing left to apply
    // a v2 database with a legacy interrupted-after-submit row is migrated forward
    const file = join(ctx.cfg.dataDir, 'legacy.sqlite');
    const legacy = new DatabaseSync(file);
    // A real v2 database: the v1 schema plus v2's columns, recorded as versions 1 and 2.
    legacy.exec(SCHEMA);
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'base', 'x'), (2, 'execution_modes', 'x');
      ALTER TABLE accounts ADD COLUMN execution_mode TEXT; ALTER TABLE sessions ADD COLUMN execution_mode TEXT; ALTER TABLE sessions ADD COLUMN route_json TEXT;
      INSERT INTO jobs (id, kind, status, params_json, submitted_at, error, created_at, updated_at) VALUES ('job_old', 'portal_upload', 'failed', '{}', 'x', 'interrupted: orchestrator process ended after the upload form was submitted', 'x', 'x');`);
    expect(migrate(legacy)).toContain(4);
    expect((legacy.prepare(`SELECT outcome FROM jobs WHERE id = 'job_old'`).get() as { outcome: string }).outcome).toBe('outcome_unknown');
    legacy.close();
  });
});

describe('job state model', () => {
  it('exports one terminal list used for SQL and code', () => {
    expect(TERMINAL).toEqual(expect.arrayContaining(['completed', 'completed_unconfirmed', 'outcome_unknown', 'interrupted', 'failed', 'cancelled', 'blocked']));
    expect(isTerminal('running')).toBe(false);
  });

  it('a job that sent a mutation can only be completed with an observed confirmation', async () => {
    const ctx = ctxWith();
    const id = ctx.jobs.create('portal_upload', { artifactId: 'a' });
    ctx.jobs.start(id, async () => {
      ctx.jobs.markSubmitted(id, 'file_selected');
      ctx.jobs.transition(id, 'completed', 'clicked; page loaded'); // must be refused
    });
    const r = await settled(ctx, id);
    expect(r.status).toBe('outcome_unknown');
    expect(r.error).toMatch(/completed requires an observed confirmation/);
    const id2 = ctx.jobs.create('portal_upload', { artifactId: 'b' });
    ctx.jobs.start(id2, async () => {
      ctx.jobs.markSubmitted(id2, 'file_selected');
      ctx.jobs.setStep(id2, 'confirmation_observed', { matched: true });
      ctx.jobs.transition(id2, 'completed', 'confirmed', { outcome: 'confirmed' });
    });
    expect((await settled(ctx, id2)).status).toBe('completed');
    expect(ctx.jobs.view(id2).safeToRetry).toMatchObject({ safe: false });
  });

  it('maps workflow errors without losing what may have been sent', async () => {
    const ctx = ctxWith();
    const run = async (fn: (id: string) => Promise<void>) => {
      const id = ctx.jobs.create('register', {});
      ctx.jobs.start(id, () => fn(id));
      return settled(ctx, id);
    };
    // failure before any side effect: failed, nothing sent, safe to retry
    const a = await run(async () => {
      throw new Error('navigation failed');
    });
    expect([a.status, a.outcome]).toEqual(['failed', 'not_sent']);
    // failure after the submit marker: outcome unknown, never "failed"
    const b = await run(async (id) => {
      ctx.jobs.markSubmitted(id);
      throw new Error('socket hang up');
    });
    expect([b.status, b.outcome]).toEqual(['outcome_unknown', 'outcome_unknown']);
    // a known rejection after submit stays a failure with outcome rejected
    const c = await run(async (id) => {
      ctx.jobs.markSubmitted(id);
      ctx.jobs.setOutcome(id, 'rejected');
      throw new Error('site rejected the signup');
    });
    expect([c.status, c.outcome]).toEqual(['failed', 'rejected']);
    const d = await run(async () => {
      throw new JobBlocked('captcha');
    });
    expect([d.status, d.outcome]).toEqual(['blocked', 'not_sent']);
    const e = await run(async () => {
      throw new OutcomeUnknown('inbox wait timed out');
    });
    expect(e.status).toBe('outcome_unknown');
  });
});

describe('cancel races completion', () => {
  it('completion first: the cancel reports already_terminal and changes nothing', async () => {
    const ctx = ctxWith();
    const id = ctx.jobs.create('crawl', {});
    ctx.jobs.start(id, async () => ctx.jobs.transition(id, 'completed', 'done'));
    await settled(ctx, id);
    const c = ctx.jobs.cancel(id);
    expect(c.effect).toBe('already_terminal');
    expect(ctx.jobs.row(id).status).toBe('completed');
  });

  it('cancel first: a late completion cannot overwrite it; the outcome stays unknown after a submit', async () => {
    const ctx = ctxWith();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const id = ctx.jobs.create('portal_upload', { artifactId: 'x' });
    ctx.jobs.start(id, async (signal) => {
      ctx.jobs.markSubmitted(id, 'file_selected');
      await gate;
      ctx.jobs.assertNotCancelled(id, signal); // workflows check right before finishing
      ctx.jobs.transition(id, 'completed', 'confirmed', { outcome: 'confirmed' });
    });
    await new Promise((r) => setTimeout(r, 20));
    const c = ctx.jobs.cancel(id);
    expect(c.effect).toBe('cancel_requested');
    expect(c.sideEffectsPossible).toBe(true);
    release();
    const r = await settled(ctx, id);
    expect([r.status, r.outcome]).toEqual(['cancelled', 'outcome_unknown']);
    // the first terminal write wins; later writes are refused
    expect(ctx.jobs.finish(id, 'completed', { message: 'late', outcome: 'confirmed' })).toBe(false);
    expect(() => ctx.jobs.transition(id, 'completed', 'late', { outcome: 'confirmed' })).toThrow(/already cancelled/);
    expect(ctx.jobs.row(id).status).toBe('cancelled');
  });

  it('a cancelled job whose side effect was sent says so', async () => {
    const ctx = ctxWith();
    const id = ctx.jobs.create('register', {});
    ctx.jobs.start(id, async (signal) => {
      ctx.jobs.markSubmitted(id);
      await new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
    });
    await new Promise((r) => setTimeout(r, 50));
    ctx.jobs.cancel(id);
    const r = await settled(ctx, id);
    expect([r.status, r.outcome]).toEqual(['cancelled', 'outcome_unknown']);
    expect(r.error).toMatch(/may have taken effect/);
    expect(ctx.jobs.view(id).sideEffectsPossible).toBe(true);
  });
});

describe('duplicate invocation (idempotency)', () => {
  it('a caller key returns the existing job; derived keys are enforced across processes', () => {
    const cfg = testConfig();
    const p1 = ctxWith({ cfg });
    const p2 = buildContext({ cfg, provider: null, localProvider: null, mail: null }); // second process, same data dir
    try {
      const a = p1.jobs.createIdempotent('register', { targetOrigin: 'https://t.test' }, {}, 'my-key-123');
      const b = p2.jobs.createIdempotent('register', { targetOrigin: 'https://t.test' }, {}, 'my-key-123');
      expect(b).toEqual({ jobId: a.jobId, deduplicated: true });
      // portal: the same bytes to the same target, without allowRepeat -> one job only
      const j1 = p1.jobs.create('portal_upload', { dedupeKey: 'k1' });
      expect(() => p2.jobs.create('portal_upload', { dedupeKey: 'k1' })).toThrow(/already sent \(or may have been sent\)/);
      expect(p2.jobs.create('portal_upload', { dedupeKey: 'k1', allowRepeat: true })).toBeTruthy();
      // nothing was sent: the key is released, a retry is allowed
      p1.jobs.finish(j1, 'failed', { message: 'navigation failed' });
      const j2 = p2.jobs.create('portal_upload', { dedupeKey: 'k1' });
      // possibly sent: the key is kept after the job ends
      p2.jobs.markSubmitted(j2, 'file_selected');
      p2.jobs.finish(j2, 'outcome_unknown', { message: 'timeout' });
      expect(() => p1.jobs.create('portal_upload', { dedupeKey: 'k1' })).toThrow(/already sent/);
      // register on an account: one ACTIVE job; released when it ends (resume is allowed)
      const r1 = p1.jobs.create('register', {}, { accountId: 'acct_1' });
      expect(() => p2.jobs.create('register', {}, { accountId: 'acct_1' })).toThrow(/still active/);
      p1.jobs.markSubmitted(r1);
      p1.jobs.finish(r1, 'outcome_unknown', { message: 'timeout' });
      expect(p2.jobs.create('register', {}, { accountId: 'acct_1' })).toBeTruthy();
    } finally {
      p2.db.close();
    }
  });

  it('account_register with an idempotencyKey returns the first job (MCP handler)', async () => {
    const ctx = ctxWith();
    const tool = TOOLS.find((t) => t.name === 'account_register')!;
    const prior = ctx.jobs.createIdempotent('register', {}, {}, 'signup-once-1').jobId;
    const r = await tool.handler(ctx, { idempotencyKey: 'signup-once-1', targetOrigin: 'https://nowhere.test', signupUrl: 'https://nowhere.test/s', fields: [], submitSelector: '#x' });
    expect(r.data).toMatchObject({ jobId: prior, deduplicated: true });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM jobs')!.n).toBe(1);
  });
});

describe('orphan detection and recovery', () => {
  it('heartbeat, dead pid and pid reuse decide ownership; only one process claims an orphan', () => {
    const cfg = testConfig();
    const p1 = ctxWith({ cfg });
    const p2 = buildContext({ cfg, provider: null, localProvider: null, mail: null });
    try {
      const fresh = p1.jobs.create('crawl', {});
      p1.db.run('UPDATE jobs SET status = ?, owner_instance = ?, owner_pid = ?, heartbeat_at = ? WHERE id = ?', 'running', `${process.ppid}:otherproc0000`, process.ppid, Date.now(), fresh);
      expect(p1.jobs.orphans().map((j) => j.id)).not.toContain(fresh); // alive owner with a fresh heartbeat
      p1.db.run('UPDATE jobs SET heartbeat_at = ? WHERE id = ?', Date.now() - HEARTBEAT.staleMs - 1000, fresh);
      expect(p1.jobs.orphans().map((j) => j.id)).toContain(fresh); // stale heartbeat (hung or pid reused)
      const dead = p1.jobs.create('crawl', {});
      orphan(p1, dead, { status: 'running' });
      const row = p1.jobs.row(dead);
      expect(p1.jobs.claim(dead, row)).toBe(true);
      expect(p2.jobs.claim(dead, row)).toBe(false); // compare-and-set: the second claim loses
      expect(p1.jobs.row(dead).owner_instance).toBe(INSTANCE);
    } finally {
      p2.db.close();
    }
  });

  it('worker/orchestrator dies before submit: interrupted, nothing sent, safe to retry', async () => {
    const ctx = ctxWith();
    const id = ctx.jobs.create('portal_upload', { artifactId: 'a', dedupeKey: 'kk' });
    ctx.jobs.setStep(id, 'session_ready', { sessionId: 'sess_x' });
    orphan(ctx, id, { status: 'running' });
    expect(await recoverJobs(ctx)).toEqual([id]);
    const v = ctx.jobs.view(id) as any;
    expect([v.status, v.outcome, v.step]).toEqual(['interrupted', 'not_sent', 'session_ready']);
    expect(v.safeToRetry.safe).toBe(true);
    expect(v.steps.some((s: any) => s.evidence?.interrupted)).toBe(true); // diagnostics persisted
    expect(() => ctx.jobs.create('portal_upload', { dedupeKey: 'kk' })).not.toThrow(); // key released
  });

  it('dies after the file was selected: outcome_unknown, lock released, repeat refused', async () => {
    const ctx = ctxWith();
    ctx.db.run(`INSERT INTO files (id, display_name, format, mime, origin, size, sha256, rel_path, status, locked_by, lock_expires, created_at) VALUES ('art_1', 'a.png', 'png', 'image/png', 'imported', 1, 'x', 'a', 'ready', NULL, NULL, ?)`, nowIso());
    const id = ctx.jobs.create('portal_upload', { artifactId: 'art_1', dedupeKey: 'k2' });
    ctx.db.run(`UPDATE files SET locked_by = ?, lock_expires = ? WHERE id = 'art_1'`, id, Date.now() + 60_000);
    ctx.jobs.markSubmitted(id, 'file_selected');
    orphan(ctx, id, { status: 'running' });
    await recoverJobs(ctx);
    const v = ctx.jobs.view(id) as any;
    expect([v.status, v.outcome]).toEqual(['outcome_unknown', 'outcome_unknown']);
    expect(v.error).toMatch(/OUTCOME UNKNOWN/);
    expect(v.nextAction).toMatch(/Check the portal/);
    expect(ctx.db.get<{ locked_by: string | null }>(`SELECT locked_by FROM files WHERE id = 'art_1'`)!.locked_by).toBeNull();
    expect(() => ctx.jobs.create('portal_upload', { dedupeKey: 'k2' })).toThrow(/already sent/);
  });

  it('register interrupted while waiting for email: account unknown, resume advice, no resubmit', async () => {
    const ctx = ctxWith();
    const acct = ctx.accounts.create({ targetOrigin: 'https://t.test', proxyMode: 'direct', status: 'awaiting_verification' });
    const id = ctx.jobs.create('register', { targetOrigin: 'https://t.test' }, { accountId: acct.id });
    ctx.jobs.markSubmitted(id);
    ctx.jobs.setStep(id, 'verification_pending', { inbox: 'x' });
    orphan(ctx, id, { status: 'awaiting_email' });
    await recoverJobs(ctx);
    const v = ctx.jobs.view(id) as any;
    expect(v.status).toBe('outcome_unknown');
    expect(v.nextAction).toMatch(new RegExp(`accountId=${acct.id}`));
    expect(ctx.accounts.row(acct.id).status).toBe('unknown');
  });

  it('job_status and job_cancel keep working for jobs of an ended process', async () => {
    const ctx = ctxWith();
    const id = ctx.jobs.create('register', {});
    ctx.jobs.markSubmitted(id);
    orphan(ctx, id, { status: 'running' });
    const status = await TOOLS.find((t) => t.name === 'job_status')!.handler(ctx, { jobId: id });
    expect((status.data as any).status).toBe('running');
    const c = await TOOLS.find((t) => t.name === 'job_cancel')!.handler(ctx, { jobId: id });
    expect(c.data).toMatchObject({ status: 'cancelled', outcome: 'outcome_unknown', cancel: { effect: 'cancelled', sideEffectsPossible: true } });
  });
});

describe('provider cleanup queue', () => {
  it('an abort that fails is retried with backoff, reported as pending, then the lease is released', async () => {
    const provider = flakyProvider(3);
    const ctx = ctxWith({ provider });
    const acct = ctx.accounts.create({ targetOrigin: 'https://t.test', proxyMode: 'direct', status: 'active' });
    const lease = ctx.accounts.acquire(acct.id, 'session:sess_1', 300);
    provider.running.add('run_1');
    ctx.db.run(
      `INSERT INTO sessions (id, provider, provider_run_id, account_id, lease_id, proxy_mode, execution_mode, status, memory_mb, max_minutes, created_at) VALUES ('sess_1', 'apify', 'run_1', ?, ?, 'direct', 'remote_direct', 'ready', 1024, 30, ?)`,
      acct.id,
      lease.leaseId,
      nowIso(),
    );
    const job = ctx.jobs.create('crawl', {}, { sessionId: 'sess_1' });
    ctx.jobs.finish(job, 'failed', { message: 'x' });
    // close: abort fails, the run is still running -> session stays closing, lease kept, cleanup queued
    const closed = await ctx.sessions.close('sess_1');
    expect(closed.status).toBe('closing');
    expect(ctx.accounts.leaseFor(acct.id)).toBeTruthy();
    expect(pendingCleanup(ctx, { sessionId: 'sess_1' })).toMatchObject([{ kind: 'apify_run', ref: 'run_1' }]);
    expect((ctx.jobs.view(job) as any).pendingCleanup).toHaveLength(1);
    // first retry is due at once and fails; the next one waits for its backoff
    expect(await drainCleanup(ctx)).toMatchObject({ done: 0, failed: 1, pending: 1 });
    expect(await drainCleanup(ctx)).toMatchObject({ done: 0, failed: 0, pending: 1 });
    const d1 = await drainCleanup(ctx, { force: true });
    expect(d1).toMatchObject({ done: 0, failed: 1, pending: 1 });
    const row = ctx.db.get<{ attempts: number; last_error: string; next_attempt_at: string }>(`SELECT attempts, last_error, next_attempt_at FROM cleanup_queue WHERE ref = 'run_1'`)!;
    expect(row.attempts).toBe(2);
    expect(row.last_error).toMatch(/simulated/);
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(Date.now());
    const d2 = await drainCleanup(ctx, { force: true });
    expect(d2).toMatchObject({ done: 1, pending: 0 });
    expect(ctx.sessions.row('sess_1').status).toBe('closed');
    expect(ctx.accounts.leaseFor(acct.id)).toBeUndefined();
    expect(pendingCleanup(ctx, { sessionId: 'sess_1' })).toEqual([]);
  });

  it('account_delete removes the local record only; a failed inbox delete stays queued and is retried', async () => {
    let failures = 1;
    const deleted: string[] = [];
    const mail = {
      async deleteInbox(id: string) {
        if (failures-- > 0) throw new Error('MailSlurp DELETE /inboxes failed: 503');
        deleted.push(id);
      },
    };
    const ctx = ctxWith({ mail });
    const acct = ctx.accounts.create({ targetOrigin: 'https://t.test', proxyMode: 'direct', status: 'active', inboxId: 'inbox_1', email: 'a@x.test' });
    const del = TOOLS.find((t) => t.name === 'account_delete')!;
    const r = (await del.handler(ctx, { accountId: acct.id, confirmAccountId: acct.id, deleteInbox: true })).data as any;
    expect(r).toMatchObject({ localRecordDeleted: true, websiteAccount: 'not_deleted', inbox: 'cleanup_pending' });
    expect(r.note).toMatch(/still exists/);
    expect(r.pendingCleanup).toHaveLength(1);
    expect(() => ctx.accounts.row(acct.id)).toThrow(/not found/);
    expect((await drainCleanup(ctx, { force: true })).done).toBe(1);
    expect(deleted).toEqual(['inbox_1']);
    // without deleteInbox the inbox is reported as kept
    const b = ctx.accounts.create({ targetOrigin: 'https://t.test', proxyMode: 'direct', status: 'active', inboxId: 'inbox_2' });
    const r2 = (await del.handler(ctx, { accountId: b.id, confirmAccountId: b.id })).data as any;
    expect(r2).toMatchObject({ localRecordDeleted: true, websiteAccount: 'not_deleted', inbox: 'kept' });
  });

  it('account_delete refuses while a job is active for the account', async () => {
    const ctx = ctxWith();
    const acct = ctx.accounts.create({ targetOrigin: 'https://t.test', proxyMode: 'direct', status: 'active' });
    ctx.jobs.create('register', {}, { accountId: acct.id });
    const del = TOOLS.find((t) => t.name === 'account_delete')!;
    await expect(del.handler(ctx, { accountId: acct.id, confirmAccountId: acct.id })).rejects.toThrow(/still active/);
    expect(ctx.accounts.row(acct.id)).toBeTruthy();
  });

  it('enqueue is idempotent per resource', () => {
    const ctx = ctxWith();
    enqueueCleanup(ctx.db, { kind: 'mailslurp_inbox', ref: 'i1' });
    enqueueCleanup(ctx.db, { kind: 'mailslurp_inbox', ref: 'i1', error: 'again' });
    expect(pendingCleanup(ctx)).toHaveLength(1);
  });
});

describe('recovery gate', () => {
  it('mutating tools wait (bounded) for recovery; job_status never waits', async () => {
    const tools = [
      { name: 'session_start', handler: async () => 'started' },
      { name: 'job_status', handler: async () => 'status' },
    ];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    gateTools(tools, gate, 5_000);
    let started = false;
    const p = tools[0]!.handler().then((x) => {
      started = true;
      return x;
    });
    expect(await tools[1]!.handler()).toBe('status');
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toBe(false);
    open();
    expect(await p).toBe('started');
    // bounded: a gate that never opens delays by at most maxWaitMs
    const t2 = [{ name: 'portal_upload', handler: async () => 'ok' }];
    gateTools(t2, new Promise(() => undefined), 100);
    const t0 = Date.now();
    expect(await t2[0]!.handler()).toBe('ok');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
