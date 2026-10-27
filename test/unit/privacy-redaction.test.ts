import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { redact, safeUrl } from '../../src/core/redact.js';
import { registerPrivatePathPrefix, scrubPaths } from '../../src/files/exec.js';
import { testCtx } from '../helpers/ctx.js';

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('redaction of credential-shaped URL parameters', () => {
  it('covers *_token, client_secret, signatures and fragment tokens', () => {
    const s = redact(
      'https://a.test/cb?access_token=AT_CANARY_1&id_token=IDT_CANARY_2&refresh_token=RT_CANARY_3&client_secret=CS_CANARY_4&X-Amz-Signature=SIG_CANARY_5&session_id=SID_CANARY_6 ' +
        'https://b.test/#access_token=FRAG_CANARY_7&state=keep',
    );
    for (const c of ['AT_CANARY_1', 'IDT_CANARY_2', 'RT_CANARY_3', 'CS_CANARY_4', 'SIG_CANARY_5', 'SID_CANARY_6', 'FRAG_CANARY_7']) expect(s).not.toContain(c);
    expect(s).toContain('state=keep');
    expect(s).toContain('access_token=[REDACTED]');
  });

  it('safeUrl still hides any query', () => {
    expect(safeUrl('https://a.test/x?access_token=abc')).toBe('https://a.test/x?[query]');
  });
});

describe('tool-message path scrubbing', () => {
  it('removes absolute paths whose directories contain spaces', () => {
    expect(scrubPaths('file:/Users/alice/My Docs/rba data/files/tmp/ab.jpg: Invalid data')).toBe('ab.jpg: Invalid data');
    expect(scrubPaths('/opt/x/y.png | Error')).toBe('y.png | Error');
  });

  it('removes registered private prefixes first', () => {
    registerPrivatePathPrefix('/Volumes/Some Disk/CANARY DIR/data');
    const out = scrubPaths('pdfinfo: Syntax Error: /Volumes/Some Disk/CANARY DIR/data/files/tmp/1.pdf (0)');
    expect(out).not.toContain('CANARY DIR');
    expect(out).not.toContain('/Volumes');
  });
});

describe('at-rest permissions and import snapshot', () => {
  it('database sidecars are 0600', () => {
    const ctx = testCtx();
    made.push(join(ctx.cfg.dataDir, '..'));
    ctx.db.log('info', 'x');
    for (const f of ['registry.sqlite', 'registry.sqlite-wal', 'registry.sqlite-shm']) {
      let mode: number | null = null;
      try {
        mode = statSync(join(ctx.cfg.dataDir, f)).mode & 0o777;
      } catch {
        mode = null; // sidecar not created on this platform
      }
      if (mode !== null && f !== 'registry.sqlite') {
        // created by SQLite with the umask; chmodded at open when present
        expect([0o600]).toContain(mode);
      }
      if (f === 'registry.sqlite') expect(mode).toBe(0o600);
    }
    ctx.db.close();
  });

  it('deleting an artifact keeps only a tombstone (no file name, no report)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rba-privacy-'));
    made.push(root);
    const ctx = testCtx({ RBA_IMPORT_ROOTS: root });
    made.push(join(ctx.cfg.dataDir, '..'));
    mkdirSync(join(root, 'sub'), { recursive: true });
    const p = join(root, 'sub', 'CANARY_FN_passport.png');
    writeFileSync(p, Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'));
    const v = ctx.files.importPath(p);
    ctx.files.delete(v.artifactId);
    const row = ctx.db.get<{ display_name: string; report_json: string | null; sha256: string }>('SELECT display_name, report_json, sha256 FROM files WHERE id = ?', v.artifactId)!;
    expect(row.display_name).toBe('[deleted]');
    expect(row.report_json).toBeNull();
    expect(row.sha256).toBe(v.sha256);
    ctx.db.close();
  });
});
