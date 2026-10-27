import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDashboard, type DashboardHandle } from '../../src/dashboard/server.js';
import type { BrowserProvider } from '../../src/providers/types.js';
import { testCtx } from '../helpers/ctx.js';
import { Usage } from '../../src/core/usage.js';

function http(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

describe('dashboard security', () => {
  const ctx = testCtx({ RBA_AUTHORIZED_TARGETS: 'https://t.test' });
  let d: DashboardHandle;
  let port: number;
  let cookie = '';
  beforeAll(async () => {
    d = await startDashboard(ctx, 0);
    port = Number(new URL(d.url).port);
  });
  afterAll(() => d.close());

  it('binds to loopback only', () => {
    expect((d.server.address() as any).address).toBe('127.0.0.1');
  });
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    expect((await http(port, '/', { headers: { Host: `evil.test:${port}` } })).status).toBe(421);
  });
  it('requires auth and sets strict headers', async () => {
    const r = await http(port, '/accounts');
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/login');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('rejects cross-origin POST and wrong tokens; accepts the right token', async () => {
    const token = ctx.cfg.dashboard.token!;
    expect((await http(port, '/login', { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${token}` })).status).toBe(403);
    expect((await http(port, '/login', { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=wrong' })).status).toBe(401);
    const ok = await http(port, '/login', { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token)}` });
    expect(ok.status).toBe(303);
    cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
  });
  it('one-time login link works once', async () => {
    const path = new URL(d.oneTimeLoginUrl).pathname + new URL(d.oneTimeLoginUrl).search;
    expect((await http(port, path)).headers['set-cookie']).toBeDefined();
    expect((await http(port, path)).headers['set-cookie']).toBeUndefined();
  });
  it('escapes untrusted data and enforces CSRF on password form', async () => {
    const a = ctx.accounts.create({ targetOrigin: 'https://t.test', label: '<script>alert(1)</script>', email: '"><img src=x onerror=alert(1)>@x.test', proxyMode: 'direct', status: 'unknown' });
    const page = await http(port, `/accounts/${a.id}`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('<img src=x');
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    const post = (body: string) =>
      http(port, `/accounts/${a.id}/password`, { method: 'POST', headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    expect((await post('password=abc&csrf=bad')).status).toBe(403);
    expect((await post(`password=${encodeURIComponent('S3cret-dash-pw!')}&csrf=${encodeURIComponent(csrf)}`)).status).toBe(303);
    expect(ctx.accounts.getCredentials(a.id)!.password).toBe('S3cret-dash-pw!');
    const after = await http(port, `/accounts/${a.id}`, { headers: { Cookie: cookie } });
    expect(after.body).not.toContain('S3cret-dash-pw!');
  });
});

describe('budget controls', () => {
  const stub = (monthly: number, limit: number): BrowserProvider => ({
    name: 'stub',
    startRun: async () => {
      throw new Error('must not start');
    },
    getRun: async () => {
      throw new Error('n/a');
    },
    abortRun: async () => undefined,
    accountUsage: async () => ({ monthlyUsageUsd: monthly, monthlyLimitUsd: limit, cycleStart: null, cycleEnd: null }),
  });
  it('reserves the planning estimate for running sessions and the new one', async () => {
    const ctx = testCtx({ RBA_MONTHLY_BUDGET_USD: '1.1', RBA_APIFY_CU_PRICE_USD: '0.3', RBA_MAX_CONCURRENT_SESSIONS: '5' }, { provider: stub(0, 5) });
    // compute bounded by the run timeout: 2 GB x (20 + 1) min x $0.3/CU = $0.21
    expect(ctx.usage.sessionEstimate(2048, 20)).toMatchObject({ computeUsd: expect.closeTo(0.21, 5), residentialReserveUsd: 0 });
    expect((await ctx.usage.assertCanStart(2048, 20)).projectedUsd).toBeCloseTo(0.21, 5);
    // residential adds the bandwidth RESERVATION (default 0.02 GB x $8 = $0.16), not a cap
    expect(ctx.usage.sessionEstimate(2048, 20, 'residential').residentialReserveUsd).toBeCloseTo(0.16, 5);
    expect((await ctx.usage.assertCanStart(2048, 20, 'residential')).projectedUsd).toBeCloseTo(0.37, 5);
    ctx.usage.record('apify_browser_run', 'r-old', 2, 'compute_units', 0.7, 'provider_reconciled');
    ctx.db.run(`INSERT INTO sessions (id, provider, proxy_mode, status, memory_mb, max_minutes, created_at, provider_run_id) VALUES ('s1','stub','direct','ready',2048,20,?, 'r1')`, new Date().toISOString());
    // 0.7 used + 0.21 reserved + 0.21 new = 1.12 > 1.1
    await expect(ctx.usage.assertCanStart(2048, 20)).rejects.toMatchObject({ code: 'budget_exceeded' });
  });
  it('budget scope is the whole account cycle: max(account, plugin runs), never the sum', () => {
    const ctx = testCtx({ RBA_MONTHLY_BUDGET_USD: '1', RBA_APIFY_CU_PRICE_USD: '0.2', RBA_MAX_SESSION_MINUTES: '10' }, { provider: stub(0, 5) });
    const cycle = '2026-10-09T00:00:00.000Z';
    ctx.db.run(`INSERT INTO sessions (id, provider, proxy_mode, status, memory_mb, max_minutes, created_at, provider_run_id) VALUES ('a','stub','direct','closed',2048,10,'2026-10-10T00:00:00.000Z','ra')`);
    ctx.db.run(`INSERT INTO sessions (id, provider, proxy_mode, status, memory_mb, max_minutes, created_at, provider_run_id) VALUES ('b','stub','direct','closed',2048,10,'2026-10-01T00:00:00.000Z','rb')`);
    ctx.usage.record('apify_browser_run', 'ra', 1, 'compute_units', 0.3, 'provider_reconciled');
    ctx.usage.record('apify_browser_run', 'rb', 1, 'compute_units', 0.5, 'provider_reconciled'); // previous cycle
    expect(ctx.usage.runSpend(cycle).countedForBudgetUsd).toBeCloseTo(0.3, 6); // window = billing cycle
    // account 0.6 already includes plugin run ra (0.3): projected = 0.6 + estimate, not 0.9 + estimate
    const est = ctx.usage.sessionEstimate(2048, 10).totalUsd;
    expect(ctx.usage.assertBudget(2048, 10, 'direct', { usd: 0.6, cycleStart: cycle }).projectedUsd).toBeCloseTo(0.6 + est, 6);
    // account figure lagging behind plugin runs: local records count instead
    expect(ctx.usage.assertBudget(2048, 10, 'direct', { usd: 0.1, cycleStart: cycle }).projectedUsd).toBeCloseTo(0.3 + est, 6);
  });
  it('reconciled figures keep their timestamp and history, and are re-read later', async () => {
    let usd = 0.004;
    const prov = {
      ...stub(0, 5),
      getRun: async (id: string) => ({ runId: id, state: 'succeeded', statusMessage: null, usageUsd: usd, computeUnits: 0.02, residentialProxyGb: null, runtimeSecs: 30, preliminary: false, finishedAt: '2026-10-10T00:00:00.000Z' }),
    } as any;
    const ctx = testCtx({}, { provider: prov });
    ctx.db.run(`INSERT INTO sessions (id, provider, proxy_mode, status, memory_mb, max_minutes, created_at, provider_run_id) VALUES ('s','stub','direct','closed',2048,10,?, 'rx')`, new Date().toISOString());
    ctx.usage.recordRun(await prov.getRun('rx'), 2048, new Date().toISOString());
    const row = () => ctx.db.get<{ usd: number; basis: string; detail_json: string }>(`SELECT usd, basis, detail_json FROM usage WHERE ref = 'rx'`)!;
    expect(row().basis).toBe('provider_reconciled');
    expect(JSON.parse(row().detail_json).reconciledAt).toBeTruthy();
    // not due yet (re-read every 6 h)
    expect((await ctx.usage.reconcile('2000-01-01T00:00:00.000Z')).reread).toBe(0);
    // make it due; the provider now reports a higher figure
    const d = JSON.parse(row().detail_json);
    ctx.db.run(`UPDATE usage SET detail_json = ? WHERE ref = 'rx'`, JSON.stringify({ ...d, reconciledAt: new Date(Date.now() - 7 * 3600_000).toISOString() }));
    usd = 0.005;
    expect(await ctx.usage.reconcile('2000-01-01T00:00:00.000Z')).toEqual({ reread: 1, changed: 1 });
    expect(row().usd).toBeCloseTo(0.005, 9);
    expect(JSON.parse(row().detail_json).history[0]).toMatchObject({ usd: 0.004, basis: 'provider_reconciled' });
  });
  it('migrates old basis names', () => {
    const ctx = testCtx({}, { provider: stub(0, 5) });
    ctx.db.run(`INSERT INTO usage (ts, month, provider, kind, ref, quantity, unit, usd, basis) VALUES (?, '2026-10', 'apify', 'apify_browser_run', 'old1', 1, 'cu', 0.1, 'measured')`, new Date().toISOString());
    const fresh = new (ctx.usage.constructor as any)(ctx.db, ctx.cfg, null);
    void fresh;
    expect(ctx.db.get<{ basis: string }>(`SELECT basis FROM usage WHERE ref = 'old1'`)!.basis).toBe('provider_reconciled');
  });
  it('uses the provider figure when it is larger, and stops at the provider limit', async () => {
    const ctx = testCtx({ RBA_MONTHLY_BUDGET_USD: '4' }, { provider: stub(3.95, 5) });
    await expect(ctx.usage.assertCanStart(2048, 20)).rejects.toMatchObject({ code: 'budget_exceeded' });
    const ctx2 = testCtx({ RBA_MONTHLY_BUDGET_USD: '100' }, { provider: stub(5, 5) });
    await expect(ctx2.usage.assertCanStart(1024, 1)).rejects.toMatchObject({ code: 'quota_exhausted' });
  });
  it('enforces concurrency and MailSlurp quotas', async () => {
    const ctx = testCtx({ RBA_MAX_CONCURRENT_SESSIONS: '1', RBA_MAILSLURP_MAX_INBOXES_PER_MONTH: '1' }, { provider: stub(0, 5) });
    ctx.db.run(`INSERT INTO sessions (id, provider, proxy_mode, status, memory_mb, max_minutes, created_at) VALUES ('s1','stub','direct','ready',1024,5,?)`, new Date().toISOString());
    await expect(ctx.usage.assertCanStart(1024, 1)).rejects.toMatchObject({ code: 'concurrency_limit' });
    ctx.usage.assertInboxQuota();
    ctx.usage.record('mailslurp_inbox_created', 'i1', 1, 'inbox', null, 'counted');
    expect(() => ctx.usage.assertInboxQuota()).toThrow(/local inbox-creation cap/);
  });
  it('email quota counts unique messages atomically; re-reads never count again', () => {
    const ctx = testCtx({ RBA_MAILSLURP_MAX_EMAILS_PER_MONTH: '2' }, { provider: stub(0, 5) });
    ctx.usage.admitEmail('m1');
    ctx.usage.admitEmail('m1'); // same message read again (email_search after email_wait)
    ctx.usage.admitEmail('m2');
    expect(ctx.usage.count('mailslurp_email_received')).toBe(2);
    ctx.usage.admitEmail('m2'); // already counted: still readable at the cap
    try {
      ctx.usage.admitEmail('m3');
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('quota_exhausted');
      expect(e.details).toMatchObject({ source: 'local', variable: 'RBA_MAILSLURP_MAX_EMAILS_PER_MONTH' });
    }
    expect(ctx.usage.count('mailslurp_email_received')).toBe(2);
  });
  it('inbox creations are reserved before the provider call and released on failure', () => {
    const ctx = testCtx({ RBA_MAILSLURP_MAX_INBOXES_PER_MONTH: '2' }, { provider: stub(0, 5) });
    const a = ctx.usage.reserveInbox();
    const b = ctx.usage.reserveInbox();
    expect(() => ctx.usage.reserveInbox()).toThrow(/local inbox-creation cap/); // both slots taken while in flight
    ctx.usage.settleInbox(a, 'inbox-a');
    ctx.usage.settleInbox(b, null); // provider call failed
    expect(ctx.usage.count('mailslurp_inbox_created')).toBe(1);
    expect(ctx.db.get('SELECT 1 FROM usage WHERE ref = ?', 'inbox-a')).toBeTruthy();
    ctx.usage.reserveInbox(); // freed slot is usable
  });
  it('stale reservations: provider inbox found -> deleted and still counted; none -> released; unknown -> kept', async () => {
    const ctx = testCtx({ RBA_MAILSLURP_MAX_INBOXES_PER_MONTH: '10' }, { provider: stub(0, 5) });
    const crashedAfterCreate = ctx.usage.reserveInbox();
    const crashedBeforeCreate = ctx.usage.reserveInbox();
    const providerDown = ctx.usage.reserveInbox();
    ctx.db.run(`UPDATE usage SET ts = ? WHERE ref LIKE 'reserved:%'`, new Date(Date.now() - 11 * 60_000).toISOString());
    const deleted: string[] = [];
    const mail = {
      findInboxesByTag: async (tag: string) => {
        if (tag === Usage.reservationTag(providerDown)) throw new Error('unreachable');
        return tag === Usage.reservationTag(crashedAfterCreate) ? [{ id: 'inbox-orphan' }] : [];
      },
      deleteInbox: async (id: string) => void deleted.push(id),
    };
    expect(await ctx.usage.recoverInboxReservations(mail)).toEqual({ released: 1, orphansDeleted: 1, orphansKept: 0, deferred: 1 });
    expect(deleted).toEqual(['inbox-orphan']); // the provider-side inbox is not forgotten
    expect(ctx.db.get<{ detail_json: string }>(`SELECT detail_json FROM usage WHERE ref = 'inbox-orphan'`)!.detail_json).toContain('"providerInboxDeleted":true');
    expect(ctx.db.get(`SELECT 1 FROM usage WHERE ref = ?`, crashedBeforeCreate)).toBeUndefined();
    expect(ctx.db.get(`SELECT 1 FROM usage WHERE ref = ?`, providerDown)).toBeTruthy(); // retried next sweep
    expect(ctx.usage.count('mailslurp_inbox_created')).toBe(2);
    // without a MailSlurp client nothing is released
    expect((await ctx.usage.recoverInboxReservations(null)).deferred).toBe(1);
  });
  it('preliminary run figures count at max(preliminary, local estimate) for the budget', () => {
    const ctx = testCtx({ RBA_APIFY_CU_PRICE_USD: '0.3' }, { provider: stub(0, 5) });
    ctx.db.run(`INSERT INTO sessions (id, provider, proxy_mode, status, memory_mb, max_minutes, created_at, provider_run_id) VALUES ('s9','stub','direct','closed',2048,10,?, 'r9')`, new Date().toISOString());
    // preliminary $0.00007 for 60 s at 2 GB; estimate = 2 x (60/3600) x 0.3 = $0.01
    ctx.usage.record('apify_browser_run', 'r9', 0.0003, 'compute_units', 0.00007, 'provider_preliminary', { runtimeSecs: 60 });
    ctx.usage.record('apify_browser_run', 'r8', 0.01, 'compute_units', 0.02, 'provider_reconciled', { runtimeSecs: 30 });
    const s = ctx.usage.runSpend('2000-01-01T00:00:00.000Z');
    expect(s.reconciledUsd).toBeCloseTo(0.02, 6);
    expect(s.preliminaryReportedUsd).toBeCloseTo(0.00007, 6);
    expect(s.preliminaryCountedForBudgetUsd).toBeCloseTo(0.01, 6);
    expect(s.countedForBudgetUsd).toBeCloseTo(0.03, 6);
  });
});
