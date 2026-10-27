import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startReadinessSite, type ReadinessSite } from '../fixtures/readiness-site.js';
import { startIpEcho } from '../fixtures/ipecho.js';
import { hostOf, startWorker, type Worker } from './harness.js';
import { DEFAULT_SETTLE_MS, commandDeadlineMs, COMMAND_DEADLINE_MARGIN_MS } from '../../actor/src/protocol.js';

describe('protocol: command deadlines include readiness budgets', () => {
  it('navigate = document timeout + max(condition, settle) + margin', () => {
    expect(commandDeadlineMs('/navigate', { timeoutMs: 30_000 })).toBe(30_000 + DEFAULT_SETTLE_MS + COMMAND_DEADLINE_MARGIN_MS);
    expect(commandDeadlineMs('/navigate', { timeoutMs: 5000, waitUntil: 'domcontentloaded' })).toBe(5000 + COMMAND_DEADLINE_MARGIN_MS);
    expect(commandDeadlineMs('/navigate', { timeoutMs: 5000, readyWhen: { selector: '#x', timeoutMs: 40_000 } })).toBe(5000 + 40_000 + COMMAND_DEADLINE_MARGIN_MS);
    expect(commandDeadlineMs('/navigate', { timeoutMs: 5000, settleMs: 2000, readyWhen: { selector: '#x', timeoutMs: 1000 } })).toBe(5000 + 2000 + COMMAND_DEADLINE_MARGIN_MS);
    expect(commandDeadlineMs('/extract', { readyWhen: { selector: '#x', timeoutMs: 7000 } })).toBe(30_000 + 7000 + COMMAND_DEADLINE_MARGIN_MS);
    expect(commandDeadlineMs('/click', { timeoutMs: 1000, waitForNavigation: true })).toBe(1000 + DEFAULT_SETTLE_MS + COMMAND_DEADLINE_MARGIN_MS);
    expect(commandDeadlineMs('/inspect', {})).toBe(30_000 + COMMAND_DEADLINE_MARGIN_MS);
  });
});

