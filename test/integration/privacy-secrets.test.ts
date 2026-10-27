/**
 * Secret scan: grep-able canary values are injected into credentials, browser
 * state, URLs, file metadata, file names and the data path, a realistic flow
 * is run through the MCP server (fake Apify worker + fixture site), and every
 * response, the SQLite database (main file and WAL), the files under the data
 * directory (except the stored artifact copies) and this process's
 * stdout/stderr are scanned for them. Each canary also has a positive control
 * so the scan cannot pass vacuously.
 *
 * Not covered here: PNG screenshots (pixels cannot be text-scanned; password
 * fields are masked by the worker), the remote worker's own run log (it runs
 * in a separate process), and exported operations (W1).
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';
import { HAVE_FFMPEG, SECRET_VALUES, makeJpeg } from '../fixtures/media.js';

const CANARY = {
  password: 'CANARY_PW_7Qx!r2zz',
  cookie: 'CANARY_COOKIE_91af3c',
  localStorage: 'CANARY_LS_5b7d21',
  accessToken: 'CANARY_AT_55e0aa77',
  fileName: 'CANARY_FN_passport',
  pathSegment: 'CANARY DIR',
};

/** All encodings a value could be stored in. */
function needles(v: string): Buffer[] {
  return [Buffer.from(v, 'utf8'), Buffer.from(v, 'utf16le'), Buffer.from(v, 'utf16le').swap16()];
}
const contains = (hay: Buffer | string, v: string) => {
  const b = typeof hay === 'string' ? Buffer.from(hay, 'utf8') : hay;
  return needles(v).some((n) => b.includes(n));
};

function walk(dir: string, skip: (p: string) => boolean, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (skip(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, skip, out);
    else out.push(p);
  }
  return out;
}

