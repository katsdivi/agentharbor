/**
 * Local provider (execution mode `local`): runs the SAME worker
 * (actor/dist/main.js) as a child process on this computer.
 *
 *  - Fresh temporary automation profile: the worker launches the bundled
 *    Chromium with a new browser context (no user-data-dir); it never reads,
 *    discovers or imports the personal browser profile or its cookies.
 *  - Same network policy (policy proxy + CDP guard) as the remote worker;
 *    loopback/private hosts stay blocked unless RBA_ALLOW_PRIVATE_HOSTS.
 *  - Direct route only (requests originate from this computer's network).
 *  - Listens on 127.0.0.1 only, bearer-token protected like the remote worker.
 *  - Minimal environment: no plugin secrets, no inherited process.env.
 *
 * Run ids are `local:<pid>:<nonce>`; the nonce is on the child's command line
 * so liveness checks and aborts after a restart never touch an unrelated
 * process that reused the pid.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../core/config.js';
import { RbaError } from '../core/errors.js';
import type { AccountUsage, BrowserProvider, ProviderRun, RunInfo, StartRunOptions } from './types.js';

export interface LocalProviderOptions {
  /** Directory for per-run worker storage (under the plugin data dir). */
  runsDir: string;
  workerMain?: string;
  startupTimeoutMs?: number;
  /** When set, the worker records a video of its pages into this directory (outside the run dir, which is removed on exit). */
  recordVideoDir?: string;
}

export const LOCAL_RUN_PREFIX = 'local:';

/** Plugin root holding actor/: PROJECT_ROOT when running from dist/, the repo root when running from source (tests). */
function workerRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [PROJECT_ROOT, resolve(here, '..', '..')]) if (existsSync(join(c, 'actor', 'package.json'))) return c;
  return PROJECT_ROOT;
}

export function parseLocalRunId(runId: string): { pid: number; nonce: string } | null {
  const m = /^local:(\d+):([a-f0-9]{16})$/.exec(runId);
  return m ? { pid: Number(m[1]), nonce: m[2]! } : null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/** True only if `pid` is alive AND its command line carries our nonce. */
function ownsProcess(pid: number, nonce: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    return cmd.includes(`--rba-local-run=${nonce}`);
  } catch {
    return false;
  }
}

export class LocalProvider implements BrowserProvider {
  readonly name = 'local';
  readonly kind = 'local' as const;
  private readonly workerMain: string;
  private readonly root: string;
  private readonly started = new Map<string, { startedAt: number; dir: string; proc: ChildProcess; exited: Promise<void> }>();

  constructor(private readonly o: LocalProviderOptions) {
    this.root = workerRoot();
    this.workerMain = o.workerMain ?? join(this.root, 'actor', 'dist', 'main.js');
  }

  /** Why local mode cannot run, or null when the worker build is present. */
  unavailableReason(): string | null {
    if (!existsSync(this.workerMain)) return 'local worker build missing (actor/dist/main.js); run npm run build';
    if (!existsSync(join(this.root, 'actor', 'node_modules', 'playwright'))) return 'local worker dependencies missing; run npm ci --prefix actor';
    return null;
  }

