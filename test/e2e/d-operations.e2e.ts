/**
 * Scenario D: learn a read operation -> review -> call it with an input it never
 * saw -> validate the output shape. Through the built MCP server over stdio.
 * Proof level: local fixture (operations fixture site; remote modes via the fake
 * Apify, remote_proxy through the local test proxy).
 *
 * remote_proxy: "no orchestrator -> target connection" is proven by socket
 * ownership. Only the test proxy (in THIS test process) may open connections to
 * the target; the test records the local port of every socket the proxy opens,
 * and every request the target receives must arrive from one of those ports. A
 * request from the MCP server process or a worker going direct would come from
 * a port outside that set.
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOperationsSite, type OpsSite } from '../fixtures/operations-site.js';
import { startTestProxy } from '../fixtures/proxy.js';
import { leftoverLocalRuns, liveFakeRuns, navigate, reportKnownDefects, startE2E, type E2E } from './stdio-harness.js';

type Proxy = Awaited<ReturnType<typeof startTestProxy>>;
const json = (v: unknown) => JSON.stringify(v);

describe('D: operations are disabled by default', () => {
  it('tools are listed but answer config_missing without RBA_OPERATIONS_ENABLED', async () => {
    const h = await startE2E();
    try {
      const names = (await h.mcp.listTools()).tools.map((t) => t.name);
      for (const n of ['operation_learn', 'operation_review', 'operation_call', 'operation_validate', 'operation_list', 'operation_delete']) expect(names).toContain(n);
      const r = await h.call('operation_list', {});
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe('config_missing');
    } finally {
      await h.close();
    }
  });
});

describe('D: saved operations are private by default (account ids never leave the vault)', () => {
  let site: OpsSite;
  let h: E2E;
  beforeAll(async () => {
    site = await startOperationsSite();
    site.addUser('alice');
    site.addUser('bob');
    h = await startE2E({ extraOrigins: [site.origin], vars: { RBA_OPERATIONS_ENABLED: 'true', RBA_MAX_CONCURRENT_SESSIONS: '3' } });
  });
  afterAll(async () => {
    await h?.close();
    await site?.close();
  });

  async function signedInAccount(user: string): Promise<string> {
    const prof = site.state.profiles.get(user)!;
    const add = await h.call('account_add', { targetOrigin: site.origin, email: prof.email, label: user, mode: 'local' });
    expect(add.isError, add.raw).toBe(false);
    const id = add.data.account.accountId as string;
    const s = await h.call('session_start', { accountId: id, mode: 'local' });
    expect(s.isError, s.raw).toBe(false);
    const nav = await navigate(h, s.data.sessionId, `${site.origin}/login-as?user=${user}`);
    expect(nav.isError, nav.raw).toBe(false);
    expect((await h.call('session_close', { sessionId: s.data.sessionId, saveState: true })).isError).toBe(false);
    return id;
  }

  it('local: account id/email are encrypted account constants; list, errors, reports and logs never show them; B and no-account are refused; public with an email literal is refused', async () => {
    const A = site.state.profiles.get('alice')!;
    const forms = [A.uid, A.email, encodeURIComponent(A.email)];
    const clean = (s: string, what: string) => {
      for (const f of forms) expect(s, `${what} contains ${f}`).not.toContain(f);
    };
    const alice = await signedInAccount('alice');
    const bob = await signedInAccount('bob');

    const learn = await h.call('operation_learn', { accountId: alice, name: 'my_orders', trigger: { url: `${site.origin}/me/orders?status={status}` }, examples: [{ status: 'open' }, { status: 'closed' }], readOnly: true });
    expect(learn.isError, learn.raw).toBe(false);
    clean(learn.raw, 'operation_learn output');
    expect(learn.data.privacy).toMatchObject({ exportable: false, boundTo: { accountId: alice, origin: site.origin } });
    const opId = learn.data.operationId as string;
    clean(json(h.q('SELECT * FROM operations WHERE id = ?', opId)), 'stored operation row');
    expect((await h.call('operation_review', { operationId: opId, specSha256: learn.data.specSha256, confirmReadOnly: true })).data.status).toBe('reviewed');

    const before = site.state.requests.length;
    const c = await h.call('operation_call', { operationId: opId, args: { status: 'shipped' } });
    expect(c.isError, c.raw).toBe(false);
    expect(c.data).toMatchObject({ ok: true, mode: 'local' });
    expect(json(c.data.untrusted.data)).toContain('alice-shipped-1');
    expect(site.state.requests.slice(before).some((x) => x.path === `/api/users/${A.uid}/orders`)).toBe(true);

    // Account identifiers are redacted in operation outputs only: account_list still shows the email.
    const accounts = await h.call('account_list', {});
    expect(accounts.isError, accounts.raw).toBe(false);
    expect(accounts.raw).toContain(A.email);

    const list = await h.call('operation_list', { includeSpec: true });
    clean(list.raw, 'operation_list includeSpec');
    const mine = list.data.operations.find((o: { operationId: string }) => o.operationId === opId);
    expect(mine.spec.exportable).toBe(false);
    expect(json(mine.spec)).not.toContain('"request"');

    // Account B's session and an account-less session are refused, before anything is sent.
    const sb = await h.call('session_start', { accountId: bob, mode: 'local' });
    const sn = await h.call('session_start', { mode: 'local' });
    const n = site.state.requests.length;
    for (const sid of [sb.data.sessionId, sn.data.sessionId]) {
      const r = await h.call('operation_call', { operationId: opId, args: { status: 'open' }, sessionId: sid });
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe('forbidden');
      clean(r.raw, 'refusal');
    }
    expect(site.state.requests.length).toBe(n);

    // Public learn whose request carries an email literal is refused without echoing it.
    const pub = await h.call('operation_learn', { public: true, mode: 'local', sessionId: sn.data.sessionId, name: 'newsletter', trigger: { url: `${site.origin}/newsletter?topic={topic}` }, examples: [{ topic: 'sqlite' }, { topic: 'postgres' }], readOnly: true });
    expect(pub.isError).toBe(true);
    expect(pub.data.error.code).toBe('forbidden');
    expect(pub.raw).not.toContain(site.state.newsletterSubscriber);
    for (const sid of [sb.data.sessionId, sn.data.sessionId]) await h.call('session_close', { sessionId: sid });

    // Run reports of every session, and the server log.
    for (const { id } of h.q<{ id: string }>('SELECT id FROM sessions')) clean((await h.call('run_report', { sessionId: id })).raw, `run_report ${id}`);
    expect((await h.call('operation_delete', { operationId: opId })).isError).toBe(false);
    expect(await h.stopServer()).toBe(0);
    clean(h.stderr(), 'server stderr');
    expect(leftoverLocalRuns(h.dataDir)).toEqual([]);
  });
});

describe('D: learned read operation generalises to an unseen input', () => {
  let site: OpsSite;
  let proxy: Proxy;
  let h: E2E;
  const proxyLocalPorts = new Set<number>();
  const orig = net.Socket.prototype.connect;

  beforeAll(async () => {
    site = await startOperationsSite();
    proxy = await startTestProxy({ egressIp: '203.0.113.7' });
    // Record the local port of every socket the test proxy opens (it is the only legitimate path to the target in remote_proxy).
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      if ((new Error().stack ?? '').includes('fixtures/proxy.ts')) this.once('connect', () => this.localPort && proxyLocalPorts.add(this.localPort));
      return (orig as (...x: unknown[]) => net.Socket).apply(this, args);
    } as typeof orig;
    h = await startE2E({ proxyUrl: proxy.url, extraOrigins: [site.origin], vars: { RBA_OPERATIONS_ENABLED: 'true', RBA_MAX_CONCURRENT_SESSIONS: '3' } });
  });
  afterAll(async () => {
    net.Socket.prototype.connect = orig;
    reportKnownDefects('d-operations');
    await h?.close();
    await proxy?.close();
    await site?.close();
  });

  const routes = {
    local: { mode: 'local' },
    remote_direct: { mode: 'remote_direct' },
    remote_proxy: { mode: 'remote_proxy', proxy: { kind: 'datacenter' } },
  } as const;

  for (const [mode, route] of Object.entries(routes)) {
    it(`${mode}: learn on two examples, review, call with an unseen input, validate`, async () => {
      const reqBefore = site.state.requests.length;
      const learn = await h.call('operation_learn', {
        name: `search_${mode}`,
        public: true,
        ...route,
        trigger: { url: `${site.origin}/search?q={query}` },
        examples: [{ query: 'sqlite' }, { query: 'postgres' }],
        readOnly: true,
      });
      expect(learn.isError, learn.raw).toBe(false);
      const L = learn.data;
      expect(L.status).toBe('draft');
      expect(L.learnedIn.mode).toBe(mode);
      expect(L.review).toMatchObject({ method: 'GET', path: '/api/search', bodyPresent: false });
      expect(L.review.params.map((p: { name: string }) => p.name)).toEqual(['query']);
      expect(json(L.untrusted.preview)).toContain('Result 1 for sqlite');

      // A draft cannot be called; a wrong spec hash cannot be reviewed.
      const early = await h.call('operation_call', { operationId: L.operationId, args: { query: 'duck db' } });
      expect(early.isError).toBe(true);
      expect(early.data.error.code).toBe('conflict');
      const badReview = await h.call('operation_review', { operationId: L.operationId, specSha256: '0'.repeat(64), confirmReadOnly: true });
      expect(badReview.isError).toBe(true);
      const rev = await h.call('operation_review', { operationId: L.operationId, specSha256: L.specSha256, confirmReadOnly: true });
      expect(rev.data.status).toBe('reviewed');

      // The learn step never saw this input.
      expect(site.state.requests.slice(reqBefore).some((x) => x.query.includes('duck'))).toBe(false);
      const callBefore = site.state.requests.length;
      const c = await h.call('operation_call', { operationId: L.operationId, args: { query: 'duck db' }, ...route });
      expect(c.isError, c.raw).toBe(false);
      expect(c.data).toMatchObject({ ok: true, class: 'ok', mode });
      const data = c.data.untrusted.data;
      expect(json(data)).toContain('Result 1 for duck db');
      expect(json(data)).toContain('duck-db-3');
      expect(json(data)).not.toMatch(/sqlite|postgres/);
      const seen = site.state.requests.slice(callBefore);
      expect(seen.some((x) => x.path === '/api/search' && x.query.includes('q=duck%20db'))).toBe(true);

      // Validation: refused with a learning example, valid with another unseen input.
      const sameAsExample = await h.call('operation_validate', { operationId: L.operationId, args: { query: 'SQLite' }, ...route });
      expect(sameAsExample.isError).toBe(true);
      expect(sameAsExample.data.error.code).toBe('invalid_input');
      const v = await h.call('operation_validate', { operationId: L.operationId, args: { query: 'mysql' }, ...route });
      expect(v.isError, v.raw).toBe(false);
      expect(v.data).toMatchObject({ ok: true, valid: true });

      // Input errors are refused before anything is sent.
      const n = site.state.requests.length;
      const bad = await h.call('operation_call', { operationId: L.operationId, args: { query: 'x', other: 'y' }, ...route });
      expect(bad.data).toMatchObject({ ok: false, class: 'input', sent: false });
      expect(site.state.requests.length).toBe(n);

      // Examples are not exported in the stored spec.
      const list = await h.call('operation_list', { includeSpec: true });
      const mine = list.data.operations.find((o: { operationId?: string; id?: string }) => (o.operationId ?? o.id) === L.operationId);
      expect(mine).toBeTruthy();
      expect(json(mine)).not.toMatch(/sqlite|postgres/);

      if (mode === 'remote_proxy') proxyOpId = L.operationId;
      if (mode === 'remote_proxy') {
        const reqs = site.state.requests.slice(reqBefore);
        expect(reqs.length).toBeGreaterThan(0);
        expect(proxyLocalPorts.size).toBeGreaterThan(0);
        // Every request the target received in this scenario came over a socket opened by the proxy:
        // none from the MCP server (orchestrator) and none from a worker going direct.
        expect(reqs.filter((x) => !proxyLocalPorts.has(Number(x.remotePort)))).toEqual([]);
        expect(proxy.requests.some((x) => x.includes(new URL(site.origin).host))).toBe(true);
      }
    });
  }

  // Regression for OPS-PROXY-KIND (found by this suite on 4a75bb6): the learned proxy kind is stored with the
  // operation, so a call without route arguments runs in the route it was learned in.
  let proxyOpId = '';
  it('remote_proxy: calling a learned operation without route arguments uses its learned route (OPS-PROXY-KIND regression)', async () => {
    expect(proxyOpId).not.toBe('');
    const c = await h.call('operation_call', { operationId: proxyOpId, args: { query: 'route default' } });
    expect(c.isError, c.raw).toBe(false);
    expect(c.data).toMatchObject({ ok: true, mode: 'remote_proxy' });
  });

  it('the proxy-ownership check is not vacuous: a direct request is detected', async () => {
    const before = site.state.requests.length;
    await fetch(`${site.origin}/`);
    const direct = site.state.requests.slice(before);
    expect(direct).toHaveLength(1);
    expect(proxyLocalPorts.has(Number(direct[0]!.remotePort))).toBe(false);
  });

  it('operations are deleted; nothing left running', async () => {
    const list = await h.call('operation_list', {});
    const ids = list.data.operations.map((o: { operationId?: string; id?: string }) => o.operationId ?? o.id);
    expect(ids.length).toBe(3);
    for (const id of ids) expect((await h.call('operation_delete', { operationId: id })).isError).toBe(false);
    expect((await h.call('operation_list', {})).data.operations).toEqual([]);
    expect(h.q(`SELECT id FROM sessions WHERE status IN ('starting','ready','closing')`)).toEqual([]);
    expect(await h.stopServer()).toBe(0);
    expect(liveFakeRuns(h.apify)).toEqual([]);
    expect(leftoverLocalRuns(h.dataDir)).toEqual([]);
    for (const s of h.secrets) expect(h.stderr()).not.toContain(s);
  });
});