describe.skipIf(!HAVE_FFMPEG)('secret scan: canaries never reach responses, logs, the database or plugin files', () => {
  let h: Harness;
  let root: string;
  const responses: Array<{ tool: string; raw: string }> = [];
  const stdio: string[] = [];
  const restore: Array<() => void> = [];
  let call: (tool: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any; raw: string }>;

  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), 'rba-secrets-'));
    root = join(base, CANARY.pathSegment, 'import root');
    mkdirSync(root, { recursive: true });
    for (const s of [process.stdout, process.stderr]) {
      const orig = s.write.bind(s);
      (s as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
        stdio.push(String(chunk));
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      };
      restore.push(() => ((s as unknown as { write: unknown }).write = orig));
    }
    h = await startHarness({ vars: { RBA_IMPORT_ROOTS: root, RBA_DATA_DIR: join(base, CANARY.pathSegment, 'data') } });
    call = async (tool, args = {}) => {
      const r = await h.call(tool, args);
      responses.push({ tool, raw: r.raw });
      return r;
    };
  });
  afterAll(async () => {
    for (const r of restore) r();
    await h?.close();
  });

  it('runs a realistic flow with canaries in every sensitive place', async () => {
    // --- account with password and saved browser state
    const email = 'canary-user@example.test';
    h.site.state.accounts.set(email, { email, password: CANARY.password, name: 'x', verified: true });
    const acct = h.ctx.accounts.create({ targetOrigin: h.site.origin, email, proxyMode: 'direct', status: 'active' });
    h.ctx.accounts.setCredentials(acct.id, { password: CANARY.password });
    h.ctx.accounts.saveState(acct.id, {
      cookies: [{ name: 'pref', value: CANARY.cookie, domain: new URL(h.site.origin).hostname, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [{ origin: h.site.origin, localStorage: [{ name: 'k', value: CANARY.localStorage }] }],
    });
    await call('account_list');
    const s = await call('session_start', { accountId: acct.id, mode: 'remote_direct' });
    expect(s.isError, s.raw).toBe(false);
    const sid = s.data.sessionId;
    await call('browser_navigate', { sessionId: sid, url: h.site.url('/login') });
    await call('browser_fill', { sessionId: sid, selector: '#email', secret: 'account_email' });
    await call('browser_fill', { sessionId: sid, selector: '#password', secret: 'account_password' });
    await call('browser_click', { sessionId: sid, selector: '#login' });
    // positive control: the password really reached the site (so its absence below is meaningful)
    expect([...h.site.state.sessions.values()]).toContain(email);
    await call('browser_inspect', { sessionId: sid, includeText: true });
    await call('browser_navigate', { sessionId: sid, url: `${h.site.url('/products')}?access_token=${CANARY.accessToken}&page=2` });
    await call('browser_screenshot', { sessionId: sid });
    await call('session_status', { sessionId: sid });
    await call('session_close', { sessionId: sid });
    await call('run_report', { sessionId: sid });

    // --- a file whose metadata, name and path carry canaries
    const src = join(root, `${CANARY.fileName}.jpg`);
    copyFileSync(makeJpeg(root), src);
    const imp = await call('file_import', { path: src });
    expect(imp.isError, imp.raw).toBe(false);
    await call('file_inspect', { artifactId: imp.data.artifactId });
    await call('media_inspect', { artifactId: imp.data.artifactId });
    const san = await call('media_sanitize', { artifactId: imp.data.artifactId, waitSecs: 90 });
    const sj = san.data.status === 'completed' ? san.data : (await call('job_status', { jobId: san.data.jobId, waitSecs: 60 })).data;
    const out = sj.result.outputArtifact.artifactId;
    const ver = await call('media_verify', { artifactId: out });
    const refused = await call('portal_upload', { artifactId: out, targetUrl: h.site.url('/upload'), mode: 'remote_direct', fileInputSelector: '#file', submitSelector: '#upload-submit', requireSanitized: true });
    expect(refused.data.error.details.needsDecision).toBe('acceptRetainedFindings');
    const before = h.site.state.uploads.length;
    const up = await call('portal_upload', {
      artifactId: out,
      targetUrl: h.site.url('/upload'),
      mode: 'remote_direct',
      fileInputSelector: '#file',
      submitSelector: '#upload-submit',
      confirmation: { selector: '#upload-result' },
      requireSanitized: true,
      acceptRetainedFindings: ver.data.acceptanceDigest,
      waitSecs: 90,
    });
    const uj = up.data.status === 'completed' ? up.data : (await call('job_status', { jobId: up.data.jobId, waitSecs: 60 })).data;
    expect(uj.result?.outcome, JSON.stringify(uj)).toBe('portal_confirmed');
    expect(h.site.state.uploads[before]!.filename).toBe('upload.jpg');
    await call('job_results', { jobId: up.data.jobId ?? uj.jobId });
    await call('run_report', { jobId: up.data.jobId ?? uj.jobId });

    // --- error paths: a corrupt file whose tool errors mention the (canary) data path
    const bad = join(root, 'corrupt.jpg');
    writeFileSync(bad, readFileSync(src).subarray(0, 300));
    const bimp = await call('file_import', { path: bad });
    const bs = await call('media_sanitize', { artifactId: bimp.data.artifactId, waitSecs: 90 });
    if (!['failed', 'completed'].includes(bs.data.status)) await call('job_status', { jobId: bs.data.jobId, waitSecs: 60 });
    await call('file_import', { path: join(root, '..', 'outside.jpg') });
    await call('config_check');
  }, 240_000);

  it('secret canaries appear in no MCP response, no database byte, no plugin file and no log output', () => {
    const cfg = h.ctx.cfg;
    const secrets: Record<string, string> = {
      password: CANARY.password,
      cookie: CANARY.cookie,
      localStorage: CANARY.localStorage,
      accessToken: CANARY.accessToken,
      apifyToken: cfg.apify.token!,
      mailslurpKey: cfg.mailslurp.apiKey!,
      dashboardToken: cfg.dashboard.token!,
      encryptionKey: cfg.encryptionKey!.toString('base64'),
    };
    // positive controls: the encrypted state really holds the cookie and the account the password
    expect(JSON.stringify(h.ctx.accounts.loadState(h.ctx.db.get<{ id: string }>('SELECT id FROM accounts')!.id))).toContain(CANARY.cookie);
    const dbBytes = ['registry.sqlite', 'registry.sqlite-wal'].map((f) => {
      try {
        return readFileSync(join(cfg.dataDir, f));
      } catch {
        return Buffer.alloc(0);
      }
    });
    const files = walk(cfg.dataDir, (p) => p.startsWith(join(cfg.dataDir, 'files')) || /registry\.sqlite/.test(p));
    // controls: the flow really produced responses, and the token URL really came back (redacted)
    expect(responses.length).toBeGreaterThan(20);
    expect(responses.some((r) => r.tool === 'browser_navigate' && /access_token=\[REDACTED\]|\?\[query\]/.test(r.raw))).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const [name, v] of Object.entries(secrets)) {
      for (const r of responses) if (contains(r.raw, v)) problems.push(`${name} in ${r.tool} response`);
      dbBytes.forEach((b, i) => contains(b, v) && problems.push(`${name} in database ${i ? 'WAL' : 'file'}`));
      for (const f of files) if (contains(readFileSync(f), v)) problems.push(`${name} in ${relative(cfg.dataDir, f)}`);
      if (contains(stdio.join(''), v)) problems.push(`${name} in stdout/stderr`);
    }
    expect(problems).toEqual([]);
  });

  it('the data and import paths never appear in responses or logs', () => {
    const leaks = responses.filter((r) => r.raw.includes(CANARY.pathSegment)).map((r) => r.tool);
    expect(leaks).toEqual([]);
    expect(h.ctx.db.all<{ message: string }>('SELECT message FROM logs').filter((l) => l.message.includes(CANARY.pathSegment))).toEqual([]);
    expect(h.ctx.db.all<{ error: string | null; result_json: string | null }>('SELECT error, result_json FROM jobs').filter((j) => `${j.error}${j.result_json}`.includes(CANARY.pathSegment))).toEqual([]);
  });

  it('metadata values stay out of non-detailed responses, reports, logs and the sanitized copy; the original keeps them (control)', () => {
    const values = Object.values(SECRET_VALUES).filter((v) => v.length >= 6);
    const original = h.ctx.db.get<{ id: string }>(`SELECT id FROM files WHERE origin = 'imported' AND display_name LIKE '${CANARY.fileName}%'`)!;
    const sanitized = h.ctx.db.get<{ id: string }>(`SELECT id FROM files WHERE origin = 'sanitized' AND source_id = ?`, original.id)!;
    const origBytes = readFileSync(h.ctx.files.absPath(h.ctx.files.row(original.id)));
    expect(contains(origBytes, SECRET_VALUES.artist)).toBe(true); // control
    const cleanBytes = readFileSync(h.ctx.files.absPath(h.ctx.files.row(sanitized.id)));
    const dbBytes = readFileSync(join(h.ctx.cfg.dataDir, 'registry.sqlite'));
    const problems: string[] = [];
    for (const v of values) {
      if (contains(cleanBytes, v)) problems.push(`"${v}" in sanitized copy`);
      for (const r of responses) if (contains(r.raw, v)) problems.push(`"${v}" in ${r.tool} response`);
      if (contains(dbBytes, v)) problems.push(`"${v}" in database`);
    }
    expect(problems).toEqual([]);
  });

  it('the file name stays out of what is sent and out of run reports (it is kept only as the local display name)', () => {
    expect(h.site.state.uploads.map((u) => u.filename).join(' ')).not.toContain(CANARY.fileName);
    for (const r of responses.filter((x) => x.tool === 'run_report' || x.tool === 'job_results' || x.tool === 'portal_upload')) expect(r.raw).not.toContain(CANARY.fileName);
    expect(responses.find((r) => r.tool === 'file_inspect')!.raw).toContain(CANARY.fileName); // control: shown locally
  });
});

