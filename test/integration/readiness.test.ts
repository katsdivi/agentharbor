import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isTerminal } from '../../src/core/jobs.js';
import { readinessBody } from '../../src/core/readiness.js';
import type { Ctx } from '../../src/core/context.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { startReadinessSite, type ReadinessSite } from '../fixtures/readiness-site.js';
import { HAVE_FFMPEG, makePng } from '../fixtures/media.js';

async function untilDone(h: Harness, jobId: string) {
  for (let i = 0; i < 120; i++) {
    const j = await h.call('job_status', { jobId, waitSecs: 1 });
    if (isTerminal(j.data.status)) return j.data;
  }
  throw new Error('job did not finish');
}

describe('readiness: worker builds without the readiness capability', () => {
  const fakeCtx = (caps: string[]) =>
    ({ sessions: { get: () => ({ client: { call: async () => ({ ok: true, capabilities: caps }) } }) } }) as unknown as Ctx;

  it('internal callers fall back to the legacy request; an explicit readyWhen is refused', async () => {
    const body = { url: 'https://x.test/', waitUntil: 'load', readyWhen: { selector: '#a' }, settleMs: 1000 };
    expect(await readinessBody(fakeCtx(['fetch', 'capture']), 'sess-old-1', body, false)).toEqual({ url: 'https://x.test/', waitUntil: 'load' });
    await expect(readinessBody(fakeCtx(['fetch', 'capture']), 'sess-old-2', body, true)).rejects.toMatchObject({ code: 'config_missing' });
    expect(await readinessBody(fakeCtx(['fetch', 'capture', 'readiness']), 'sess-new-1', body, true)).toEqual(body);
    // Nothing new in the body: never probes, never changes it.
    expect(await readinessBody({} as Ctx, 'sess-x', { url: 'u' }, true)).toEqual({ url: 'u' });
  });
});

