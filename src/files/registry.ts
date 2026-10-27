/**
 * Protected file registry. Imported files are COPIED into data/files/ (0700
 * directory, 0600 files) under generated names; the original is never
 * modified. Generated (sanitized) copies live beside them. Results never expose
 * absolute paths; callers refer to files by artifact id.
 *
 * Import safety:
 *  - only from RBA_IMPORT_ROOTS (realpath of root and target, prefix check with
 *    the path separator) or from the local dashboard's file picker;
 *  - opened with O_NOFOLLOW and checked through the opened descriptor (regular
 *    file, size cap), so a symlink swapped in after the path check cannot win;
 *  - format detected from magic bytes, never from the extension.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import type { Config } from '../core/config.js';
import { nowIso, type Db } from '../core/db.js';
import { RbaError } from '../core/errors.js';
import { registerPrivatePathPrefix } from './exec.js';
import { capabilities, detectFormat, type Capabilities, type FileFormat } from './formats.js';

export type FileOrigin = 'imported' | 'sanitized';

export interface FileRow {
  id: string;
  display_name: string;
  format: FileFormat;
  mime: string;
  origin: FileOrigin;
  source_id: string | null;
  size: number;
  sha256: string;
  rel_path: string;
  status: 'ready' | 'deleted';
  policy: string | null;
  verdict: string | null;
  report_json: string | null;
  policy_version?: number | null;
  verification_id?: string | null;
  report_digest?: string | null;
  verified_at?: string | null;
  locked_by: string | null;
  lock_expires: number | null;
  created_at: string;
  deleted_at: string | null;
}

export interface FileView {
  artifactId: string;
  displayName: string;
  format: FileFormat;
  mime: string;
  origin: FileOrigin;
  sourceArtifactId: string | null;
  size: number;
  sha256: string;
  capabilities: Capabilities;
  policy: string | null;
  verification: string | null;
  createdAt: string;
  inUse: boolean;
}

export function newFileId(): string {
  return `file_${randomBytes(8).toString('hex')}`;
}

/** Safe display name: no directories, control characters or leading dots; bounded length. */
export function sanitizeDisplayName(name: string): string {
  let n = basename(String(name).replace(/\\/g, '/'));
  n = n.replace(/[\x00-\x1f\x7f]/g, '').replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!n || n === '.' || n === '..') n = 'file';
  if (n.startsWith('.')) n = `_${n.slice(1)}`;
  return n.slice(0, 120);
}

/** Test-only hooks (never set in production code). */
export const registryTestHooks: { beforeOpen?: () => void; afterFirstChunk?: () => void } = {};

export class FileRegistry {
  readonly dir: string;
  readonly tmpDir: string;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {
    this.dir = join(cfg.dataDir, 'files');
    this.tmpDir = join(this.dir, 'tmp');
    for (const d of [this.dir, this.tmpDir]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      chmodSync(d, 0o700);
    }
    registerPrivatePathPrefix(cfg.dataDir);
    try {
      registerPrivatePathPrefix(realpathSync(cfg.dataDir));
    } catch {
      /* keep the configured form */
    }
    registerPrivatePathPrefix(process.env.HOME);
  }

  get maxBytes(): number {
    return this.cfg.files.maxImportBytes;
  }

  private lastSweep = 0;

  /**
   * Opportunistic temp sweep for long-running servers (startup alone is not
   * enough): at most every 10 minutes, removes temp leftovers older than an hour.
   */
  sweepTmpIfDue(now = Date.now()): number {
    if (now - this.lastSweep < 10 * 60_000) return 0;
    this.lastSweep = now;
    return this.cleanTmp();
  }

