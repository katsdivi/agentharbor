/**
 * Worker routes POST /fetch and POST /capture against the real worker build.
 * Proves that /fetch (Playwright context.request) goes through the worker's
 * PolicyProxy and, in proxy modes, through the upstream proxy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/site.js';
import { startIpEcho } from '../fixtures/ipecho.js';
import { startOperationsSite, type OpsSite } from '../fixtures/operations-site.js';
import { startTestProxy } from '../fixtures/proxy.js';
import { hostOf, startWorker, type Worker } from './harness.js';

describe('worker: /fetch and /capture', () => {
  let ops: OpsSite;
  let other: FixtureSite;
  let w: Worker;
  let sid: string;

  beforeAll(async () => {
    ops = await startOperationsSite();
    other = await startFixtureSite();
    sid = ops.addUser('alice');
    w = await startWorker({
      input: { network: { allowedNavigationOrigins: [ops.origin], allowPrivateHosts: [hostOf(ops.origin), hostOf(other.origin)] } },
    });
    const host = new URL(ops.origin).hostname;
    const init = await w.call('/session/init', {
      storageState: { cookies: [{ name: 'sid', value: sid, domain: host, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] },
    });
    expect(init.status).toBe(200);
  });
  afterAll(async () => {
    await w?.stop();
    await ops?.close();
    await other?.close();
  });

  it('advertises the capabilities on /health', async () => {
    const h = await w.call('/health', undefined, { token: null });
    expect(h.body.capabilities).toEqual(['fetch', 'capture', 'readiness']);
  });

  it('fetch: request goes through the policy proxy and uses the context cookie jar', async () => {
    const r = await w.call('/fetch', { method: 'GET', url: ops.url('/api/orders?status=open'), headers: { accept: 'application/json' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 200, redirectChain: [ops.url('/api/orders?status=open')], truncated: false, blocked: null });
    expect(JSON.parse(r.body.body)).toMatchObject({ user: 'alice', orders: [{ id: 'alice-open-1' }, { id: 'alice-open-2' }] });
    const last = ops.state.requests.at(-1)!;
    expect(last.path).toBe('/api/orders');
    expect(last.cookieNames).toEqual(['sid']);
    // The PolicyProxy recorded a plain-HTTP connection to the site: context.request did not bypass it.
    const d = await w.call('/diagnostics');
    const port = Number(new URL(ops.origin).port);
    // (Playwright's API client tunnels with CONNECT even for http: URLs.)
    expect(d.body.connections.some((c: any) => c.host === '127.0.0.1' && c.port === port && c.kind === 'connect' && c.outcome !== 'blocked')).toBe(true);
  });

  it('fetch: refuses a Cookie header, a body on GET and non-http URLs', async () => {
    expect((await w.call('/fetch', { method: 'GET', url: ops.url('/api/search'), headers: { cookie: 'sid=x' } })).body.error.code).toBe('bad_request');
    expect((await w.call('/fetch', { method: 'GET', url: ops.url('/api/search'), body: 'x' })).body.error.code).toBe('bad_request');
    expect((await w.call('/fetch', { method: 'GET', url: 'file:///etc/passwd' })).body.error.code).toBe('bad_request');
    expect((await w.call('/fetch', { method: 'DELETE', url: ops.url('/api/search') })).body.error.code).toBe('bad_request');
  });

  it('fetch: a URL outside the allowed origins is refused before anything is sent', async () => {
    other.state.requests.length = 0;
    const r = await w.call('/fetch', { method: 'GET', url: other.url('/products') });
    expect(r.body.error.code).toBe('navigation_blocked');
    expect(other.state.requests).toEqual([]);
  });

  it('fetch: a redirect hop to a disallowed origin is refused before it is requested', async () => {
    const w2 = await startWorker({
      input: { network: { allowedNavigationOrigins: [other.origin], allowPrivateHosts: [hostOf(ops.origin), hostOf(other.origin)] } },
    });
    try {
      expect((await w2.call('/session/init', {})).status).toBe(200);
      ops.state.requests.length = 0;
      const r = await w2.call('/fetch', { method: 'GET', url: other.url(`/redirect?to=${encodeURIComponent(ops.url('/api/search?q=abc'))}`) });
      expect(r.body.error.code).toBe('navigation_blocked');
      expect(ops.state.requests).toEqual([]);
    } finally {
      await w2.stop();
    }
  });

  it('fetch: a cross-origin redirect is refused unless explicitly allowed, then sensitive headers are dropped', async () => {
    const w3 = await startWorker({
      input: { network: { allowedNavigationOrigins: [other.origin, ops.origin], allowPrivateHosts: [hostOf(ops.origin), hostOf(other.origin)] } },
    });
    try {
      expect((await w3.call('/session/init', {})).status).toBe(200);
      ops.state.requests.length = 0;
      const url = other.url(`/redirect?to=${encodeURIComponent(ops.url('/api/search?q=abc'))}`);
      const refused = await w3.call('/fetch', { method: 'GET', url, headers: { 'x-csrf-token': 'secret-value-123' } });
      expect(refused.body.error.code).toBe('navigation_blocked');
      expect(ops.state.requests).toEqual([]);
      const ok = await w3.call('/fetch', { method: 'GET', url, headers: { 'x-csrf-token': 'secret-value-123' }, allowCrossOriginRedirects: true, sensitiveHeaders: ['x-csrf-token'] });
      expect(ok.body).toMatchObject({ status: 200, redirectChain: [url, ops.url('/api/search?q=abc')] });
    } finally {
      await w3.stop();
    }
  });

  it('fetch: maps 403 to an access_denied signal without retrying', async () => {
    const r = await w.call('/fetch', { method: 'GET', url: ops.url('/api/signed?q=x&nonce=1&sig=bad') });
    expect(r.body).toMatchObject({ status: 403, blocked: { kind: 'access_denied' } });
  });

  it('capture: records the page\'s own API exchange with bounded bodies', async () => {
    const r = await w.call('/capture', { url: ops.url('/search?q=sqlite'), waitMs: 500 });
    expect(r.status).toBe(200);
    const api = r.body.exchanges.find((e: any) => e.request.url.includes('/api/search'));
    expect(api).toBeTruthy();
    expect(api.resourceType).toBe('fetch');
    expect(api.request.headers.cookie).toContain('sid=');
    expect(JSON.parse(api.response.body).hits[0].title).toBe('Result 1 for sqlite');
    expect(r.body.exchanges.some((e: any) => e.resourceType === 'document')).toBe(true);
    expect(r.body.finalUrl).toBe(ops.url('/search?q=sqlite'));
    expect(r.body.locations).toContain(ops.url('/search?q=sqlite'));

    const small = await w.call('/capture', { url: ops.url('/search?q=sqlite'), waitMs: 500, maxBodyBytes: 10, maxExchanges: 1 });
    expect(small.body.exchanges).toHaveLength(1);
    expect(small.body.truncated).toBe(true);
  });

  it('capture: steps are validated and navigation stays inside the policy', async () => {
    expect((await w.call('/capture', { url: ops.url('/search'), steps: [{ action: 'eval', value: 'x' }] })).body.error.code).toBe('bad_request');
    expect((await w.call('/capture', { url: ops.url('/search'), steps: [{ action: 'wait', ms: 999999 }] })).body.error.code).toBe('bad_request');
    other.state.requests.length = 0;
    const r = await w.call('/capture', { url: other.url('/products') });
    expect(r.body.error.code).toBe('navigation_blocked');
    expect(other.state.requests).toEqual([]);
  });
});

describe('worker: /fetch through an upstream proxy', () => {
  it('residential via the test proxy: the fetch leaves through the proxy', async () => {
    const ops = await startOperationsSite();
    const echo = await startIpEcho();
    const proxy = await startTestProxy({ egressIp: '203.0.113.9' });
    const w = await startWorker({
      input: { proxy: { mode: 'residential' }, network: { allowedNavigationOrigins: [ops.origin], allowPrivateHosts: [hostOf(ops.origin), hostOf(echo.url)] }, egressCheckUrl: echo.url },
      env: { RBA_WORKER_TEST_PROXY_URL: proxy.url },
    });
    try {
      const init = await w.call('/session/init', {});
      expect(init.body.egress.status).toBe('verified');
      const r = await w.call('/fetch', { method: 'GET', url: ops.url('/api/search?q=proxied') });
      expect(r.body.status).toBe(200);
      // The upstream proxy carried the fetch (a CONNECT tunnel to the site; the browser's own
      // navigations would show as absolute-URI requests instead).
      expect(proxy.requests.some((x) => x === `CONNECT ${new URL(ops.origin).host}`)).toBe(true);
      expect(ops.apiRequests()).toHaveLength(1);
    } finally {
      await w.stop();
      await proxy.close();
      await echo.close();
      await ops.close();
    }
  });
});