describe('readiness through the MCP tools (fixture sites, local worker via fake Apify)', () => {
  let h: Harness;
  let site: ReadinessSite;
  let cdn: ReadinessSite;
  let root: string;
  let sid: string;

  beforeAll(async () => {
    cdn = await startReadinessSite();
    site = await startReadinessSite({ resourceOrigin: () => cdn.origin });
    root = mkdtempSync(join(tmpdir(), 'rba-readiness-'));
    h = await startHarness({ extraOrigins: [site.origin], resourceOrigins: [cdn.origin], vars: { RBA_IMPORT_ROOTS: root } });
    const s = await h.call('session_start', {});
    expect(s.isError, s.raw).toBe(false);
    sid = s.data.sessionId;
  }, 120_000);

  afterEach(() => {
    site.releaseHangs();
    cdn.releaseHangs();
  });

  afterAll(async () => {
    await h?.close();
    await Promise.all([site?.close(), cdn?.close()]);
    rmSync(root, { recursive: true, force: true });
  });

  it('browser_navigate reports a hanging optional resource instead of failing', async () => {
    const r = await h.call('browser_navigate', { sessionId: sid, url: site.url('/hang-img'), settleMs: 1000 });
    expect(r.isError, r.raw).toBe(false);
    expect(r.data.readiness).toMatchObject({ document: 'ready', load: 'pending', condition: 'none' });
    expect(r.data.readiness.pendingRequests.hosts).toContain(new URL(cdn.origin).host);
    expect(r.data.readiness.note).toMatch(/still pending/);
  });

  it('browser_navigate readyWhen waits for delayed content; a missing required condition fails clearly', async () => {
    const ok = await h.call('browser_navigate', { sessionId: sid, url: site.url('/delayed?ms=1200'), readyWhen: { textContains: 'ready now', timeoutMs: 8000 } });
    expect(ok.isError, ok.raw).toBe(false);
    expect(ok.data.readiness.condition).toBe('met');

    const bad = await h.call('browser_navigate', { sessionId: sid, url: site.url('/'), readyWhen: { selector: '#never', timeoutMs: 1000 } });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.code).toBe('timeout');
    expect(bad.data.error.details.workerCode).toBe('condition_not_met');
    expect(bad.data.error.message).toContain('#never');
    expect(bad.data.error.details.readiness).toMatchObject({ document: 'ready', condition: 'not_met' });
    // The session is still usable.
    expect((await h.call('browser_navigate', { sessionId: sid, url: site.url('/') })).isError).toBe(false);
  });

  it('blocked third-party hosts do not delay browser_navigate', async () => {
    const t = Date.now();
    const r = await h.call('browser_navigate', { sessionId: sid, url: site.url('/third-party') });
    expect(r.isError, r.raw).toBe(false);
    expect(r.data.readiness).toMatchObject({ load: 'fired', pendingRequests: { count: 0 } });
    expect(Date.now() - t).toBeLessThan(4000);
  });

  it('scrape_extract waits for itemSelector by default; fails clearly when items never appear; waitForItems:false extracts at once', async () => {
    await h.call('browser_navigate', { sessionId: sid, url: site.url('/delayed?ms=1500'), waitUntil: 'domcontentloaded' });
    const ex = await h.call('scrape_extract', { sessionId: sid, spec: { itemSelector: '.item', fields: { t: { selector: ':scope' } } } });
    expect(ex.isError, ex.raw).toBe(false);
    expect(ex.data.count).toBe(3);

    const none = await h.call('scrape_extract', { sessionId: sid, spec: { itemSelector: '.nothing', fields: { t: { selector: ':scope' } } }, readyWhen: { selector: '.nothing', timeoutMs: 800 } });
    expect(none.isError).toBe(true);
    expect(none.data.error.details.workerCode).toBe('condition_not_met');

    const t = Date.now();
    const empty = await h.call('scrape_extract', { sessionId: sid, spec: { itemSelector: '.nothing', fields: { t: { selector: ':scope' } } }, waitForItems: false });
    expect(empty.isError, empty.raw).toBe(false);
    expect(empty.data.count).toBe(0);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it.skipIf(!HAVE_FFMPEG)('portal_upload waits for a script-rendered file input and a delayed confirmation despite hanging images', async () => {
    const imp = await h.call('file_import', { path: makePng(root, '16x16') });
    expect(imp.isError, imp.raw).toBe(false);
    const r = await h.call('portal_upload', {
      artifactId: imp.data.artifactId,
      targetUrl: site.url('/js-upload'),
      proxyMode: 'direct',
      fileInputSelector: '#file',
      submitSelector: '#upload-submit',
      confirmation: { selector: '#done', textContains: 'upload received' },
      waitSecs: 90,
    });
    expect(r.data.jobId, r.raw).toBeTruthy();
    const job = r.data.status && isTerminal(r.data.status) ? r.data : await untilDone(h, r.data.jobId);
    expect(job.status, JSON.stringify(job)).toBe('completed');
    expect(job.result.outcome).toBe('portal_confirmed');
    expect(site.uploads.length).toBe(1);
  }, 120_000);

  it.skipIf(!HAVE_FFMPEG)('portal_upload with a file input that never appears fails before selecting anything', async () => {
    const before = site.uploads.length;
    const imp = await h.call('file_import', { path: makePng(root, '18x18') });
    const r = await h.call('portal_upload', {
      artifactId: imp.data.artifactId,
      targetUrl: site.url('/js-upload'),
      proxyMode: 'direct',
      fileInputSelector: '#no-such-input',
      submitSelector: '#upload-submit',
      confirmation: { selector: '#done' },
      waitSecs: 90,
    });
    expect(r.data.jobId, r.raw).toBeTruthy();
    const job = r.data.status && isTerminal(r.data.status) ? r.data : await untilDone(h, r.data.jobId);
    expect(job.status, JSON.stringify(job)).toBe('failed');
    expect(JSON.stringify(job)).toMatch(/did not appear/);
    expect(job.submittedAt ?? null).toBeNull();
    expect(site.uploads.length).toBe(before);
  }, 120_000);
});
