import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/site.js';
import { startIpEcho } from '../fixtures/ipecho.js';
import { startTestProxy } from '../fixtures/proxy.js';
import { hostOf, startWorker } from './harness.js';

describe('worker: proxy egress', () => {
  let site: FixtureSite;
  let echo: Awaited<ReturnType<typeof startIpEcho>>;
  const input = (mode: 'residential' | 'datacenter') => ({
    proxy: { mode, country: 'US', sessionKey: 'sess_1' },
    network: { allowedNavigationOrigins: ['*'], allowPrivateHosts: [hostOf(site.origin), hostOf(echo.url)] },
    egressCheckUrl: echo.url,
  });

  beforeAll(async () => {
    site = await startFixtureSite();
    echo = await startIpEcho();
  });
  afterAll(async () => {
    await site?.close();
    await echo?.close();
  });

  it('residential via test proxy: egress verified, browser traffic goes through the proxy', async () => {
    const proxy = await startTestProxy({ egressIp: '203.0.113.7' });
    const w = await startWorker({ input: input('residential'), env: { RBA_WORKER_TEST_PROXY_URL: proxy.url } });
    try {
      const init = await w.call('/session/init', {});
      expect(init.status).toBe(200);
      expect(init.body.egress).toMatchObject({
        mode: 'residential',
        status: 'verified',
        enforcement: 'browser_proxy_flag+ip_check',
        browserIp: '203.0.113.7',
        directIp: '127.0.0.1',
      });
      const nav = await w.call('/navigate', { url: site.url('/page/1') });
      expect(nav.status).toBe(200);
      expect(proxy.requests.some((r) => r.includes('/page/1'))).toBe(true);
    } finally {
      await w.stop();
      await proxy.close();
    }
  });

  it('failing proxy: init fails closed and nothing reaches the site directly', async () => {
    const proxy = await startTestProxy({ fail: true });
    site.state.requests.length = 0;
    const w = await startWorker({ input: input('datacenter'), env: { RBA_WORKER_TEST_PROXY_URL: proxy.url } });
    try {
      const init = await w.call('/session/init', {});
      expect(init.body.ok).toBe(false);
      expect(['egress_unverified', 'proxy_unavailable']).toContain(init.body.error.code);
      const nav = await w.call('/navigate', { url: site.url('/page/1') });
      expect(nav.body.error.code).toBe('not_ready');
      expect(site.state.requests).toEqual([]);
      const h = await w.call('/health', undefined, { token: null });
      expect(h.body.ready).toBe(false);
    } finally {
      await w.stop();
      await proxy.close();
    }
  });

  it('no Apify proxy available (local, no test URL): proxy_unavailable, browser never used', async () => {
    site.state.requests.length = 0;
    const w = await startWorker({ input: input('residential') });
    try {
      const init = await w.call('/session/init', {});
      expect(init.body.error.code).toBe('proxy_unavailable');
      expect((await w.call('/navigate', { url: site.url('/') })).body.error.code).toBe('not_ready');
      expect(site.state.requests).toEqual([]);
    } finally {
      await w.stop();
    }
  });

  it('test proxy URL is ignored without RBA_WORKER_TEST_MODE=1', async () => {
    const proxy = await startTestProxy();
    const w = await startWorker({ input: input('residential'), env: { RBA_WORKER_TEST_MODE: '0', RBA_WORKER_TEST_PROXY_URL: proxy.url } });
    try {
      const init = await w.call('/session/init', {});
      expect(init.body.error.code).toBe('proxy_unavailable');
      expect(proxy.requests).toEqual([]);
    } finally {
      await w.stop();
      await proxy.close();
    }
  });
});
