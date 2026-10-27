/**
 * End-to-end harness: drives the BUILT MCP server (`node dist/src/mcp/index.js`)
 * over stdio with the SDK client, exactly like Claude Code does.
 *
 * Isolation: a temp dir holds a generated `.env` (RBA_ENV_FILE) and the data
 * dir. The server process gets a minimal environment (PATH, HOME, the suite's
 * private TMPDIR, PLAYWRIGHT_BROWSERS_PATH passthrough, RBA_ENV_FILE, NODE_EXTRA_CA_CERTS for the
 * TLS front), never the developer's `.env` or process.env.
 *
 * Remote modes use the fake Apify API (which runs the real worker as a local
 * child process) behind an HTTPS front, so they prove orchestrator plumbing
 * only. `local` mode uses the real LocalProvider of the server process.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeApify, type FakeApify } from '../fakes/apify.js';
import { startFakeMailSlurp, type FakeMailSlurp } from '../fakes/mailslurp.js';
import { startCatalogSite } from '../fixtures/catalog.js';
import { startIpEcho } from '../fixtures/ipecho.js';
import { startFixtureSite } from '../fixtures/site.js';
import { startTlsFront, type TlsFront } from '../fixtures/tls-front.js';
import type { Recorder } from '../fixtures/ua-counter.js';

const ROOT = resolve(import.meta.dirname, '../..');
export const SERVER_MAIN = join(ROOT, 'dist/src/mcp/index.js');
export const TERMINAL_JOB = ['completed', 'failed', 'cancelled', 'blocked', 'completed_unconfirmed', 'outcome_unknown', 'interrupted'];

type Site = Awaited<ReturnType<typeof startFixtureSite>>;

export interface CallOut {
  isError: boolean;
  data: any;
  raw: string;
}

export interface E2E {
  dir: string;
  dataDir: string;
  site: Site;
  catalog: Recorder;
  apify: FakeApify | null;
  front: TlsFront | null;
  mail: FakeMailSlurp;
  echo: { url: string; close(): Promise<void>; requests: number };
  mcp: Client;
  serverPid: number;
  stderr(): string;
  /** Values that must never appear in server output (generated key/token, fake API keys). */
  secrets: string[];
  call(name: string, args?: Record<string, unknown>): Promise<CallOut>;
  /** Poll job_status until a terminal status. */
  untilDone(jobId: string, maxSecs?: number): Promise<any>;
  /** SELECT-only query on the server's registry.sqlite (WAL readers see committed state). */
  q<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): T[];
  /** Stop the server (stdin close -> its shutdown handler) and return its exit code. */
  stopServer(): Promise<number | null>;
  /** Kill the server with SIGKILL (no shutdown handler runs), as a crash would. */
  killServer(): Promise<void>;
  /** Start a NEW server process on the same .env and data dir (after stop or kill). */
  restartServer(): Promise<void>;
  close(): Promise<void>;
}

export interface E2EOptions {
  vars?: Record<string, string>;
  /** Provide the fake Apify remote provider (default true). */
  remote?: boolean;
  /** Proxy URL the fake Apify hands to workers in proxy modes. */
  proxyUrl?: string;
  autoVerifyEmail?: boolean;
  /** Alternative server entry point (e.g. a copy of dist/ without the worker build). */
  serverMain?: string;
  /** Extra fixture origins (started by the caller) to allow for navigation, accounts and private-host access. */
  extraOrigins?: string[];
}

