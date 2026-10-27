/**
 * Fake Apify REST API for engineering tests. "Starting a run" spawns the REAL
 * worker (actor/dist/main.js) as a local child process and reports its local
 * HTTP URL as containerUrl. This exercises the real ApifyProvider and worker
 * code paths; it is not evidence of compatibility with the live Apify platform.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKER = resolve(import.meta.dirname, '../../actor/dist/main.js');

export interface FakeRun {
  id: string;
  status: string;
  port: number;
  proc: ChildProcess;
  output: string;
  ready: boolean;
  startedAt: number;
  finishedAt: number | null;
  memoryMb: number;
  input: any;
}

export interface FakeApifyOptions {
  token?: string;
  /** Proxy URL handed to the worker for non-direct modes (test mode only). */
  proxyUrl?: string;
  monthlyUsageUsd?: number;
  monthlyLimitUsd?: number;
  /** Simulated cost per GB-hour (Apify CU). */
  cuPriceUsd?: number;
}

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

export async function startFakeApify(opts: FakeApifyOptions = {}) {
  const token = opts.token ?? 'apify_api_testtoken0000000000000000';
  const runs = new Map<string, FakeRun>();
  let n = 0;
  const state = { ...opts, runStarts: 0 };

  const runJson = (r: FakeRun) => {
    const end = r.finishedAt ?? Date.now();
    const secs = (end - r.startedAt) / 1000;
    const cu = (r.memoryMb / 1024) * (secs / 3600);
    return {
      id: r.id,
      status: r.status,
      statusMessage: r.status,
      containerUrl: `http://127.0.0.1:${r.port}`,
      // Live Apify did not include isContainerServerReady for these runs; the provider probes /health.
      usageTotalUsd: cu * (state.cuPriceUsd ?? 0.3),
      usage: { ACTOR_COMPUTE_UNITS: cu },
      stats: { computeUnits: cu, runTimeSecs: secs },
      finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
    };
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const body = (req: IncomingMessage) =>
    new Promise<string>((r) => {
      const c: Buffer[] = [];
      req.on('data', (d) => c.push(d));
      req.on('end', () => r(Buffer.concat(c).toString('utf8')));
    });

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: { type: 'token-not-valid', message: 'bad token' } });
    const url = new URL(req.url!, 'http://x');
    let m = /^\/v2\/actors\/([^/]+)\/runs$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      state.runStarts++;
      const input = JSON.parse(await body(req));
      const id = `run${++n}`;
      const port = await freePort();
      const storage = mkdtempSync(join(tmpdir(), 'rba-fake-run-'));
      mkdirSync(join(storage, 'key_value_stores', 'default'), { recursive: true });
      writeFileSync(join(storage, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify(input));
      const proc = spawn(process.execPath, [WORKER], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ACTOR_WEB_SERVER_PORT: String(port),
          CRAWLEE_STORAGE_DIR: storage,
          APIFY_LOCAL_STORAGE_DIR: storage,
          RBA_WORKER_TEST_MODE: '1',
          ...(state.proxyUrl ? { RBA_WORKER_TEST_PROXY_URL: state.proxyUrl } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const run: FakeRun = { id, status: 'RUNNING', port, proc, output: '', ready: false, startedAt: Date.now(), finishedAt: null, memoryMb: Number(url.searchParams.get('memory') ?? 1024), input };
      const onData = (d: Buffer) => {
        run.output += d.toString();
        if (run.output.includes('RBA_WORKER_LISTENING')) run.ready = true;
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
      proc.on('exit', (code) => {
        run.finishedAt = Date.now();
        run.ready = false;
        if (run.status === 'RUNNING') run.status = code === 0 ? 'SUCCEEDED' : 'FAILED';
      });
      const timeout = Number(url.searchParams.get('timeout') ?? 3600);
      setTimeout(() => {
        if (run.status === 'RUNNING') {
          run.status = 'TIMED-OUT';
          proc.kill('SIGKILL');
        }
      }, timeout * 1000).unref();
      runs.set(id, run);
      return send(res, 201, { data: runJson(run) });
    }
    m = /^\/v2\/actor-runs\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const r = runs.get(m[1]!);
      return r ? send(res, 200, { data: runJson(r) }) : send(res, 404, { error: { type: 'record-not-found' } });
    }
    m = /^\/v2\/actor-runs\/([^/]+)\/abort$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      const r = runs.get(m[1]!);
      if (!r) return send(res, 404, {});
      if (r.status === 'RUNNING') {
        r.status = 'ABORTED';
        r.proc.kill('SIGKILL');
      }
      return send(res, 200, { data: runJson(r) });
    }
    if (url.pathname === '/v2/users/me/limits') {
      return send(res, 200, { data: { limits: { maxMonthlyUsageUsd: state.monthlyLimitUsd ?? 5 }, current: { monthlyUsageUsd: state.monthlyUsageUsd ?? 0 } } });
    }
    send(res, 404, { error: { type: 'not-found' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    token,
    runs,
    state,
    /** Simulate a crashed container: kill the worker without telling anyone. */
    crash(runId: string) {
      const r = runs.get(runId)!;
      r.status = 'FAILED';
      r.proc.kill('SIGKILL');
    },
    allOutput: () => [...runs.values()].map((r) => r.output).join('\n'),
    async close() {
      for (const r of runs.values()) if (r.proc.exitCode === null) r.proc.kill('SIGKILL');
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}
export type FakeApify = Awaited<ReturnType<typeof startFakeApify>>;