  /** Remove leftovers of interrupted operations (temp files older than maxAgeMs). */
  cleanTmp(maxAgeMs = 60 * 60_000): number {
    let n = 0;
    for (const f of readdirSync(this.tmpDir)) {
      const p = join(this.tmpDir, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) {
          rmSync(p, { force: true, recursive: true });
          n++;
        }
      } catch {
        /* gone */
      }
    }
    return n;
  }

  /** A fresh private temp path (caller removes it). */
  tmpPath(ext: string): string {
    return join(this.tmpDir, `${randomBytes(8).toString('hex')}.${ext}`);
  }

  // ---------------------------------------------------------------- import

  /** Resolve a requested path against RBA_IMPORT_ROOTS (realpath + separator-aware prefix check). */
  resolveImportPath(requested: string): string {
    const roots = this.cfg.files.importRoots;
    if (roots.length === 0) {
      throw new RbaError(
        'config_missing',
        'No import roots configured. Either set RBA_IMPORT_ROOTS in .env to the folder(s) you want to import from, or use the local dashboard file picker (npm run dashboard -- --open, Files page). A webpage or email cannot grant file access.',
      );
    }
    let real: string;
    try {
      real = realpathSync(requested);
    } catch {
      throw new RbaError('not_found', 'file not found (or not readable)');
    }
    const ok = roots.some((r) => {
      let rr: string;
      try {
        rr = realpathSync(r);
      } catch {
        return false;
      }
      return real === rr || real.startsWith(rr.endsWith(sep) ? rr : rr + sep);
    });
    if (!ok) throw new RbaError('forbidden', 'file is outside RBA_IMPORT_ROOTS (symlinks are resolved before this check)');
    return real;
  }

  insideRoots(real: string): boolean {
    return this.cfg.files.importRoots.some((r) => {
      let rr: string;
      try {
        rr = realpathSync(r);
      } catch {
        return false;
      }
      return real === rr || real.startsWith(rr.endsWith(sep) ? rr : rr + sep);
    });
  }

  /** Import from a path inside an import root. */
  importPath(requested: string, displayName?: string): FileView {
    const real = this.resolveImportPath(requested);
    let fd: number;
    registryTestHooks.beforeOpen?.();
    try {
      // O_NOFOLLOW: refuse if the final component became a symlink after realpath.
      // O_NONBLOCK: opening a FIFO for reading would otherwise block until a writer
      // appears (a pipe in an import root must not hang the server); it has no
      // effect on reads from regular files.
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new RbaError('forbidden', 'file could not be opened safely (symlink or permission)');
    }
    try {
      // BigInt stats: nanosecond mtime/ctime for the snapshot comparison below
      // (float milliseconds would hide changes within the same millisecond).
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) throw new RbaError('invalid_input', 'not a regular file (devices, FIFOs, sockets and directories are refused)');
      // Hard links can make a file outside the roots appear inside one.
      if (st.nlink > 1n) throw new RbaError('forbidden', 'file has multiple hard links; refused (copy it into the import folder instead)');
      // Identity check after opening: the opened descriptor must be the single-link file
      // that an in-root path resolves to NOW. A parent directory swapped before the
      // open (and back) or a hard link cannot satisfy dev/ino + nlink 1 for a file
      // outside the roots. On Linux the descriptor's own path is checked as well.
      const again = this.resolveImportPath(requested);
      const st2 = statSync(again, { bigint: true });
      if (st2.dev !== st.dev || st2.ino !== st.ino) throw new RbaError('forbidden', 'the opened file is not the file at the requested path inside the import root; refused');
      if (process.platform === 'linux') {
        let fdPath = '';
        try {
          fdPath = readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          fdPath = '';
        }
        if (fdPath && !this.insideRoots(fdPath)) throw new RbaError('forbidden', 'the opened descriptor is outside RBA_IMPORT_ROOTS; refused');
      }
      const size = Number(st.size);
      if (size > this.maxBytes) throw new RbaError('invalid_input', `file is ${size} bytes; the limit is ${this.maxBytes} (RBA_MAX_IMPORT_MB)`);
      if (size === 0) throw new RbaError('invalid_input', 'file is empty');
      const tmp = this.tmpPath('part');
      const out = openSync(tmp, 'wx', 0o600);
      const hash = createHash('sha256');
      const head = Buffer.alloc(Math.min(size, 65536));
      let headLen = 0;
      let total = 0;
      try {
        const buf = Buffer.alloc(1 << 20);
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, null);
          if (n === 0) break;
          total += n;
          if (total > this.maxBytes) throw new RbaError('invalid_input', `file grew beyond the limit (${this.maxBytes} bytes) while reading`);
          if (headLen < head.length) {
            const take = Math.min(n, head.length - headLen);
            buf.copy(head, headLen, 0, take);
            headLen += take;
          }
          hash.update(buf.subarray(0, n));
          writeFileSync(out, buf.subarray(0, n));
          if (total === n) registryTestHooks.afterFirstChunk?.();
        }
      } catch (e) {
        closeSync(out);
        rmSync(tmp, { force: true });
        throw e;
      }
      closeSync(out);
      // Snapshot consistency: everything was validated, hashed and copied from this one
      // descriptor; reject if the file changed while it was read.
      const st3 = fstatSync(fd, { bigint: true });
      if (total !== size || st3.size !== st.size || st3.mtimeNs !== st.mtimeNs || st3.ctimeNs !== st.ctimeNs || st3.ino !== st.ino || st3.dev !== st.dev) {
        rmSync(tmp, { force: true });
        throw new RbaError('conflict', 'the file changed while it was being imported (size, modification or identity changed); refused. Import it again once it is no longer being written.');
      }
      return this.commit(tmp, head.subarray(0, headLen), total, hash.digest('hex'), displayName ?? basename(real), 'imported', null, null, null, null);
    } finally {
      closeSync(fd);
    }
  }

  /** Import bytes chosen by the user in the local dashboard. */
  importBuffer(buf: Buffer, displayName: string): FileView {
    if (buf.length === 0) throw new RbaError('invalid_input', 'file is empty');
    if (buf.length > this.maxBytes) throw new RbaError('invalid_input', `file is ${buf.length} bytes; the limit is ${this.maxBytes} (RBA_MAX_IMPORT_MB)`);
    const tmp = this.tmpPath('part');
    writeFileSync(tmp, buf, { mode: 0o600, flag: 'wx' });
    return this.commit(tmp, buf.subarray(0, 65536), buf.length, createHash('sha256').update(buf).digest('hex'), displayName, 'imported', null, null, null, null);
  }

  /** Promote a finished temp file to an artifact (atomic rename inside data/files). */
  commit(
    tmp: string,
    head: Buffer,
    size: number,
    sha256: string,
    displayName: string,
    origin: FileOrigin,
    sourceId: string | null,
    policy: string | null,
    verdict: string | null,
    report: unknown,
  ): FileView {
    const info = detectFormat(head);
    const id = newFileId();
    const rel = `${id}.${info.ext}`;
    renameSync(tmp, join(this.dir, rel));
    chmodSync(join(this.dir, rel), 0o600);
    this.db.run(
      `INSERT INTO files (id, display_name, format, mime, origin, source_id, size, sha256, rel_path, status, policy, verdict, report_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
      id,
      sanitizeDisplayName(displayName),
      info.format,
      info.mime,
      origin,
      sourceId,
      size,
      sha256,
      rel,
      policy,
      verdict,
      report === null ? null : JSON.stringify(report),
      nowIso(),
    );
    if (report !== null) this.setVerificationFields(id, report);
    return this.view(this.row(id));
  }

  // ---------------------------------------------------------------- access

  row(id: string): FileRow {
    const r = this.db.get<FileRow>('SELECT * FROM files WHERE id = ?', id);
    if (!r || r.status === 'deleted') throw new RbaError('not_found', `file artifact ${id} not found`);
    return r;
  }

  /** Absolute path (internal use only; never returned to the model). */
  absPath(r: FileRow): string {
    return join(this.dir, r.rel_path);
  }

  view(r: FileRow): FileView {
    return {
      artifactId: r.id,
      displayName: r.display_name,
      format: r.format,
      mime: r.mime,
      origin: r.origin,
      sourceArtifactId: r.source_id,
      size: r.size,
      sha256: r.sha256,
      capabilities: capabilities(r.format),
      policy: r.policy,
      verification: r.verdict,
      createdAt: r.created_at,
      inUse: this.isLocked(r),
    };
  }

  list(): FileView[] {
    return this.db.all<FileRow>(`SELECT * FROM files WHERE status = 'ready' ORDER BY created_at DESC LIMIT 200`).map((r) => this.view(r));
  }

  /** Re-hash the stored copy (detects tampering or corruption of plugin storage). */
  rehash(r: FileRow): string {
    const p = this.absPath(r);
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const h = createHash('sha256');
      const buf = Buffer.alloc(1 << 20);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        h.update(buf.subarray(0, n));
      }
      return h.digest('hex');
    } finally {
      closeSync(fd);
    }
  }

  updateVerification(id: string, verdict: string, report: unknown): void {
    this.db.run('UPDATE files SET verdict = ?, report_json = ? WHERE id = ?', verdict, JSON.stringify(report), id);
    this.setVerificationFields(id, report);
  }

  /** Mirror the versioned verification fields (v5 columns) from a stored report. */
  setVerificationFields(id: string, report: unknown): void {
    const v = (report as { verification?: { policyVersion?: number; verificationId?: string; verifiedAt?: string } } | null)?.verification;
    if (!v) return;
    this.db.run('UPDATE files SET policy_version = ?, verification_id = ?, verified_at = ? WHERE id = ?', v.policyVersion ?? null, v.verificationId ?? null, v.verifiedAt ?? null, id);
  }

  // ---------------------------------------------------------------- locks

  isLocked(r: FileRow): boolean {
    return !!r.locked_by && (r.lock_expires ?? 0) > Date.now();
  }

  /** Exclusive use (e.g. an upload in progress). Atomic; expires so a crash cannot pin a file forever. */
  lock(id: string, holder: string, ttlMs = 15 * 60_000): void {
    this.db.tx(() => {
      const r = this.row(id);
      if (this.isLocked(r) && r.locked_by !== holder) throw new RbaError('conflict', `file ${id} is in use by ${r.locked_by}`);
      this.db.run('UPDATE files SET locked_by = ?, lock_expires = ? WHERE id = ?', holder, Date.now() + ttlMs, id);
    });
  }

  unlock(id: string, holder: string): void {
    this.db.run('UPDATE files SET locked_by = NULL, lock_expires = NULL WHERE id = ? AND locked_by = ?', id, holder);
  }

  /**
   * Delete the plugin's copy. Refused while in use. This removes the stored file
   * (an ordinary unlink, not forensic erasure) and does not affect copies already
   * uploaded anywhere.
   */
  delete(id: string): { deleted: string; derivedStillPresent: string[] } {
    return this.db.tx(() => {
      const r = this.row(id);
      if (this.isLocked(r)) throw new RbaError('conflict', `file ${id} is in use by ${r.locked_by}; wait for it to finish or cancel that job`);
      const p = this.absPath(r);
      if (existsSync(p)) rmSync(p, { force: true });
      // Tombstone only: the original file name and the stored report (field names, findings)
      // are personal data and are not kept once the copy is gone. The hash stays so a
      // repeat upload of identical bytes is still recognised.
      this.db.run(`UPDATE files SET status = 'deleted', deleted_at = ?, display_name = '[deleted]', report_json = NULL, locked_by = NULL, lock_expires = NULL WHERE id = ?`, nowIso(), id);
      const derived = this.db.all<{ id: string }>(`SELECT id FROM files WHERE source_id = ? AND status = 'ready'`, id).map((x) => x.id);
      return { deleted: id, derivedStillPresent: derived };
    });
  }
}
