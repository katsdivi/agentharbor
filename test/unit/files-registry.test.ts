import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startDashboard } from '../../src/dashboard/server.js';
import { detectFormat } from '../../src/files/formats.js';
import { testCtx } from '../helpers/ctx.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function setup(extra: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rba-files-'));
  const root = join(base, 'import-root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const ctx = testCtx({ RBA_IMPORT_ROOTS: root, RBA_MAX_IMPORT_MB: '0.05', ...extra });
  return { ctx, root, outside };
}

describe('file registry: import safety', () => {
  it('imports a copy from an import root; never returns absolute paths; original untouched', () => {
    const { ctx, root } = setup();
    const data = Buffer.concat([PNG_SIG, Buffer.from('rest-of-file')]);
    const p = join(root, 'photo.png');
    writeFileSync(p, data);
    const before = statSync(p).mtimeMs;
    const v = ctx.files.importPath(p);
    expect(v).toMatchObject({ format: 'png', mime: 'image/png', size: data.length, sha256: sha(data), displayName: 'photo.png', origin: 'imported' });
    expect(v.capabilities).toMatchObject({ sanitize: true, policy: 'image_metadata' });
    expect(JSON.stringify(v)).not.toContain(root);
    expect(readFileSync(p).equals(data)).toBe(true);
    expect(statSync(p).mtimeMs).toBe(before);
    const stored = ctx.files.absPath(ctx.files.row(v.artifactId));
    expect(readFileSync(stored).equals(data)).toBe(true);
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    expect(statSync(ctx.files.dir).mode & 0o777).toBe(0o700);
  });

  it('refuses paths outside the roots, traversal and symlink escapes', () => {
    const { ctx, root, outside } = setup();
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'top secret');
    expect(() => ctx.files.importPath(secret)).toThrow(/outside RBA_IMPORT_ROOTS/);
    expect(() => ctx.files.importPath(join(root, '..', 'outside', 'secret.txt'))).toThrow(/outside RBA_IMPORT_ROOTS/);
    symlinkSync(secret, join(root, 'link.txt'));
    expect(() => ctx.files.importPath(join(root, 'link.txt'))).toThrow(/outside RBA_IMPORT_ROOTS/);
    // A sibling folder whose name merely starts with the root's name is not inside it.
    mkdirSync(`${root}-evil`);
    writeFileSync(join(`${root}-evil`, 'x.png'), PNG_SIG);
    expect(() => ctx.files.importPath(join(`${root}-evil`, 'x.png'))).toThrow(/outside RBA_IMPORT_ROOTS/);
    // A hard link inside the root to a file outside it is refused.
    const outsideFile = join(outside, 'secret.png');
    writeFileSync(outsideFile, PNG_SIG);
    linkSync(outsideFile, join(root, 'hardlink.png'));
    expect(() => ctx.files.importPath(join(root, 'hardlink.png'))).toThrow(/hard links/);
  });

  it('tool error messages carry file names, not absolute paths', async () => {
    const { defaultRunner } = await import('../../src/files/exec.js');
    const { ctx } = setup();
    const missing = join(ctx.files.tmpDir, 'does-not-exist.mp4');
    await expect(defaultRunner('ffprobe', ['-v', 'error', `file:${missing}`], { timeoutMs: 10_000 })).rejects.toSatisfy((e: any) => !String(e.message).includes(ctx.files.tmpDir) && String(e.message).includes('does-not-exist.mp4'));
  });

  it('refuses special files, directories, empty and oversized files', () => {
    const { ctx, root } = setup();
    execFileSync('mkfifo', [join(root, 'pipe')]);
    expect(() => ctx.files.importPath(join(root, 'pipe'))).toThrow(/not a regular file|opened safely/);
    mkdirSync(join(root, 'dir'));
    expect(() => ctx.files.importPath(join(root, 'dir'))).toThrow(/not a regular file|opened safely/);
    writeFileSync(join(root, 'empty.bin'), '');
    expect(() => ctx.files.importPath(join(root, 'empty.bin'))).toThrow(/empty/);
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(60 * 1024)); // limit 0.05 MB
    expect(() => ctx.files.importPath(join(root, 'big.bin'))).toThrow(/limit/);
    expect(readdirSync(ctx.files.tmpDir)).toEqual([]); // nothing left behind
  });

  it('without import roots, path import is refused and the dashboard picker is suggested', () => {
    const ctx = testCtx({});
    expect(() => ctx.files.importPath('/etc/hosts')).toThrow(/RBA_IMPORT_ROOTS|dashboard/);
  });

  it('hostile file names are stored under generated names and shown sanitized', () => {
    const { ctx, root } = setup();
    const evil = '$(touch pwned); `id` | rm -rf ~ \n.png';
    writeFileSync(join(root, evil), PNG_SIG);
    const v = ctx.files.importPath(join(root, evil));
    expect(v.displayName).not.toMatch(/[\n|]/);
    expect(ctx.files.row(v.artifactId).rel_path).toMatch(/^file_[0-9a-f]{16}\.png$/);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });

  it('delete removes the copy, refuses while in use, and reports derived copies', () => {
    const { ctx, root } = setup();
    writeFileSync(join(root, 'a.png'), PNG_SIG);
    const v = ctx.files.importPath(join(root, 'a.png'));
    ctx.files.lock(v.artifactId, 'job_x');
    expect(() => ctx.files.lock(v.artifactId, 'job_y')).toThrow(/in use/);
    expect(() => ctx.files.delete(v.artifactId)).toThrow(/in use/);
    ctx.files.unlock(v.artifactId, 'job_x');
    const path = ctx.files.absPath(ctx.files.row(v.artifactId));
    expect(ctx.files.delete(v.artifactId)).toMatchObject({ deleted: v.artifactId });
    expect(existsSync(path)).toBe(false);
    expect(() => ctx.files.row(v.artifactId)).toThrow(/not found/);
  });

  it('detects formats from content, not the extension', () => {
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftyp' + brand + '\0\0\0\0isom')]);
    expect(detectFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).format).toBe('jpeg');
    expect(detectFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')).format).toBe('webp');
    expect(detectFormat(Buffer.from('RIFF\0\0\0\0WAVEfmt ')).format).toBe('wav');
    expect(detectFormat(Buffer.from('%PDF-1.7\n')).format).toBe('pdf');
    expect(detectFormat(ftyp('qt  ')).format).toBe('mov');
    expect(detectFormat(ftyp('M4A ')).format).toBe('m4a');
    expect(detectFormat(ftyp('isom')).format).toBe('mp4');
    expect(detectFormat(Buffer.from('II*\0')).format).toBe('tiff');
    expect(detectFormat(Buffer.from('#!/bin/sh\necho hi')).format).toBe('unknown');
  });
});