  async startRun(opts: StartRunOptions): Promise<ProviderRun> {
    const why = this.unavailableReason();
    if (why) throw new RbaError('config_missing', `execution mode local is unavailable: ${why}. Not falling back to a remote worker.`);
    if (opts.input.proxy.mode !== 'direct') throw new RbaError('invalid_input', 'local execution uses the direct route only');
    opts.signal?.throwIfAborted();
    const nonce = randomBytes(8).toString('hex');
    mkdirSync(this.o.runsDir, { recursive: true, mode: 0o700 });
    const dir = join(this.o.runsDir, nonce);
    mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true, mode: 0o700 });
    // The input holds only the token HASH and policy (no secrets), like the remote run input.
    writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify(opts.input), { mode: 0o600 });
    // Private temp dir: Chromium's temporary profile (which holds the session's cookies)
    // lives inside this run's 0700 directory and is removed with it.
    mkdirSync(join(dir, 'tmp'), { mode: 0o700 });
    const port = await freePort();
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? dir,
      CRAWLEE_STORAGE_DIR: dir,
      ACTOR_WEB_SERVER_PORT: String(port),
      RBA_WORKER_BIND_HOST: '127.0.0.1',
      TMPDIR: join(dir, 'tmp'),
    };
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (this.o.recordVideoDir) {
      mkdirSync(this.o.recordVideoDir, { recursive: true, mode: 0o700 });
      env.RBA_WORKER_RECORD_VIDEO_DIR = this.o.recordVideoDir;
    }
    const proc = spawn(process.execPath, [this.workerMain, `--rba-local-run=${nonce}`], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d: Buffer) => {
      out = (out + d.toString('utf8')).slice(-8000);
    };
    proc.stdout!.on('data', keep);
    proc.stderr!.on('data', keep);
    // Resolves once the child has been reaped (not merely signalled or a zombie).
    const exited = new Promise<void>((r) => proc.once('exit', () => r()));
    proc.on('exit', () => rmSync(dir, { recursive: true, force: true }));
    const runId = `${LOCAL_RUN_PREFIX}${proc.pid}:${nonce}`;
    this.started.set(runId, { startedAt: Date.now(), dir, proc, exited });
    opts.onRunCreated?.(runId);
    try {
      const deadline = Date.now() + (this.o.startupTimeoutMs ?? 60_000);
      while (!/RBA_WORKER_LISTENING port=\d+/.test(out)) {
        opts.signal?.throwIfAborted();
        if (proc.exitCode !== null || proc.signalCode) {
          const last = out.split('\n').filter((l) => /fatal|invalid_input|error/i.test(l)).slice(-2).join(' | ').slice(0, 300);
          throw new RbaError('provider_error', `local worker exited during startup${last ? `: ${last}` : ''}`);
        }
        if (Date.now() > deadline) throw new RbaError('timeout', 'local worker did not become ready before the startup timeout');
        await new Promise((r) => setTimeout(r, 100));
      }
      return { runId, workerUrl: `http://127.0.0.1:${port}` };
    } catch (e) {
      await this.abortRun(runId).catch(() => undefined);
      throw e;
    }
  }

  async getRun(runId: string): Promise<RunInfo> {
    const p = parseLocalRunId(runId);
    const alive = p ? ownsProcess(p.pid, p.nonce) : false;
    const s = this.started.get(runId);
    return {
      runId,
      state: alive ? 'running' : p ? 'finished' : 'unknown',
      statusMessage: alive ? null : 'local worker process not running',
      usageUsd: 0,
      computeUnits: null,
      residentialProxyGb: null,
      runtimeSecs: s ? Math.round((Date.now() - s.startedAt) / 1000) : null,
      preliminary: false,
      finishedAt: null,
    };
  }

  async abortRun(runId: string): Promise<void> {
    const p = parseLocalRunId(runId);
    const s = this.started.get(runId);
    if (p && s && s.proc.pid === p.pid) {
      await this.stopChild(s);
      return;
    }
    if (!p || !ownsProcess(p.pid, p.nonce)) return;
    try {
      process.kill(p.pid, 'SIGTERM');
    } catch {
      return;
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && ownsProcess(p.pid, p.nonce)) await new Promise((r) => setTimeout(r, 200));
    if (ownsProcess(p.pid, p.nonce)) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    rmSync(join(this.o.runsDir, p.nonce), { recursive: true, force: true });
  }

  /**
   * Stop a worker this provider spawned. Waits for its 'exit' event (the child is
   * reaped), not for `ps` to stop listing the nonce: a killed child stays a zombie
   * (pid still signalable, command line gone) until the event loop reaps it, so a
   * ps-based check reports it stopped while the pid still exists.
   */
  private async stopChild(s: { dir: string; proc: ChildProcess; exited: Promise<void> }): Promise<void> {
    const gone = () => s.proc.exitCode !== null || s.proc.signalCode !== null;
    const within = (ms: number) => Promise.race([s.exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), ms).unref())]);
    if (!gone()) {
      s.proc.kill('SIGTERM');
      if (!(await within(10_000))) {
        s.proc.kill('SIGKILL');
        if (!(await within(10_000))) throw new RbaError('provider_error', `local worker ${s.proc.pid} did not exit after SIGKILL`);
      }
    }
    await s.exited;
    rmSync(s.dir, { recursive: true, force: true });
  }

  /**
   * Remove run directories (worker input, temporary browser profile) left by
   * workers whose orchestrator died. A directory is removed only when no live
   * process carries its nonce, so another server's running worker is untouched.
   */
  sweepStale(): number {
    let names: string[];
    try {
      names = readdirSync(this.o.runsDir);
    } catch {
      return 0;
    }
    if (names.length === 0) return 0;
    let live = '';
    try {
      live = execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    } catch {
      return 0; // cannot tell what is alive: keep everything
    }
    let n = 0;
    for (const name of names) {
      if (!/^[a-f0-9]{16}$/.test(name) || live.includes(`--rba-local-run=${name}`)) continue;
      rmSync(join(this.o.runsDir, name), { recursive: true, force: true });
      n++;
    }
    return n;
  }

  /** Local runs have no provider bill. */
  async accountUsage(): Promise<AccountUsage> {
    return { monthlyUsageUsd: null, monthlyLimitUsd: null, cycleStart: null, cycleEnd: null };
  }
}
