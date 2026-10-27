import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/site.js';
import { startIpEcho } from '../fixtures/ipecho.js';
import { hostOf, startWorker, type Worker } from './harness.js';

async function waitDone(w: Worker, ms = 30_000): Promise<any> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await w.call('/crawl/status');
    if (s.body.state !== 'running') return s.body;
    if (Date.now() > deadline) throw new Error('crawl did not finish');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('worker: crawl', () => {
  let site: FixtureSite;
  let echo: Awaited<ReturnType<typeof startIpEcho>>;
  let w: Worker;
  const base = () => ({
    sameOriginOnly: true,
    includeGlobs: [] as string[],
    excludeGlobs: [] as string[],
    maxPages: 50,
    maxDepth: 5,
    delayMs: 0,
    pageTimeoutMs: 10_000,
    maxRetriesPerPage: 1,
  });

  beforeAll(async () => {
    site = await startFixtureSite();
    echo = await startIpEcho();
    w = await startWorker({
      input: {
        network: { allowedNavigationOrigins: [site.origin], allowPrivateHosts: [hostOf(site.origin), hostOf(echo.url)] },
        egressCheckUrl: echo.url,
      },
    });
    expect((await w.call('/session/init', {})).status).toBe(200);
  });
  afterAll(async () => {
    await w?.stop();
    await site?.close();
    await echo?.close();
  });

  it('respects maxDepth', async () => {
    const r = await w.call('/crawl/start', { ...base(), startUrls: [site.url('/page/1')], maxDepth: 1, extract: { fields: { h1: { selector: 'h1' } } } });
    expect(r.status).toBe(200);
    const st = await waitDone(w);
    expect(st.state).toBe('completed');
    const res = await w.call('/crawl/results?offset=0&limit=100');
    const urls = (res.body.results as any[]).map((x) => x.url).sort();
    // page 1 links to 2 and 3 (depth 1); nothing deeper.
    expect(urls).toEqual([site.url('/page/1'), site.url('/page/2'), site.url('/page/3')]);
    expect((res.body.results as any[]).find((x) => x.url === site.url('/page/2')).items[0].h1).toBe('Page 2');
    expect(res.body.nextOffset).toBe(3);
  });

  it('respects maxPages and globs', async () => {
    await w.call('/crawl/start', { ...base(), startUrls: [site.url('/page/1')], maxPages: 3 });
    const st = await waitDone(w);
    expect(st.state).toBe('completed');
    expect(st.pagesDone + st.pagesFailed).toBe(3);

    await w.call('/crawl/start', { ...base(), startUrls: [site.url('/page/1')], excludeGlobs: ['*/page/3'] });
    await waitDone(w);
    const res = await w.call('/crawl/results?offset=0&limit=100');
    const urls = (res.body.results as any[]).map((x) => x.url);
    expect(urls).not.toContain(site.url('/page/3'));
    expect(urls).toContain(site.url('/page/6'));
  });

  it('interactive commands are busy while crawling; cancellation works', async () => {
    await w.call('/crawl/start', { ...base(), startUrls: [site.url('/page/1')], delayMs: 1000 });
    const busy = await w.call('/navigate', { url: site.url('/') });
    expect(busy.body.error.code).toBe('busy');
    const c = await w.call('/crawl/cancel', {});
    expect(c.body.state).toBe('cancelled');
    const st = await w.call('/crawl/status');
    expect(st.body.state).toBe('cancelled');
    expect(st.body.pagesDone).toBeLessThan(6);
    expect((await w.call('/navigate', { url: site.url('/') })).status).toBe(200);
  });

  it('stops with state "blocked" on a 403 page (access_denied)', async () => {
    await w.call('/crawl/start', { ...base(), startUrls: [site.url('/blocked'), site.url('/page/1')] });
    const st = await waitDone(w);
    expect(st.state).toBe('blocked');
    expect(st.blocked.kind).toBe('access_denied');
    const res = await w.call('/crawl/results?offset=0&limit=10');
    expect(res.body.results[0].error).toBe('blocked: access_denied');
  });

  it('rejects start URLs outside the navigation policy', async () => {
    const r = await w.call('/crawl/start', { ...base(), startUrls: ['http://169.254.169.254/'] });
    expect(r.body.error.code).toBe('navigation_blocked');
    const r2 = await w.call('/crawl/start', { ...base(), startUrls: ['https://example.com/'] });
    expect(r2.body.error.code).toBe('navigation_blocked');
  });

  it('cancel during a hanging navigation stops in-flight work and closes the crawl page', async () => {
    site.state.aborted.length = 0;
    await w.call('/crawl/start', { ...base(), maxRetriesPerPage: 0, pageTimeoutMs: 60_000, startUrls: [site.url('/slow?ms=90000')] });
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    const c = await w.call('/crawl/cancel', {});
    expect(c.body.state).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(12_000);
    await new Promise((r) => setTimeout(r, 500));
    // The in-flight request was torn down (page closed), not left running.
    expect(site.state.aborted).toContain('GET /slow');
    // The session is usable again: no lingering crawl or lock.
    expect((await w.call('/navigate', { url: site.url('/page/1') })).status).toBe(200);
  }, 30_000);

  it('whole-crawl deadline: in-flight navigation cancelled, state "deadline", results kept', async () => {
    site.state.aborted.length = 0;
    await w.call('/crawl/start', { ...base(), maxRetriesPerPage: 0, pageTimeoutMs: 60_000, maxDurationMs: 3000, startUrls: [site.url('/page/1'), site.url('/slow?ms=90000')] });
    const st = await waitDone(w, 25_000);
    const res = await w.call('/crawl/results?offset=0&limit=10');
    expect(st.state, JSON.stringify({ st, results: res.body.results })).toBe('deadline');
    expect(res.body.results[0]).toMatchObject({ title: 'Page 1', error: null });
    expect(res.body.results[1].error).toMatch(/^crawl_deadline/);
    expect(site.state.aborted).toContain('GET /slow');
  }, 40_000);

  it('per-page deadline: a hung renderer fails that page and the crawl continues', async () => {
    await w.call('/crawl/start', {
      ...base(),
      maxRetriesPerPage: 0,
      pageTimeoutMs: 1000,
      maxDepth: 0,
      startUrls: [site.url('/hang?onload=1'), site.url('/page/2')],
      extract: { fields: { h: { selector: 'h1' } } },
      delayMs: 1500,
    });
    const st = await waitDone(w, 60_000);
    expect(st.state).toBe('completed');
    const res = await w.call('/crawl/results?offset=0&limit=10');
    const byUrl = Object.fromEntries(res.body.results.map((r: any) => [new URL(r.url).pathname, r]));
    expect(byUrl['/page/2'], JSON.stringify(res.body.results)).toMatchObject({ error: null, title: 'Page 2' });
    expect(byUrl['/hang'].error).toMatch(/page_deadline/);
  }, 90_000);
});
