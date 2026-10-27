/**
 * Execution modes (INTERFACES.md section 2) through the built MCP server over stdio.
 *  - refusal matrix: contradictions and unavailable modes are refused, never coerced;
 *  - remote_direct / remote_proxy via the fake Apify (plumbing proof only, local fixture);
 *  - local via the server's real LocalProvider on this computer (this is macOS
 *    evidence only when this suite runs on macOS).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestProxy } from '../fixtures/proxy.js';
import { alive, leftoverLocalRuns, liveFakeRuns, navigate, reportKnownDefects, startE2E, waitFor, type E2E } from './stdio-harness.js';

type Proxy = Awaited<ReturnType<typeof startTestProxy>>;
const ROOT = resolve(import.meta.dirname, '../..');

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
  } catch {
    return '';
  }
}
/** All descendant pids of `pid` (macOS/Linux pgrep). */
function descendants(pid: number): number[] {
  const kids = sh('pgrep', ['-P', String(pid)]).split('\n').filter(Boolean).map(Number);
  return kids.flatMap((k) => [k, ...descendants(k)]);
}

describe('modes: refusal matrix, remote_direct, remote_proxy, local', () => {
  let proxy: Proxy;
  let h: E2E;
  beforeAll(async () => {
    proxy = await startTestProxy({ egressIp: '203.0.113.7' });
    h = await startE2E({ proxyUrl: proxy.url });
  });
  afterAll(async () => {
    reportKnownDefects('modes');
    await h?.close();
    await proxy?.close();
  });

  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ['remote_proxy with proxyMode direct', { mode: 'remote_proxy', proxyMode: 'direct' }, 'invalid_input'],
    ['remote_proxy without a proxy kind', { mode: 'remote_proxy' }, 'invalid_input'],
    ['local with a proxy', { mode: 'local', proxy: { kind: 'datacenter' } }, 'invalid_input'],
    ['local with legacy proxyMode residential', { mode: 'local', proxyMode: 'residential' }, 'invalid_input'],
    ['remote_direct with a proxy', { mode: 'remote_direct', proxy: { kind: 'residential' } }, 'invalid_input'],
    ['remote_direct with a country', { mode: 'remote_direct', country: 'US' }, 'invalid_input'],
    ['local with a country', { mode: 'local', country: 'US' }, 'invalid_input'],
    ['proxy.kind contradicting proxyMode', { mode: 'remote_proxy', proxy: { kind: 'datacenter' }, proxyMode: 'residential' }, 'invalid_input'],
  ];
  for (const [name, args, code] of refusals) {
    it(`refuses: ${name} (no worker started)`, async () => {
      const runs = h.apify!.state.runStarts;
      const sessions = h.q('SELECT id FROM sessions').length;
      const r = await h.call('session_start', args);
      expect(r.isError, r.raw).toBe(true);
      expect(r.data.error.code).toBe(code);
      expect(h.apify!.state.runStarts).toBe(runs);
      expect(h.q('SELECT id FROM sessions').length).toBe(sessions);
      expect(leftoverLocalRuns(h.dataDir)).toEqual([]);
    });
  }

  it('the same refusals apply to crawl_start and portal_upload (checked before any job or worker)', async () => {
    const runs = h.apify!.state.runStarts;
    const jobs = h.q('SELECT id FROM jobs').length;
    const c = await h.call('crawl_start', { mode: 'local', proxy: { kind: 'datacenter' }, startUrls: [h.catalog.url('/catalog?cat=tools')], maxPages: 1 });
    expect(c.data.error?.code).toBe('invalid_input');
    const p = await h.call('portal_upload', { mode: 'remote_proxy', proxyMode: 'direct', artifactId: 'file_doesnotexist', targetUrl: h.site.url('/upload') });
    expect(p.isError).toBe(true);
    expect(h.apify!.state.runStarts).toBe(runs);
    expect(h.q('SELECT id FROM jobs').length).toBe(jobs);
  });

  it('remote_direct: fake-Apify run with proxy mode direct; route not checked; target reached by the browser only', async () => {
    const before = h.catalog.hits.length;
    const s = await h.call('session_start', { mode: 'remote_direct' });
    expect(s.isError, s.raw).toBe(false);
    expect(s.data.route).toMatchObject({ mode: 'remote_direct', proxy: null, source: 'explicit', verification: 'not_checked' });
    const run = [...h.apify!.runs.values()].at(-1)!;
    expect(run.input.proxy.mode).toBe('direct');
    expect((await navigate(h, s.data.sessionId, h.catalog.url('/catalog?cat=tools'))).isError).toBe(false);
    expect(h.catalog.hits.slice(before).every((x) => x.uaClass === 'browser')).toBe(true);
    await h.call('session_close', { sessionId: s.data.sessionId });
    expect(await waitFor(() => liveFakeRuns(h.apify).length === 0)).toBe(true);
  });

  it('remote_proxy: route verified (egress differs from the worker direct IP) and browser traffic goes through the proxy', async () => {
    const s = await h.call('session_start', { mode: 'remote_proxy', proxy: { kind: 'datacenter', country: 'us' } });
    expect(s.isError, s.raw).toBe(false);
    expect(s.data.route).toMatchObject({ mode: 'remote_proxy', proxy: { kind: 'datacenter', country: 'US' }, verification: 'verified' });
    expect(s.data.egress.browserIp).toBe('203.0.113.7');
    expect(s.data.egress.browserIp).not.toBe(s.data.egress.directIp);
    expect(JSON.stringify(s.data)).not.toMatch(/\banonymous\b/i); // a disclaimer about anonymity is fine; the label is not
    const run = [...h.apify!.runs.values()].at(-1)!;
    expect(run.input.proxy.mode).toBe('datacenter');
    const proxied = proxy.requests.length;
    expect((await navigate(h, s.data.sessionId, h.catalog.url('/catalog?cat=garden'))).isError).toBe(false);
    expect(proxy.requests.slice(proxied).some((x) => x.includes(h.catalog.host))).toBe(true);
    await h.call('session_close', { sessionId: s.data.sessionId });
    expect(await waitFor(() => liveFakeRuns(h.apify).length === 0)).toBe(true);
  });

  it('legacy proxyMode residential maps to remote_proxy (documented derivation, source legacy_proxyMode)', async () => {
    const s = await h.call('session_start', { proxyMode: 'residential' });
    expect(s.isError, s.raw).toBe(false);
    expect(s.data.route).toMatchObject({ mode: 'remote_proxy', proxy: { kind: 'residential' }, source: 'legacy_proxyMode' });
    await h.call('session_close', { sessionId: s.data.sessionId });
  });

  it('default with no mode is remote_direct (config_default) for existing installs', async () => {
    const s = await h.call('session_start', {});
    expect(s.isError, s.raw).toBe(false);
    expect(s.data.route).toMatchObject({ mode: 'remote_direct', source: 'config_default' });
    await h.call('session_close', { sessionId: s.data.sessionId });
  });

  it('local: real LocalProvider; minimal worker env; temporary automation profile; no egress service; no usage row', async () => {
    const runs = h.apify!.state.runStarts;
    const echoBefore = h.echo.requests;
    const s = await h.call('session_start', { mode: 'local' });
    expect(s.isError, s.raw).toBe(false);
    expect(s.data.route).toMatchObject({ mode: 'local', provider: 'local', proxy: null, verification: 'not_checked' });
    expect(JSON.stringify(s.data)).not.toMatch(/\banonymous\b/i); // a disclaimer about anonymity is fine; the label is not
    expect(h.apify!.state.runStarts).toBe(runs); // nothing remote
    expect(h.echo.requests).toBe(echoBefore); // the egress service was not contacted
    const row = h.q<{ provider_run_id: string; container_url: string }>('SELECT provider_run_id, container_url FROM sessions WHERE id = ?', s.data.sessionId)[0]!;
    const pid = Number(row.provider_run_id.split(':')[1]);
    expect(alive(pid)).toBe(true);
    expect(row.container_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Worker environment (macOS `ps -E` shows the environment of our own processes).
    const envLine = sh('ps', ['-E', '-o', 'command=', '-p', String(pid)]);
    if (process.platform === 'darwin') expect(envLine).toContain('CRAWLEE_STORAGE_DIR='); // the check below must not be skipped silently on macOS
    if (envLine.includes('CRAWLEE_STORAGE_DIR=')) {
      expect(envLine).toContain('RBA_WORKER_BIND_HOST=127.0.0.1');
      expect(envLine).not.toContain('RBA_WORKER_TEST_MODE');
      expect(envLine).not.toContain('APIFY_TOKEN');
      expect(envLine).not.toContain('RBA_ENCRYPTION_KEY');
      expect(envLine).not.toContain('RBA_ENV_FILE');
      for (const sec of h.secrets) expect(envLine).not.toContain(sec);
    }
    // Chromium runs with a temporary profile, never the personal Chrome profile.
    const chromeArgs = descendants(pid)
      .map((p) => sh('ps', ['-o', 'command=', '-p', String(p)]))
      .filter((c) => /--user-data-dir=/.test(c));
    expect(chromeArgs.length).toBeGreaterThan(0);
    for (const c of chromeArgs) {
      expect(c).not.toMatch(/Library\/Application Support\/Google\/Chrome|\.config\/google-chrome/);
      expect(c).toMatch(/--user-data-dir=\S*(playwright|\/tmp\/|\/var\/folders\/|\/e2e-)/);
    }

    const before = h.catalog.hits.length;
    expect((await navigate(h, s.data.sessionId, h.catalog.url('/catalog?cat=kitchen'))).isError).toBe(false);
    expect(h.catalog.hits.slice(before).every((x) => x.uaClass === 'browser')).toBe(true);
    await h.call('session_close', { sessionId: s.data.sessionId });
    expect(await waitFor(() => !alive(pid), 15_000)).toBe(true);
    expect(await waitFor(() => leftoverLocalRuns(h.dataDir).length === 0, 10_000)).toBe(true);
    expect(h.q(`SELECT id FROM usage WHERE provider = 'local'`)).toEqual([]);
  });

  // Regression for LOCAL-NAV-RACE (found by this suite on d6f3f7e, fixed in 54ddc3c): the disabled
  // egress check no longer navigates the browser, so the first navigate cannot be interrupted.
  it('local: the first browser_navigate right after session_start succeeds (LOCAL-NAV-RACE regression)', async () => {
    const s = await h.call('session_start', { mode: 'local' });
    try {
      const n = await h.call('browser_navigate', { sessionId: s.data.sessionId, url: h.catalog.url('/catalog?cat=tools') });
      expect(n.isError, n.raw).toBe(false);
    } finally {
      await h.call('session_close', { sessionId: s.data.sessionId });
    }
  });

  it('teardown: no orphaned workers', async () => {
    expect(await h.stopServer()).toBe(0);
    expect(liveFakeRuns(h.apify)).toEqual([]);
    expect(leftoverLocalRuns(h.dataDir)).toEqual([]);
  });
});

