/**
 * Scenario F: explicit remote_proxy failure -> refused, with no local or direct
 * fallback, and zero requests reached the target from anywhere (worker or
 * orchestrator).
 * Proof level: local fixture (fake Apify + local test proxy). Live fail-closed
 * evidence is separate (docs/LIVE-RESULTS.md #21).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestProxy } from '../fixtures/proxy.js';
import { leftoverLocalRuns, liveFakeRuns, reportKnownDefects, startE2E, waitFor, type E2E } from './stdio-harness.js';

type Proxy = Awaited<ReturnType<typeof startTestProxy>>;

async function assertRefusedNoFallback(h: E2E, r: { isError: boolean; data: any; raw: string }, runsBefore: number) {
  expect(r.isError, r.raw).toBe(true);
  expect(['provider_error', 'egress_unverified', 'proxy_unavailable']).toContain(r.data.error.code);
  // Exactly one remote run was attempted and it is ended (not left billing).
  expect(h.apify!.state.runStarts - runsBefore).toBe(1);
  expect(await waitFor(() => liveFakeRuns(h.apify).length === 0, 15_000)).toBe(true);
  const run = [...h.apify!.runs.values()].at(-1)!;
  expect(['ABORTED', 'FAILED', 'SUCCEEDED']).toContain(run.status);
  expect(run.input.proxy.mode).toBe('datacenter');
  // No fallback: no local worker, no second (direct) run, no ready session.
  expect(h.q(`SELECT id FROM sessions WHERE provider = 'local'`)).toEqual([]);
  expect(leftoverLocalRuns(h.dataDir)).toEqual([]);
  expect(h.q(`SELECT id FROM sessions WHERE status = 'ready'`)).toEqual([]);
  expect(h.q<{ status: string }>(`SELECT status FROM sessions ORDER BY created_at DESC LIMIT 1`)[0]!.status).toBe('failed');
  // Zero requests reached either target, from the worker's browser OR the orchestrator.
  expect(h.site.state.requests).toEqual([]);
  expect(h.catalog.hits).toEqual([]);
}

describe('F: remote_proxy that cannot be obtained -> refused, no fallback, target untouched', () => {
  let proxy: Proxy;
  let h: E2E;
  beforeAll(async () => {
    proxy = await startTestProxy({ fail: true });
    h = await startE2E({ proxyUrl: proxy.url });
  });
  afterAll(async () => {
    reportKnownDefects('f-proxy-fail-closed');
    await h?.close();
    await proxy?.close();
  });

  it('session_start {mode: remote_proxy, proxy: datacenter} is refused', async () => {
    const before = h.apify!.state.runStarts;
    const r = await h.call('session_start', { mode: 'remote_proxy', proxy: { kind: 'datacenter' } });
    await assertRefusedNoFallback(h, r, before);
  });

  it('crawl_start through the failing proxy never touches the target', async () => {
    const before = h.apify!.state.runStarts;
    const r = await h.call('crawl_start', { mode: 'remote_proxy', proxy: { kind: 'datacenter' }, startUrls: [h.catalog.url('/catalog?cat=tools')], maxPages: 2 });
    let job = r.data;
    if (!r.isError && r.data.jobId) job = await h.untilDone(r.data.jobId);
    expect(r.isError || job.status === 'failed', JSON.stringify(job)).toBe(true);
    expect(h.apify!.state.runStarts - before).toBeLessThanOrEqual(1);
    expect(await waitFor(() => liveFakeRuns(h.apify).length === 0, 15_000)).toBe(true);
    expect(h.q(`SELECT id FROM sessions WHERE provider = 'local'`)).toEqual([]);
    expect(h.catalog.hits).toEqual([]);
    expect(h.site.state.requests).toEqual([]);
  });

  it('teardown: server exits cleanly, nothing left running', async () => {
    expect(await h.stopServer()).toBe(0);
    expect(liveFakeRuns(h.apify)).toEqual([]);
    expect(h.catalog.hits).toEqual([]);
  });
});

describe('F2: proxy reachable but egress identical to the worker direct IP -> refused', () => {
  let proxy: Proxy;
  let h: E2E;
  beforeAll(async () => {
    // The ip-echo fixture sees 127.0.0.1 for the worker's direct check; the proxy reports the same IP.
    proxy = await startTestProxy({ egressIp: '127.0.0.1' });
    h = await startE2E({ proxyUrl: proxy.url });
  });
  afterAll(async () => {
    await h?.close();
    await proxy?.close();
  });

  it('session_start is refused; nothing is sent to the target', async () => {
    const before = h.apify!.state.runStarts;
    const r = await h.call('session_start', { mode: 'remote_proxy', proxy: { kind: 'datacenter' } });
    await assertRefusedNoFallback(h, r, before);
    expect(r.raw).toMatch(/could not be verified|egress|equals/i);
  });
});
