/**
 * Spawns the BUILT worker (`node actor/dist/main.js`) with a temp
 * CRAWLEE_STORAGE_DIR containing INPUT.json and talks to it over HTTP.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerInput } from '../../actor/src/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WORKER_MAIN = path.join(ROOT, 'actor/dist/main.js');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

export interface CallResult {
  status: number;
  body: any;
}

export interface Worker {
  base: string;
  token: string;
  proc: ChildProcess;
  output(): string;
  exited: Promise<number | null>;
  call(route: string, body?: unknown, opts?: { method?: string; token?: string | null }): Promise<CallResult>;
  stop(): Promise<void>;
}

export function baseInput(over: Partial<WorkerInput> = {}): WorkerInput {
  return {
    protocolVersion: 1,
    tokenHash: '',
    proxy: { mode: 'direct' },
    idleTimeoutSecs: 300,
    maxLifetimeSecs: 600,
    network: { allowedNavigationOrigins: ['*'], allowPrivateHosts: [] },
    egressCheckUrl: 'http://127.0.0.1:9/ip',
    maxUploadBytes: 1024 * 1024,
    ...over,
  };
}

export async function startWorker(opts: {
  input: Partial<WorkerInput> | Record<string, unknown>;
  env?: Record<string, string>;
  rawInput?: boolean;
  waitListening?: boolean;
}): Promise<Worker> {
  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rba-worker-test-'));
  fs.mkdirSync(path.join(dir, 'key_value_stores/default'), { recursive: true });
  const input = opts.rawInput ? opts.input : baseInput({ ...(opts.input as Partial<WorkerInput>), tokenHash });
  fs.writeFileSync(path.join(dir, 'key_value_stores/default/INPUT.json'), JSON.stringify(input));
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CRAWLEE_STORAGE_DIR: dir,
    ACTOR_WEB_SERVER_PORT: String(port),
    RBA_WORKER_TEST_MODE: '1',
    ...(opts.env ?? {}),
  };
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const proc = spawn(process.execPath, [WORKER_MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d.toString()));
  proc.stderr!.on('data', (d) => (out += d.toString()));
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  const base = `http://127.0.0.1:${port}`;
  if (opts.waitListening !== false) {
    const deadline = Date.now() + 30_000;
    while (!/RBA_WORKER_LISTENING port=\d+/.test(out)) {
      if (Date.now() > deadline) throw new Error(`worker did not start:\n${out}`);
      if (proc.exitCode !== null) throw new Error(`worker exited early (${proc.exitCode}):\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const call: Worker['call'] = async (route, body, o = {}) => {
    const method = o.method ?? (body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const t = o.token === undefined ? token : o.token;
    if (t !== null) headers.authorization = `Bearer ${t}`;
    const r = await fetch(base + route, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* raw */
    }
    return { status: r.status, body: parsed };
  };
  return {
    base,
    token,
    proc,
    output: () => out,
    exited,
    call,
    stop: async () => {
      if (proc.exitCode === null) {
        await call('/shutdown', {}).catch(() => undefined);
        const t = setTimeout(() => proc.kill('SIGKILL'), 15_000);
        await exited;
        clearTimeout(t);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Tiny HTTP server counting requests (a "private" target that must never be hit). */
export async function startCounter(): Promise<{ origin: string; port: number; hits: string[]; close(): Promise<void> }> {
  const http = await import('node:http');
  const hits: string[] = [];
  const s = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>SECRET INTERNAL</h1>');
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      }),
  };
}

export function hostOf(origin: string): string {
  return new URL(origin).host;
}
