import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { nowIso, SCHEMA } from '../../src/core/db.js';
import { currentVersion, migrate } from '../../src/core/migrations.js';
import { setPendingCleanupForTests } from '../../src/reports/store.js';
import { testCtx } from '../helpers/ctx.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => setPendingCleanupForTests(undefined));

function ctxWithSession(o: { provider: 'local' | 'apify'; mode: string; route?: unknown; status?: string; runId?: string; accountId?: string | null }) {
  const ctx = testCtx();
  dirs.push(join(ctx.cfg.dataDir, '..'));
  const id = `sess_${Math.random().toString(16).slice(2, 10)}`;
  ctx.db.run(
    `INSERT INTO sessions (id, provider, provider_run_id, account_id, proxy_mode, execution_mode, route_json, status, memory_mb, max_minutes, purpose, created_at, closed_at, token_blob)
     VALUES (?, ?, ?, ?, 'direct', ?, ?, ?, 2048, 10, 'interactive', ?, ?, ?)`,
    id,
    o.provider,
    o.runId ?? null,
    o.accountId ?? null,
    o.mode,
    o.route === undefined ? JSON.stringify({ proxy: null, source: 'explicit' }) : o.route === null ? null : JSON.stringify(o.route),
    o.status ?? 'closed',
    nowIso(),
    o.status === 'ready' ? null : nowIso(),
    // an encrypted token blob is present in the row; it must never reach a report
    'CANARY_TOKEN_BLOB_v1',
  );
  return { ctx, id };
}

describe('run reports', () => {
  it('local mode: informational route, no provider cost, run directory cleanup checked', async () => {
    const { ctx, id } = ctxWithSession({ provider: 'local', mode: 'local', runId: 'local:123:abcnonce' });
    mkdirSync(join(ctx.cfg.dataDir, 'local-runs', 'abcnonce'), { recursive: true });
    const r = (await ctx.reports.get({ sessionId: id })).report;
    expect(r).toMatchObject({ effectiveMode: 'local', requestedMode: 'local', runId: 'local:123:abcnonce' });
    expect(r.route.verification).toBe('not_checked');
    expect(r.route.limits.join(' ')).toMatch(/this computer's network/);
    expect(r.cost).toEqual({ estimatedUsd: 0, providerReportedUsd: null, basis: expect.stringMatching(/no provider charge/) });
    expect(r.cleanup.pending.join(' ')).toMatch(/local run directory .* still exists/);
    expect(JSON.stringify(r)).not.toContain('CANARY_TOKEN_BLOB');
  });

  it('a mode taken from the account is reported as not requested; the cleanup queue being absent is stated as uncertain', async () => {
    setPendingCleanupForTests(null);
    const { ctx, id } = ctxWithSession({ provider: 'apify', mode: 'remote_direct', route: { proxy: null, source: 'account' }, runId: 'run_abc' });
    const r = (await ctx.reports.get({ runId: 'run_abc' })).report;
    expect(r.requestedMode).toBeNull();
    expect(r.route.limits.join(' ')).toMatch(/account's stored mode/);
    expect(r.uncertain.join(' ')).toMatch(/Cleanup queue status is unknown/);
    expect(r.cost.providerReportedUsd).toBeNull();
    expect(r.cost.basis).toMatch(/planning estimate/);
    expect(id).toBeTruthy();
  });

  it('uses the cleanup queue when available, and separates estimate from provider-reported cost', async () => {
    setPendingCleanupForTests(async (_ctx, ref) => [`delete temporary inbox for ${ref.sessionId}`]);
    const { ctx, id } = ctxWithSession({ provider: 'apify', mode: 'remote_direct', runId: 'run_cost' });
    ctx.usage.record('apify_browser_run', 'run_cost', 0.1, 'compute_units', 0.042, 'provider_preliminary');
    const r = (await ctx.reports.get({ sessionId: id })).report;
    expect(r.cleanup.pending).toContain(`delete temporary inbox for ${id}`);
    expect(r.cost.providerReportedUsd).toBe(0.042);
    expect(r.cost.estimatedUsd).toBeGreaterThan(0);
    expect(r.uncertain.join(' ')).toMatch(/preliminary/);
  });

  it('finalize snapshots the report; reads refresh only cost and cleanup', async () => {
    setPendingCleanupForTests(async () => []);
    const { ctx, id } = ctxWithSession({ provider: 'apify', mode: 'remote_direct', runId: 'run_snap', status: 'ready' });
    const before = await ctx.reports.finalizeSession(id);
    expect(before.cleanup.pending.join(' ')).toMatch(/has not ended/);
    // later: session closed, provider figure reconciled, and the stored route edited (must NOT leak into the snapshot)
    ctx.db.run(`UPDATE sessions SET status = 'closed', closed_at = ?, execution_mode = 'remote_proxy' WHERE id = ?`, nowIso(), id);
    ctx.usage.record('apify_browser_run', 'run_snap', 0.2, 'compute_units', 0.05, 'provider_reconciled');
    const got = await ctx.reports.get({ sessionId: id });
    expect(got.source).toBe('finalized_snapshot');
    expect(got.report.effectiveMode).toBe('remote_direct');
    expect(got.report.cost.providerReportedUsd).toBe(0.05);
    expect(got.report.cleanup.pending).toEqual([]);
    expect(got.report.cleanup.done.join(' ')).toMatch(/closed/);
  });

  it('a job that never started a session has no run report', async () => {
    const ctx = testCtx();
    dirs.push(join(ctx.cfg.dataDir, '..'));
    const j = ctx.jobs.create('sanitize', { artifactId: 'file_x' });
    await expect(ctx.reports.get({ jobId: j })).rejects.toThrow(/started no browser session/);
    // finalizing at job completion is a no-op for such jobs (the lead wires it for every job)
    await expect(ctx.reports.finalizeJob(j)).resolves.toBeNull();
    await expect(ctx.reports.finalizeJob('job_missing')).resolves.toBeNull();
  });
});

describe('migration v5', () => {
  it('adopts a pre-v5 database without touching existing rows, and is idempotent', () => {
    const ctx = testCtx();
    dirs.push(join(ctx.cfg.dataDir, '..'));
    const file = join(ctx.cfg.dataDir, '..', 'legacy.sqlite');
    const sql = new DatabaseSync(file);
    sql.exec(SCHEMA);
    sql.exec(`INSERT INTO files (id, display_name, format, mime, origin, size, sha256, rel_path, status, policy, verdict, report_json, created_at)
              VALUES ('file_old', 'old.jpg', 'jpeg', 'image/jpeg', 'sanitized', 1, 'aa', 'file_old.jpg', 'ready', 'image_metadata', 'verified_for_policy', '{"verification":{"retainedFindings":[],"inspectionGaps":[]}}', '2025-01-01T00:00:00Z')`);
    migrate(sql);
    migrate(sql);
    expect(currentVersion(sql)).toBeGreaterThanOrEqual(5);
    const r = sql.prepare('SELECT report_json, policy_version, verification_id FROM files WHERE id = ?').get('file_old') as Record<string, unknown>;
    expect(r.report_json).toBe('{"verification":{"retainedFindings":[],"inspectionGaps":[]}}');
    expect(r.policy_version).toBeNull();
    expect(r.verification_id).toBeNull();
    for (const t of ['run_reports', 'file_acceptances']) expect(sql.prepare(`SELECT COUNT(*) n FROM ${t}`).get()).toEqual({ n: 0 });
    sql.close();
  });
});
