/**
 * Execution mode `local`: the real worker build runs as a child process of the
 * orchestrator (LocalProvider). No Apify provider is configured at all, so any
 * remote request would fail; the fixture site counts what reaches it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../src/core/context.js';
import { LocalProvider, parseLocalRunId } from '../../src/providers/local.js';
import { startFixtureSite, type FixtureSite } from '../fixtures/site.js';
import { testCtx } from '../helpers/ctx.js';

describe('local execution mode', () => {
  let site: FixtureSite;
  let ctx: Ctx;
  beforeAll(async () => {
    site = await startFixtureSite();
    ctx = testCtx({
      RBA_ALLOWED_ORIGINS: site.origin,
      RBA_ALLOW_PRIVATE_HOSTS: new URL(site.origin).host,
      RBA_MAX_CONCURRENT_SESSIONS: '2',
    });
  });
  afterAll(async () => {
    for (const id of ctx.sessions.ownedIds()) await ctx.sessions.close(id).catch(() => undefined);
    await site.close();
  });

  it('runs a session on this computer, reports the route honestly and cleans up', async () => {
    const s = await ctx.sessions.start({ mode: 'local', maxMinutes: 3 });
    expect(s.executionMode).toBe('local');
    expect(s.route).toMatchObject({ mode: 'local', provider: 'local', proxy: null, verification: 'not_checked' });
    expect(s.route.limits.join(' ')).toContain('not your personal browser profile');
    const row = ctx.db.get<{ provider: string; provider_run_id: string; container_url: string; execution_mode: string }>('SELECT * FROM sessions WHERE id = ?', s.sessionId)!;
    expect(row.provider).toBe('local');
    expect(row.execution_mode).toBe('local');
    expect(row.container_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const run = parseLocalRunId(row.provider_run_id)!;
    expect(run).not.toBeNull();

    // Worker process: minimal environment (no test-mode knobs, no plugin secrets), loopback bind.
    const env = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(run.pid)], { encoding: 'utf8' });
    expect(env).toContain('RBA_WORKER_BIND_HOST=127.0.0.1');
    expect(env).not.toContain('RBA_WORKER_TEST_MODE');
    expect(env).not.toContain('RBA_ENCRYPTION_KEY');
    expect(env).not.toContain('APIFY_TOKEN');

    const nav = await ctx.sessions.call<any>(s.sessionId, '/navigate', { url: site.url('/products') });
    expect(nav.page.url).toContain('/products');
    expect(site.state.requests).toContain('GET /products');

    // No provider bill is recorded for local runs.
    expect(ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM usage WHERE kind = 'apify_browser_run'`)!.n).toBe(0);

    const closed = await ctx.sessions.close(s.sessionId);
    expect(closed).toMatchObject({ status: 'closed', usage: { usd: 0, basis: 'local_no_provider_charge' } });
    // Process gone and its storage removed.
    for (let i = 0; i < 50 && existsSync(join(ctx.cfg.dataDir, 'local-runs', run.nonce)); i++) await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(run.pid, 0)).toThrow();
    expect(readdirSync(join(ctx.cfg.dataDir, 'local-runs'))).not.toContain(run.nonce);
  }, 90_000);

  it('local mode grants no private-network access beyond the explicit allowlist', async () => {
    const other = await startFixtureSite();
    const c2 = testCtx({ RBA_ALLOWED_ORIGINS: `${site.origin},${other.origin}`, RBA_ALLOW_PRIVATE_HOSTS: new URL(site.origin).host });
    const s = await c2.sessions.start({ mode: 'local', maxMinutes: 3 });
    try {
      await expect(c2.sessions.call(s.sessionId, '/navigate', { url: other.url('/products') })).rejects.toMatchObject({ code: 'navigation_blocked' });
      expect(other.state.requests).toHaveLength(0);
    } finally {
      await c2.sessions.close(s.sessionId);
      await other.close();
    }
  }, 90_000);

  it('sweeps run directories of dead workers but never those of live ones', async () => {
    const s = await ctx.sessions.start({ mode: 'local', maxMinutes: 3 });
    const live = parseLocalRunId(ctx.db.get<{ provider_run_id: string }>('SELECT provider_run_id FROM sessions WHERE id = ?', s.sessionId)!.provider_run_id)!;
    const runs = join(ctx.cfg.dataDir, 'local-runs');
    mkdirSync(join(runs, '0123456789abcdef', 'tmp'), { recursive: true });
    expect(readdirSync(join(runs, live.nonce))).toContain('tmp'); // private TMPDIR for the browser profile
    expect((ctx.providers.local as LocalProvider).sweepStale()).toBe(1);
    expect(readdirSync(runs).sort()).toEqual([live.nonce]);
    await ctx.sessions.close(s.sessionId);
  }, 90_000);

  it('an account bound to local mode refuses a remote session (no silent route switch)', async () => {
    const a = ctx.accounts.create({ targetOrigin: site.origin, proxyMode: 'direct', executionMode: 'local', status: 'active' });
    await expect(ctx.sessions.start({ accountId: a.id, mode: 'remote_direct' })).rejects.toThrow('bound to execution mode local');
  });

  it('records a 1920x1080 video of the session only when RBA_LOCAL_RECORD_VIDEO_DIR is set', async () => {
    const videos = join(ctx.cfg.dataDir, 'videos-test');
    const rec = testCtx({ RBA_ALLOWED_ORIGINS: site.origin, RBA_ALLOW_PRIVATE_HOSTS: new URL(site.origin).host, RBA_LOCAL_RECORD_VIDEO_DIR: videos });
    expect(rec.cfg.localRecordVideoDir).toBe(videos);
    const s = await rec.sessions.start({ mode: 'local', maxMinutes: 3 });
    const pid = parseLocalRunId(rec.db.get<{ provider_run_id: string }>('SELECT provider_run_id FROM sessions WHERE id = ?', s.sessionId)!.provider_run_id)!.pid;
    expect(execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })).toContain(`RBA_WORKER_RECORD_VIDEO_DIR=${videos}`);
    await rec.sessions.call<any>(s.sessionId, '/navigate', { url: site.url('/products') });
    await rec.sessions.close(s.sessionId);
    const files = readdirSync(videos).filter((f) => f.endsWith('.webm'));
    expect(files.length).toBeGreaterThan(0);
    expect(statSync(join(videos, files[0]!)).size).toBeGreaterThan(0);
    // Default (unset): no recording knob reaches the worker.
    expect(ctx.cfg.localRecordVideoDir).toBeNull();
  }, 90_000);
});
