import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/site.js';
import { startIpEcho } from '../fixtures/ipecho.js';
import { hostOf, startWorker } from './harness.js';

describe('worker: storage state export/import and isolation', () => {
  let site: FixtureSite;
  let echo: Awaited<ReturnType<typeof startIpEcho>>;
  const input = () => ({
    network: { allowedNavigationOrigins: ['*'], allowPrivateHosts: [hostOf(site.origin), hostOf(echo.url)] },
    egressCheckUrl: echo.url,
  });

  beforeAll(async () => {
    site = await startFixtureSite();
    echo = await startIpEcho();
    site.state.accounts.set('a@example.com', { email: 'a@example.com', password: 'pw-123456', name: 'A', verified: true });
  });
  afterAll(async () => {
    await site?.close();
    await echo?.close();
  });

  it('exports state after login; a new worker with it is logged in; a third without is not', async () => {
    const w1 = await startWorker({ input: input() });
    let state: any;
    try {
      expect((await w1.call('/session/init', {})).status).toBe(200);
      await w1.call('/navigate', { url: site.url('/login') });
      await w1.call('/fill', { selector: '#email', value: 'a@example.com' });
      await w1.call('/fill', { selector: '#password', value: 'pw-123456' });
      const c = await w1.call('/click', { selector: '#login', waitForNavigation: true });
      expect(c.body.page.url).toBe(site.url('/account'));
      const ex = await w1.call('/state/export', {});
      expect(ex.status).toBe(200);
      state = ex.body.storageState;
      const sid = (state.cookies as any[]).find((k) => k.name === 'sid');
      expect(sid).toBeTruthy();
      expect(sid.httpOnly).toBe(true);
      expect(w1.output()).not.toContain(sid.value);
    } finally {
      await w1.stop();
    }

    const w2 = await startWorker({ input: input() });
    try {
      expect((await w2.call('/session/init', { storageState: state })).status).toBe(200);
      const nav = await w2.call('/navigate', { url: site.url('/account') });
      expect(nav.body.page.url).toBe(site.url('/account'));
      const ins = await w2.call('/inspect', {});
      expect(ins.body.text).toContain('Logged in as a@example.com');
    } finally {
      await w2.stop();
    }

    const w3 = await startWorker({ input: input() });
    try {
      expect((await w3.call('/session/init', {})).status).toBe(200);
      const nav = await w3.call('/navigate', { url: site.url('/account') });
      expect(nav.body.page.url).toBe(site.url('/login'));
      expect(nav.body.redirectChain).toEqual([site.url('/account'), site.url('/login')]);
    } finally {
      await w3.stop();
    }
  });
});