describe('worker: navigation readiness', () => {
  let site: ReadinessSite;
  let cdn: ReadinessSite; // slow / hanging resources live here (allowed resource origin)
  let echo: Awaited<ReturnType<typeof startIpEcho>>;
  let w: Worker;

  beforeAll(async () => {
    cdn = await startReadinessSite();
    site = await startReadinessSite({ resourceOrigin: () => cdn.origin });
    echo = await startIpEcho();
    w = await startWorker({
      input: {
        network: {
          allowedNavigationOrigins: [site.origin],
          allowedSubresourceOrigins: [cdn.origin],
          allowPrivateHosts: [hostOf(site.origin), hostOf(cdn.origin), hostOf(echo.url)],
        },
        egressCheckUrl: echo.url,
      },
    });
    const init = await w.call('/session/init', {});
    expect(init.status, JSON.stringify(init.body)).toBe(200);
  });

  afterEach(() => {
    site.releaseHangs();
    cdn.releaseHangs();
  });

  afterAll(async () => {
    await w?.stop();
    await Promise.all([site?.close(), cdn?.close(), echo?.close()]);
  });

  it('advertises the readiness capability', async () => {
    const h = await w.call('/health', undefined, { token: null });
    expect(h.body.capabilities).toContain('readiness');
  });

  it('reports readiness for an ordinary page', async () => {
    const r = await w.call('/navigate', { url: site.url('/') });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.readiness).toMatchObject({ document: 'ready', load: 'fired', condition: 'none', pendingRequests: { count: 0, hosts: [] } });
    expect(typeof r.body.readiness.documentMs).toBe('number');
    expect(typeof r.body.readiness.elapsedMs).toBe('number');
  });

  it('delayed content: without a condition extraction runs too early; readyWhen waits for it', async () => {
    const early = await w.call('/navigate', { url: site.url('/delayed?ms=1500') });
    expect(early.status).toBe(200);
    const ex0 = await w.call('/extract', { spec: { itemSelector: '.item', fields: { t: { selector: ':scope' } } } });
    expect(ex0.body.items).toHaveLength(0); // the problem readyWhen solves

    const nav = await w.call('/navigate', { url: site.url('/delayed?ms=1500'), readyWhen: { selector: '#late', timeoutMs: 8000 } });
    expect(nav.status, JSON.stringify(nav.body)).toBe(200);
    expect(nav.body.readiness.condition).toBe('met');
    expect(nav.body.readiness.elapsedMs).toBeGreaterThanOrEqual(1400);
    const ex = await w.call('/extract', { spec: { itemSelector: '.item', fields: { t: { selector: ':scope' } } } });
    expect(ex.body.items).toHaveLength(3);

    // The same wait on /extract and /inspect (text, case-insensitive).
    await w.call('/navigate', { url: site.url('/delayed?ms=1200'), waitUntil: 'domcontentloaded' });
    const ex2 = await w.call('/extract', { spec: { itemSelector: '.item', fields: { t: { selector: ':scope' } } }, readyWhen: { selector: '.item', timeoutMs: 8000 } });
    expect(ex2.status, JSON.stringify(ex2.body)).toBe(200);
    expect(ex2.body.items.length).toBeGreaterThan(0);
    await w.call('/navigate', { url: site.url('/delayed?ms=1200'), waitUntil: 'domcontentloaded' });
    const ins = await w.call('/inspect', { readyWhen: { textContains: 'READY NOW', timeoutMs: 8000 }, maxElements: 1 });
    expect(ins.status, JSON.stringify(ins.body)).toBe(200);
    expect(ins.body.text).toContain('Ready now');
  });

  it('a hanging optional image does not fail navigation: load pending, request reported, bounded by settleMs', async () => {
    const t = Date.now();
    const r = await w.call('/navigate', { url: site.url('/hang-img'), settleMs: 1500 });
    const took = Date.now() - t;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.readiness).toMatchObject({ document: 'ready', load: 'pending', condition: 'none', loadMs: null });
    expect(r.body.readiness.pendingRequests.count).toBeGreaterThanOrEqual(1);
    expect(r.body.readiness.pendingRequests.hosts).toContain(hostOf(cdn.origin));
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(6000);
  });

  it('legacy waitUntil "load" with a short timeout no longer fails on a hanging optional resource', async () => {
    // Before: page.goto(waitUntil load, 3000) threw a timeout. Now the document is required
    // within 3 s and the load wait is a bounded best-effort settle (default 10 s).
    const t = Date.now();
    const r = await w.call('/navigate', { url: site.url('/hang-async-script'), waitUntil: 'load', timeoutMs: 3000 });
    const took = Date.now() - t;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.readiness).toMatchObject({ document: 'ready', load: 'pending' });
    expect(r.body.page.title).toBe('/hang-async-script');
    expect(took).toBeGreaterThanOrEqual(DEFAULT_SETTLE_MS - 500);
    expect(took).toBeLessThan(DEFAULT_SETTLE_MS + 5000);
  }, 30_000);

  it('a required condition that never appears fails clearly (and the session stays usable)', async () => {
    const t = Date.now();
    const r = await w.call('/navigate', { url: site.url('/'), readyWhen: { selector: '#never', timeoutMs: 1500 } });
    const took = Date.now() - t;
    expect(r.status).toBe(412);
    expect(r.body.error.code).toBe('condition_not_met');
    expect(r.body.error.message).toContain('#never');
    expect(r.body.error.message).toMatch(/document ready/);
    expect(r.body.error.readiness).toMatchObject({ document: 'ready', condition: 'not_met' });
    expect(r.body.error.readiness.conditionDetail).toContain('#never');
    expect(took).toBeLessThan(6000);
    const ok = await w.call('/navigate', { url: site.url('/') });
    expect(ok.status).toBe(200);
    // Same on /extract.
    const ex = await w.call('/extract', { spec: { fields: { a: { selector: '#never' } } }, readyWhen: { selector: '#never', timeoutMs: 500 } });
    expect(ex.body.error.code).toBe('condition_not_met');
  });

  it('a slow but completing resource: load fires and is timed', async () => {
    const r = await w.call('/navigate', { url: site.url('/slow-img?ms=1500') });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.readiness).toMatchObject({ document: 'ready', load: 'fired', pendingRequests: { count: 0 } });
    expect(r.body.readiness.loadMs).toBeGreaterThanOrEqual(1400);
    expect(r.body.readiness.documentMs).toBeLessThan(r.body.readiness.loadMs);
  });

  it('policy-blocked third-party hosts do not delay the page', async () => {
    const t = Date.now();
    const r = await w.call('/navigate', { url: site.url('/third-party') });
    const took = Date.now() - t;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.readiness).toMatchObject({ document: 'ready', load: 'fired', pendingRequests: { count: 0 } });
    expect(took).toBeLessThan(3000);
    const d = await w.call('/diagnostics');
    const hosts = d.body.blockedHosts.map((b: { host: string }) => b.host);
    expect(hosts).toEqual(expect.arrayContaining(['fonts.example-thirdparty.test', 'ads.example-thirdparty.test']));
  });

  it('response conditions: met by a matching late API response, not met on status mismatch', async () => {
    const r = await w.call('/navigate', { url: site.url('/api-later?ms=800'), readyWhen: { response: { urlContains: '/api/data', status: 200 }, timeoutMs: 5000 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.readiness.condition).toBe('met');
    expect(r.body.readiness.elapsedMs).toBeGreaterThanOrEqual(700);
    const bad = await w.call('/navigate', { url: site.url('/api-later?ms=100&status=500'), readyWhen: { response: { urlContains: '/api/data', status: 200 }, timeoutMs: 1500 } });
    expect(bad.body.error.code).toBe('condition_not_met');
    expect(bad.body.error.message).toContain('/api/data');
  });

  it('a parser-blocking hanging script: document timeout fails without a condition, succeeds when the condition is met', async () => {
    const r = await w.call('/navigate', { url: site.url('/parser-block'), timeoutMs: 1500 });
    expect(r.body.error?.code, JSON.stringify(r.body)).toBe('timeout');
    expect(r.body.error.message).toMatch(/DOMContentLoaded/);
    expect(r.body.error.readiness).toMatchObject({ document: 'timeout', load: 'pending' });
    site.releaseHangs();
    cdn.releaseHangs();
    const ok = await w.call('/navigate', { url: site.url('/parser-block'), timeoutMs: 1500, readyWhen: { selector: '#top', timeoutMs: 2000 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.readiness).toMatchObject({ document: 'timeout', condition: 'met', load: 'pending' });
  });

  it('a click-started navigation to a page with a hanging resource returns after the bounded settle', async () => {
    await w.call('/navigate', { url: site.url('/nav-to-hang') });
    const t = Date.now();
    const c = await w.call('/click', { selector: '#submit', waitForNavigation: true, timeoutMs: 5000 });
    const took = Date.now() - t;
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.page.title).toBe('/hang-img');
    expect(c.body.readiness).toMatchObject({ document: 'ready', load: 'pending' });
    expect(took).toBeLessThan(DEFAULT_SETTLE_MS + 5000);
  }, 30_000);

  it('rejects malformed readyWhen', async () => {
    for (const readyWhen of [{}, { selector: '' }, { selector: '#a', bogus: 1 }, { response: { status: 200 } }, { response: { urlContains: 'x', status: 99 } }, 'x']) {
      const r = await w.call('/navigate', { url: site.url('/'), readyWhen });
      expect(r.status, JSON.stringify(readyWhen)).toBe(400);
      expect(r.body.error.code).toBe('bad_request');
    }
    const bad = await w.call('/navigate', { url: site.url('/'), readyWhen: { selector: '###', timeoutMs: 500 } });
    expect(bad.body.error.code).toBe('bad_request');
  });
});