describe('modes: no fallback when a mode is unavailable', () => {
  it('no remote provider configured: remote modes give config_missing and no local worker starts; local still works', async () => {
    const h = await startE2E({ remote: false });
    try {
      for (const args of [{ mode: 'remote_direct' }, { mode: 'remote_proxy', proxy: { kind: 'datacenter' } }, {}]) {
        const r = await h.call('session_start', args);
        expect(r.isError, r.raw).toBe(true);
        expect(r.data.error.code).toBe('config_missing');
        expect(r.data.error.message).toMatch(/Not falling back to local/);
      }
      expect(h.q('SELECT id FROM sessions')).toEqual([]);
      expect(leftoverLocalRuns(h.dataDir)).toEqual([]);
      const s = await h.call('session_start', { mode: 'local' });
      expect(s.isError, s.raw).toBe(false);
      await h.call('session_close', { sessionId: s.data.sessionId });
    } finally {
      await h.close();
    }
  });

  it('local without the worker build: config_missing and no remote run', async () => {
    // A copy of dist/ in a root with no actor/ build (node_modules linked for imports).
    const root = mkdtempSync(join(tmpdir(), 'rba-e2e-nobuild-'));
    cpSync(join(ROOT, 'dist'), join(root, 'dist'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const h = await startE2E({ serverMain: join(root, 'dist/src/mcp/index.js') });
    try {
      const r = await h.call('session_start', { mode: 'local' });
      expect(r.isError, r.raw).toBe(true);
      expect(r.data.error.code).toBe('config_missing');
      expect(r.data.error.message).toMatch(/Not falling back to a remote worker/);
      expect(h.apify!.state.runStarts).toBe(0);
      // Refused before any session row is written (requireProvider checks unavailableReason), never moved to a remote run.
      expect(h.q('SELECT id FROM sessions')).toEqual([]);
    } finally {
      await h.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