describe('orchestrator sends no target requests', () => {
  /**
   * All browsing and operation HTTP runs inside the worker (/fetch, /capture), behind its
   * network policy. Outside the provider and email clients, src/** may only call fetch() in
   * the reviewed places below; anything new needs a policy review.
   */
  const ALLOWED: Array<[string, RegExp, string]> = [
    ['src/core/sessions.ts', /fetchImpl: typeof fetch = fetch/, 'WorkerClient: the session worker (provider container or local worker) only'],
    ['src/cli/deploy-actor.ts', /await fetch\(`\$\{base\}\$\{path\}`/, 'Apify API from the deploy CLI'],
  ];
  const PATTERNS = [/\bfetch\s*\(/, /=\s*fetch\b/, /\bhttps?\.(?:request|get)\s*\(/, /\bnet\.connect\s*\(/, /\btls\.connect\s*\(/, /new WebSocket\s*\(/, /from ['"](?:axios|undici|got|node-fetch|ws)['"]/];

  it('src/** (excluding providers/ and email/) calls no network client except the reviewed ones', () => {
    const repo = join(__dirname, '..', '..');
    const srcDir = join(repo, 'src');
    const offenders: string[] = [];
    for (const f of walk(srcDir, (p) => p.startsWith(join(srcDir, 'providers')) || p.startsWith(join(srcDir, 'email')))) {
      if (!f.endsWith('.ts')) continue;
      const rel = relative(repo, f);
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (!PATTERNS.some((p) => p.test(line))) return;
          if (ALLOWED.some(([file, re]) => file === rel && re.test(line))) return;
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

afterAll(() => {
  for (const d of readdirSync(tmpdir())) if (d.startsWith('rba-secrets-')) rmSync(join(tmpdir(), d), { recursive: true, force: true });
});
