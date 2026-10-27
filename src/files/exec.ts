/**
 * Local tool runner and dependency doctor.
 *
 * Tools are run with execFile and an argument ARRAY (never a shell), a minimal
 * environment (no plugin secrets), a timeout, an output cap and an AbortSignal
 * (job cancellation kills the process). Binaries are looked up on PATH plus the
 * usual Homebrew/system locations; nothing is downloaded.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { RbaError } from '../core/errors.js';

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export type Runner = (bin: string, args: string[], o: { timeoutMs: number; signal?: AbortSignal; maxBuffer?: number }) => Promise<RunResult>;

/** Directories whose absolute paths must never appear in tool messages (data dir, home). */
const privatePrefixes = new Set<string>();

export function registerPrivatePathPrefix(p: string | null | undefined): void {
  if (p && p.length > 1) privatePrefixes.add(p.replace(/\/+$/, ''));
}

/**
 * Remove absolute paths from tool output, keeping only file names. Registered
 * prefixes (which may contain spaces, e.g. "~/My Docs/rba data") are removed
 * first; then any remaining absolute path of two or more segments is reduced
 * to its last segment (directory segments may contain spaces).
 */
export function scrubPaths(t: string): string {
  let out = t;
  for (const p of [...privatePrefixes].sort((a, b) => b.length - a.length)) {
    for (const v of [`file:${p}`, p]) out = out.split(`${v}/`).join('').split(v).join('[dir]');
  }
  return out.replace(/(?:file:)?\/(?:[^/'"|\n\r]+\/)+([^\s'":|/]+)/g, '$1');
}

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

const found = new Map<string, string | null>();

export function which(name: string): string | null {
  if (found.has(name)) return found.get(name)!;
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS];
  for (const d of dirs) {
    const p = join(d, name);
    try {
      accessSync(p, constants.X_OK);
      found.set(name, p);
      return p;
    } catch {
      /* next */
    }
  }
  found.set(name, null);
  return null;
}

export const defaultRunner: Runner = (bin, args, o) =>
  new Promise((resolve, reject) => {
    const path = which(bin);
    if (!path) {
      reject(new RbaError('config_missing', `${bin} is not installed (run: npm run doctor)`));
      return;
    }
    execFile(
      path,
      args,
      {
        encoding: 'buffer',
        timeout: o.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: o.maxBuffer ?? 64 * 1024 * 1024,
        signal: o.signal,
        // Minimal environment: no credentials or plugin settings reach the tool.
        env: { PATH: [process.env.PATH ?? '', ...EXTRA_DIRS].join(delimiter), LC_ALL: 'C', HOME: process.env.HOME ?? '/tmp' },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const se = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        if (err) {
          if (o.signal?.aborted) return reject(new RbaError('cancelled', `${bin} cancelled`));
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) return reject(new RbaError('timeout', `${bin} exceeded ${o.timeoutMs} ms`));
          // Tool messages often contain our private file paths: keep only file names.
          const clean = scrubPaths;
          const so = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : '';
          return reject(new RbaError('invalid_input', `${bin} failed: ${clean(se.split('\n').filter(Boolean).slice(-3).join(' | ')).slice(0, 400)}`, { exitCode: (err as { code?: number }).code ?? null, stdoutTail: clean(so.slice(-2000)) }));
        }
        resolve({ stdout: stdout as Buffer, stderr: se });
      },
    );
  });

export interface Dependency {
  name: string;
  purpose: string;
  required: 'required' | 'optional';
  formats: string[];
  installed: boolean;
  version: string | null;
  install: string;
}

const DEPS: Array<Omit<Dependency, 'installed' | 'version'> & { versionArgs: string[] }> = [
  { name: 'ffmpeg', purpose: 'audio/video metadata removal (stream copy); image pixel verification', required: 'required', formats: ['mp3', 'flac', 'wav', 'm4a', 'mp4', 'mov', 'jpeg', 'png', 'webp'], install: 'macOS: brew install ffmpeg | Debian/Ubuntu: sudo apt install ffmpeg', versionArgs: ['-version'] },
  { name: 'ffprobe', purpose: 'audio/video inspection and structure verification', required: 'required', formats: ['mp3', 'flac', 'wav', 'm4a', 'mp4', 'mov'], install: 'installed with ffmpeg', versionArgs: ['-version'] },
  { name: 'pdfinfo', purpose: 'PDF properties/XMP/page verification (independent of the PDF writer)', required: 'required', formats: ['pdf'], install: 'macOS: brew install poppler | Debian/Ubuntu: sudo apt install poppler-utils', versionArgs: ['-v'] },
  { name: 'pdftotext', purpose: 'PDF text preservation check', required: 'required', formats: ['pdf'], install: 'installed with poppler', versionArgs: ['-v'] },
  { name: 'pdftoppm', purpose: 'PDF rendering comparison', required: 'required', formats: ['pdf'], install: 'installed with poppler', versionArgs: ['-v'] },
  { name: 'pdfsig', purpose: 'PDF signature detection', required: 'required', formats: ['pdf'], install: 'installed with poppler', versionArgs: ['-v'] },
  { name: 'pdfdetach', purpose: 'PDF embedded-file listing', required: 'required', formats: ['pdf'], install: 'installed with poppler', versionArgs: ['-v'] },
  { name: 'exiftool', purpose: 'optional extra independent metadata check (not used for writing)', required: 'optional', formats: ['jpeg', 'png', 'webp', 'pdf', 'mp3', 'flac', 'wav', 'm4a', 'mp4', 'mov'], install: 'macOS: brew install exiftool | Debian/Ubuntu: sudo apt install libimage-exiftool-perl', versionArgs: ['-ver'] },
  { name: 'qpdf', purpose: 'optional extra PDF structure check (qpdf --check)', required: 'optional', formats: ['pdf'], install: 'macOS: brew install qpdf | Debian/Ubuntu: sudo apt install qpdf', versionArgs: ['--version'] },
];

const versions = new Map<string, string | null>();

export async function toolVersion(name: string): Promise<string | null> {
  if (versions.has(name)) return versions.get(name)!;
  const d = DEPS.find((x) => x.name === name);
  let v: string | null = null;
  if (which(name)) {
    try {
      const r = await defaultRunner(name, d?.versionArgs ?? ['-version'], { timeoutMs: 10_000 });
      v = (r.stdout.toString('utf8') + r.stderr).split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? 'unknown';
    } catch {
      v = 'unknown';
    }
  }
  versions.set(name, v);
  return v;
}

export async function doctor(): Promise<Dependency[]> {
  const out: Dependency[] = [];
  for (const d of DEPS) {
    const version = await toolVersion(d.name);
    out.push({ name: d.name, purpose: d.purpose, required: d.required, formats: d.formats, installed: version !== null, version, install: d.install });
  }
  return out;
}

/** Throw a clear error if a required tool for this operation is missing. */
export function requireTools(names: string[]): void {
  const missing = names.filter((n) => !which(n));
  if (missing.length) {
    const hints = missing.map((m) => `${m}: ${DEPS.find((d) => d.name === m)?.install ?? 'install it'}`).join('; ');
    throw new RbaError('config_missing', `missing local tool(s): ${missing.join(', ')}. ${hints}. Run npm run doctor for details.`);
  }
}
