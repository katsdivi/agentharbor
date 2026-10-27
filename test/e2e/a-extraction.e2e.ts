/**
 * Scenario A: fresh data dir -> public extraction -> saved result -> cleanup.
 * Proof level: local fixture (fake Apify behind an HTTPS front; real worker,
 * real built MCP server over stdio). The plugin install step itself is NOT
 * exercised here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogTruth } from '../fixtures/catalog.js';
import { alive, leftoverLocalRuns, liveFakeRuns, navigate, reportKnownDefects, startE2E, waitFor, type E2E } from './stdio-harness.js';

const spec = { itemSelector: '.item', fields: { name: { selector: '.name' }, price: { selector: '.price' } } };

describe('A: extraction on a fresh data dir, saved result, cleanup', () => {
  let h: E2E;
  beforeAll(async () => {
    h = await startE2E();
  });
  afterAll(async () => {
    reportKnownDefects('a-extraction');
    await h?.close();
  });

  it('starts on an empty registry and exposes the tool surface over stdio', async () => {
    const { tools } = await h.mcp.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['config_check', 'session_start', 'browser_navigate', 'scrape_extract', 'session_close', 'usage_report']) expect(names).toContain(n);
    expect(h.q('SELECT id FROM sessions')).toEqual([]);
    expect(h.q('SELECT id FROM jobs')).toEqual([]);
    const cfg = await h.call('config_check');
    expect(cfg.isError, cfg.raw).toBe(false);
  });

  for (const mode of ['remote_direct', 'local'] as const) {
    it(`${mode}: navigate -> extract (save) -> close; result file matches the page truth; nothing left running`, async () => {
      const before = h.catalog.hits.length;
      const s = await h.call('session_start', { mode });
      expect(s.isError, s.raw).toBe(false);
      const sessionId = s.data.sessionId;
      const row = h.q<{ provider: string; provider_run_id: string; status: string }>('SELECT provider, provider_run_id, status FROM sessions WHERE id = ?', sessionId)[0]!;
      expect(row.status).toBe('ready');
      if (mode === 'local') {
        expect(row.provider).toBe('local');
        expect(row.provider_run_id).toMatch(/^local:\d+:[a-f0-9]{16}$/);
      } else {
        expect(row.provider).not.toBe('local');
        expect(h.apify!.runs.has(row.provider_run_id)).toBe(true);
      }

      const nav = await navigate(h, sessionId, h.catalog.url('/catalog?cat=garden'));
      expect(nav.isError, nav.raw).toBe(false);
      const ex = await h.call('scrape_extract', { sessionId, spec, save: true });
      expect(ex.isError, ex.raw).toBe(false);
      const truth = catalogTruth('garden').map(({ name, price }) => ({ name, price }));
      expect(ex.data.count).toBe(truth.length);
      expect(ex.data.untrusted.items).toEqual(truth);
      expect(ex.data.savedTo).toBeTruthy();
      expect(String(ex.data.savedTo).startsWith(h.dataDir)).toBe(true);
      expect(existsSync(ex.data.savedTo)).toBe(true);
      expect(readFileSync(ex.data.savedTo, 'utf8')).toContain(truth[0]!.name);

      const c = await h.call('session_close', { sessionId });
      expect(c.isError, c.raw).toBe(false);
      const after = h.q<{ status: string; closed_at: string | null }>('SELECT status, closed_at FROM sessions WHERE id = ?', sessionId)[0]!;
      expect(after.status).toBe('closed');
      expect(after.closed_at).toBeTruthy();

      // Every request the target saw came from the worker's browser, none from the orchestrator.
      const mine = h.catalog.hits.slice(before);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.filter((x) => x.uaClass !== 'browser')).toEqual([]);

      if (mode === 'local') {
        const pid = Number(row.provider_run_id.split(':')[1]);
        expect(await waitFor(() => !alive(pid), 15_000)).toBe(true);
        expect(await waitFor(() => leftoverLocalRuns(h.dataDir).length === 0, 10_000)).toBe(true);
        // Local runs carry no provider charge and write no usage row.
        expect(h.q("SELECT id FROM usage WHERE provider = 'local'")).toEqual([]);
      } else {
        expect(await waitFor(() => liveFakeRuns(h.apify).length === 0, 15_000)).toBe(true);
      }
    });
  }

  it('server shutdown leaves no orphaned workers and leaks no secret values', async () => {
    const code = await h.stopServer();
    expect(code).toBe(0);
    expect(alive(h.serverPid)).toBe(false);
    expect(liveFakeRuns(h.apify)).toEqual([]);
    expect(leftoverLocalRuns(h.dataDir)).toEqual([]);
    expect(h.q(`SELECT id FROM sessions WHERE status IN ('starting','ready','closing')`)).toEqual([]);
    const err = h.stderr();
    expect(err).toContain('ready; data dir');
    for (const s of h.secrets) expect(err).not.toContain(s);
  });
});