export async function startE2E(o: E2EOptions = {}): Promise<E2E> {
  const serverMain = o.serverMain ?? SERVER_MAIN;
  if (!existsSync(serverMain)) throw new Error('dist/ missing: run npm run build first');
  const dir = mkdtempSync(join(tmpdir(), 'rba-e2e-'));
  const dataDir = join(dir, 'data');
  const mail = await startFakeMailSlurp();
  let siteRef: Site | null = null;
  const site = await startFixtureSite({
    onSignup: async (email, origin) => {
      if (o.autoVerifyEmail === false) return;
      const token = siteRef!.state.tokens.get(email);
      mail.deliver(email, { from: 'no-reply@127.0.0.1', subject: 'Verify your account', body: `<p>Welcome!</p><a href="${origin}/verify?token=${token}">Verify email</a>` });
    },
  });
  siteRef = site;
  const catalog = await startCatalogSite();
  const echo = await startIpEcho();
  const remote = o.remote !== false;
  const apify = remote ? await startFakeApify({ proxyUrl: o.proxyUrl }) : null;
  const front = apify ? await startTlsFront(apify.url) : null;

  const encKey = randomBytes(32).toString('base64');
  const dashToken = randomBytes(24).toString('base64url');
  const extra = o.extraOrigins ?? [];
  const hosts = [site.origin, catalog.origin, echo.url, ...extra].map((u) => new URL(u).host);
  const vars: Record<string, string> = {
    RBA_ENCRYPTION_KEY: encKey,
    RBA_DASHBOARD_TOKEN: dashToken,
    RBA_DATA_DIR: dataDir,
    MAILSLURP_API_KEY: mail.apiKey,
    MAILSLURP_API_BASE_URL: mail.url,
    RBA_AUTHORIZED_TARGETS: [site.origin, ...extra].join(','),
    RBA_ALLOWED_ORIGINS: [site.origin, catalog.origin, ...extra].join(','),
    RBA_ALLOW_PRIVATE_HOSTS: hosts.join(','),
    RBA_EGRESS_CHECK_URL: echo.url,
    RBA_EMAIL_WAIT_MAX_SECS: '20',
    RBA_MAX_CONCURRENT_SESSIONS: '2',
    RBA_MONTHLY_BUDGET_USD: '10',
    RBA_IDLE_TIMEOUT_SECS: '120',
    ...(apify && front ? { APIFY_TOKEN: apify.token, APIFY_ACTOR_ID: 'tester~remote-browser-worker', APIFY_API_BASE_URL: front.url } : {}),
    ...o.vars,
  };
  const envFile = join(dir, '.env');
  writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });

  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? dir, RBA_ENV_FILE: envFile };
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.env.RBA_E2E_TMPDIR) env.TMPDIR = process.env.RBA_E2E_TMPDIR;
  if (front) env.NODE_EXTRA_CA_CERTS = front.caFile;
  let err = '';
  let transport!: StdioClientTransport;
  let mcp!: Client;
  let serverPid = 0;
  let exitCode: number | null | undefined;
  let stopped = false;
  const startServer = async () => {
    transport = new StdioClientTransport({ command: process.execPath, args: [serverMain], env, cwd: dir, stderr: 'pipe' });
    transport.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    mcp = new Client({ name: 'rba-e2e', version: '0' });
    await mcp.connect(transport);
    serverPid = transport.pid!;
    stopped = false;
    exitCode = undefined;
  };
  await startServer();

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallOut> => {
    const r = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    const raw = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let data: any = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* raw text */
    }
    return { isError: !!r.isError, data, raw };
  };

  let db: DatabaseSync | null = null;
  const q = <T>(sql: string, ...params: Array<string | number | null>): T[] => {
    // Opened read-write only so SQLite may create the WAL -shm file if the server has not yet;
    // the harness issues SELECTs only.
    if (!/^\s*select\b/i.test(sql)) throw new Error('harness q() is read-only');
    try {
      db ??= new DatabaseSync(join(dataDir, 'registry.sqlite'));
    } catch (e) {
      throw new Error(`${(e as Error).message}: ${dataDir} exists=${existsSync(dataDir)} files=${existsSync(dataDir) ? readdirSync(dataDir).join(',') : '-'}; server stderr tail: ${err.slice(-600)}`);
    }
    return db.prepare(sql).all(...params) as T[];
  };

  const untilDone = async (jobId: string, maxSecs = 150) => {
    const deadline = Date.now() + maxSecs * 1000;
    while (Date.now() < deadline) {
      const j = await call('job_status', { jobId, waitSecs: 2 });
      if (TERMINAL_JOB.includes(j.data.status)) return j.data;
    }
    throw new Error(`job ${jobId} did not finish within ${maxSecs}s`);
  };

  const stopServer = async () => {
    if (stopped) return exitCode ?? null;
    stopped = true;
    const proc = (transport as unknown as { _process?: { once(e: string, f: (c: number | null) => void): void; exitCode: number | null } })._process;
    const exited = proc
      ? new Promise<number | null>((r) => {
          if (proc.exitCode !== null) r(proc.exitCode);
          else proc.once('exit', (c) => r(c));
        })
      : Promise.resolve(null);
    // Close stdin first and give the server's own shutdown (closes owned sessions, max 8 s) time to finish.
    (transport as unknown as { _process?: { stdin?: { end(): void } } })._process?.stdin?.end();
    exitCode = await Promise.race([exited, new Promise<number | null>((r) => setTimeout(() => r(-999), 12_000))]);
    await mcp.close().catch(() => undefined);
    return exitCode;
  };

  const killServer = async () => {
    if (stopped) return;
    stopped = true;
    const pid = serverPid;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !alive(pid), 10_000);
    exitCode = null;
    await mcp.close().catch(() => undefined);
  };

  const restartServer = async () => {
    if (!stopped) throw new Error('stop or kill the server first');
    await startServer();
  };

  return {
    dir,
    dataDir,
    site,
    catalog,
    apify,
    front,
    mail,
    echo,
    get mcp() {
      return mcp;
    },
    get serverPid() {
      return serverPid;
    },
    stderr: () => err,
    secrets: [encKey, dashToken, mail.apiKey, ...(apify ? [apify.token] : [])],
    call,
    untilDone,
    q,
    stopServer,
    killServer,
    restartServer,
    async close() {
      await stopServer();
      db?.close();
      await apify?.close();
      await front?.close();
      await mail.close();
      await site.close();
      await catalog.close();
      await echo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** True if a process with this pid is alive. */
export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fake Apify runs still RUNNING or with a live worker process. */
export function liveFakeRuns(apify: FakeApify | null): string[] {
  if (!apify) return [];
  return [...apify.runs.values()].filter((r) => r.status === 'RUNNING' || r.proc.exitCode === null && r.proc.signalCode === null).map((r) => r.id);
}

/** Local worker run dirs left under the data dir (LocalProvider removes them on exit). */
export function leftoverLocalRuns(dataDir: string): string[] {
  const d = join(dataDir, 'local-runs');
  return existsSync(d) ? readdirSync(d) : [];
}

export async function waitFor(cond: () => boolean, ms = 15_000, step = 200): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

/** Known-defect hits recorded by tests (none expected; kept so a future pinned defect is visible in the log). */
export const knownDefectHits: string[] = [];
export async function navigate(h: E2E, sessionId: string, url: string): Promise<CallOut> {
  return h.call('browser_navigate', { sessionId, url });
}

/** Print known-defect hits at the end of a file so they are visible in the run log. */
export function reportKnownDefects(file: string): void {
  if (knownDefectHits.length) process.stderr.write(`[e2e ${file}] known defects hit: ${knownDefectHits.join('; ')}\n`);
}