describe('dashboard file picker (explicit local selection)', () => {
  it('imports a chosen file with a valid CSRF token and refuses without it', async () => {
    const ctx = testCtx({ RBA_MAX_IMPORT_MB: '1' });
    const d = await startDashboard(ctx, 0);
    const port = Number(new URL(d.url).port);
    const http = (path: string, o: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}) =>
      new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
          let b = '';
          res.on('data', (x) => (b += x));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
        });
        r.on('error', reject);
        r.end(o.body);
      });
    try {
      const login = await http('/login', { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(ctx.cfg.dashboard.token!)}` });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const page = await http('/files', { headers: { Cookie: cookie } });
      const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
      const boundary = 'XyZBoundary123';
      const body = (token: string) =>
        Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${token}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pick.png"\r\nContent-Type: image/png\r\n\r\n`),
          PNG_SIG,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
      const post = (token: string) => http('/files/import', { method: 'POST', headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: body(token) });
      expect((await post('bad')).status).toBe(403);
      expect(ctx.files.list()).toHaveLength(0);
      expect((await post(csrf)).status).toBe(303);
      expect(ctx.files.list()).toMatchObject([{ displayName: 'pick.png', format: 'png', size: 8 }]);
      // Cross-origin page cannot submit it.
      const xo = await http('/files/import', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.test', 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: body(csrf) });
      expect(xo.status).toBe(403);
    } finally {
      await d.close();
    }
  });
});

describe('import snapshot consistency', () => {
  it('a file modified while it is being copied is rejected and nothing is kept', async () => {
    const { registryTestHooks } = await import('../../src/files/registry.js');
    const { ctx, root } = setup({ RBA_MAX_IMPORT_MB: '8' });
    const p = join(root, 'growing.png');
    writeFileSync(p, Buffer.concat([PNG_SIG, Buffer.alloc(3 * 1024 * 1024, 1)]));
    registryTestHooks.afterFirstChunk = () => writeFileSync(p, Buffer.from('changed!'), { flag: 'r+' });
    try {
      expect(() => ctx.files.importPath(p)).toThrow(/changed while it was being imported/);
    } finally {
      registryTestHooks.afterFirstChunk = undefined;
    }
    expect(ctx.files.list()).toEqual([]);
    expect(readdirSync(ctx.files.tmpDir)).toEqual([]);
  });

  it('a parent directory swapped to point outside the root between check and open is refused', async () => {
    const { registryTestHooks } = await import('../../src/files/registry.js');
    const { renameSync } = await import('node:fs');
    const { ctx, root, outside } = setup();
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'photo.png'), PNG_SIG);
    mkdirSync(join(outside, 'sub'));
    writeFileSync(join(outside, 'sub', 'photo.png'), Buffer.concat([PNG_SIG, Buffer.from('OUTSIDE-SECRET')]));
    registryTestHooks.beforeOpen = () => {
      // after the realpath check: swap root/sub for a symlink to outside/sub
      renameSync(join(root, 'sub'), join(root, 'sub-orig'));
      symlinkSync(join(outside, 'sub'), join(root, 'sub'));
    };
    try {
      expect(() => ctx.files.importPath(join(root, 'sub', 'photo.png'))).toThrow(/outside RBA_IMPORT_ROOTS|not the file at the requested path/);
    } finally {
      registryTestHooks.beforeOpen = undefined;
    }
    expect(ctx.files.list()).toEqual([]);
  });
});
