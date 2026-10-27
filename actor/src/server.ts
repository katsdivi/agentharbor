/**
 * HTTP API of the worker (see protocol.ts for routes and shapes).
 *
 * - Auth: every route except GET /health requires `Authorization: Bearer <t>`
 *   with sha256(t) == input.tokenHash (constant-time compare).
 * - Concurrency: browser commands are serialized by a mutex. A second
 *   concurrent command waits up to BUSY_WAIT_MS for the first to finish and
 *   otherwise gets `busy`. While a crawl runs, interactive browser commands
 *   return `busy` immediately (status/crawl endpoints still work).
 * - Deadlines: every locked command runs under `commandDeadlineMs` (its own
 *   timeout + margin). On overrun the page is closed, which cancels the pending
 *   Playwright call, and the lock is released only after that operation has
 *   settled and a fresh page replaced it (`recovery: page_reset`). If the
 *   operation cannot be stopped, the worker shuts down (`recovery: terminated`).
 *   A timed-out operation therefore never runs on after the lock is released.
 * - Logging: route, status code, duration and error code only.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { BrowserSession } from './browser.js';
import type { Crawler } from './crawl.js';
import type {
  ClickRequest,
  CrawlRequest,
  ExtractRequest,
  FillRequest,
  InitRequest,
  InspectRequest,
  NavigateRequest,
  ScreenshotRequest,
  SelectRequest,
  UploadRequest,
  WorkerErrorCode,
} from './protocol.js';
import { COMMAND_RECOVERY_MS, commandDeadlineMs } from './protocol.js';
import { HTTP_STATUS, WorkerFail } from './errors.js';
import { log } from './log.js';
import { validateExtractSpec, ExtractSpecError } from './extract.js';
import { SCHEMAS, ValidationError, validateBody, validateDialogPolicy, validateInitExtras, validateReadyWhen, validateRequireOrigins } from './validate.js';
import { capture, fetchVia, validateCaptureRequest, validateFetchRequest } from './operations.js';
import { WORKER_CAPABILITIES, type CaptureRequest, type FetchRequest } from './protocol.js';

const BODY_LIMIT = 1024 * 1024;
const BUSY_WAIT_MS = 10_000;

export class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(waitMs: number): Promise<boolean> {
    if (!this.locked) {
      this.locked = true;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const w = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(false);
      }, waitMs);
      this.waiters.push(w);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }
}

export interface ServerDeps {
  tokenHash: string;
  session: BrowserSession;
  crawler: Crawler;
  maxUploadBytes: number;
  startedAt: number;
  onActivity: () => void;
  idleSecs: () => number;
  shutdown: (reason: string) => void;
  isShuttingDown: () => boolean;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res: http.ServerResponse, code: WorkerErrorCode, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, HTTP_STATUS[code], { ok: false, error: { code, message, ...extra } });
}

/** A command that overran its deadline. */
export class DeadlineExceeded extends WorkerFail {
  constructor(
    message: string,
    readonly recovery: 'page_reset' | 'terminated',
  ) {
    super('timeout', message);
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > limit) {
      reject(new WorkerFail('bad_request', 'request body too large'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new WorkerFail('bad_request', 'request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new WorkerFail('bad_request', 'body is not valid JSON'));
      }
    });
    req.on('error', () => reject(new WorkerFail('bad_request', 'request aborted')));
  });
}

function authorized(req: http.IncomingMessage, tokenHash: string): boolean {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return false;
  const m = /^Bearer ([^\s]+)$/.exec(h);
  if (!m) return false;
  const got = crypto.createHash('sha256').update(m[1]!, 'utf8').digest();
  const want = Buffer.from(tokenHash, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

const BROWSER_ROUTES = new Set(['/navigate', '/inspect', '/click', '/fill', '/select', '/upload', '/screenshot', '/extract', '/state/export', '/fetch', '/capture']);

export function createServer(d: ServerDeps): http.Server {
  const mutex = new Mutex();
  const uploadLimit = Math.ceil(d.maxUploadBytes * 1.4) + 64 * 1024;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> => {
    const method = req.method ?? 'GET';
    // `/` too: the platform probes the container root; it gets the same unauthenticated, non-sensitive reply.
    if ((route === '/health' || route === '/') && method === 'GET') {
      sendJson(res, 200, { ok: true, ready: d.session.initialized && !d.isShuttingDown(), initialized: d.session.initialized, protocolVersion: 1, capabilities: WORKER_CAPABILITIES });
      return;
    }
    if (!authorized(req, d.tokenHash)) {
      sendError(res, 'unauthorized', 'missing or invalid bearer token');
      return;
    }
    d.onActivity();
    if (d.isShuttingDown()) {
      sendError(res, 'shutting_down', 'worker is shutting down');
      return;
    }
    const s = d.session;

    // GET routes
    if (method === 'GET') {
      if (route === '/status') {
        const page = s.initialized && s.page ? await s.summary(s.page).catch(() => null) : null;
        sendJson(res, 200, {
          ok: true,
          page,
          uptimeSecs: Math.round((Date.now() - d.startedAt) / 1000),
          idleSecs: d.idleSecs(),
          egress: s.egress,
        });
        return;
      }
      if (route === '/diagnostics') {
        sendJson(res, 200, { ok: true, ...s.diagnostics() });
        return;
      }
      if (route === '/crawl/status') {
        sendJson(res, 200, { ok: true, ...d.crawler.status() });
        return;
      }
      if (route === '/crawl/results') {
        const u = new URL(req.url ?? '/', 'http://x');
        const offset = Number(u.searchParams.get('offset') ?? '0');
        const limit = Number(u.searchParams.get('limit') ?? '100');
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
          throw new WorkerFail('bad_request', 'offset must be >= 0 and limit in [1, 1000]');
        }
        sendJson(res, 200, { ok: true, ...d.crawler.getResults(offset, limit) });
        return;
      }
      sendError(res, 'bad_request', 'unknown route');
      return;
    }
    if (method !== 'POST' || !(route in SCHEMAS)) {
      sendError(res, 'bad_request', 'unknown route');
      return;
    }
    const raw = await readBody(req, route === '/upload' ? uploadLimit : BODY_LIMIT);
    let body: Record<string, unknown>;
    try {
      body = validateBody<Record<string, unknown>>(raw, SCHEMAS[route]!, route);
      if (route === '/session/init') validateInitExtras(body);
      if (route === '/fill' || route === '/upload') validateRequireOrigins(body.requireOrigins as string[] | undefined);
      if (route === '/navigate' || route === '/click') validateDialogPolicy(body.dialog);
      if (route === '/navigate' || route === '/extract' || route === '/inspect') validateReadyWhen(body.readyWhen);
      if (route === '/extract') validateExtractSpec(body.spec);
      if (route === '/fetch') validateFetchRequest(body);
      if (route === '/capture') validateCaptureRequest(body);
      if (route === '/crawl/start' && body.extract !== undefined) validateExtractSpec(body.extract);
    } catch (e) {
      if (e instanceof ValidationError || e instanceof ExtractSpecError) throw new WorkerFail('bad_request', e.message);
      throw e;
    }

    if (route === '/shutdown') {
      sendJson(res, 200, { ok: true });
      setImmediate(() => d.shutdown('shutdown_request'));
      return;
    }
    if (route === '/crawl/cancel') {
      sendJson(res, 200, { ok: true, ...(await d.crawler.cancel()) });
      return;
    }
    if (BROWSER_ROUTES.has(route) || route === '/crawl/start' || route === '/session/init') {
      if (d.crawler.running) throw new WorkerFail('busy', 'a crawl is running; wait for it or cancel it');
    }
    if (!(await mutex.acquire(BUSY_WAIT_MS))) throw new WorkerFail('busy', 'another command is in progress');
    try {
      if (d.crawler.running && route !== '/crawl/cancel') throw new WorkerFail('busy', 'a crawl is running; wait for it or cancel it');
      const deadline = commandDeadlineMs(route, body);
      const op = dispatch(route, body, d);
      op.catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      const overran = new Promise<'deadline'>((r) => {
        timer = setTimeout(() => r('deadline'), deadline);
      });
      const first = await Promise.race([op.then((v) => ({ v })), overran]).finally(() => clearTimeout(timer));
      if (first === 'deadline') {
        log('command_deadline', { route, ms: deadline });
        const recovered = route !== '/session/init' && (await s.recoverFromHang(op, COMMAND_RECOVERY_MS));
        if (!recovered) {
          setImmediate(() => d.shutdown('command_deadline'));
          throw new DeadlineExceeded(`${route} exceeded its ${deadline} ms deadline and could not be cancelled; the worker is shutting down`, 'terminated');
        }
        throw new DeadlineExceeded(`${route} exceeded its ${deadline} ms deadline; it was cancelled by closing the page. The session continues on a blank page (cookies kept); refs are invalid`, 'page_reset');
      }
      sendJson(res, 200, { ok: true, ...first.v });
    } finally {
      mutex.release();
    }
  };

  return http.createServer((req, res) => {
    const t0 = Date.now();
    let route = '/';
    try {
      route = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      /* keep '/' */
    }
    handle(req, res, route)
      .catch((e: unknown) => {
        if (e instanceof WorkerFail) {
          if (!res.headersSent) sendError(res, e.code, e.message, { ...(e instanceof DeadlineExceeded ? { recovery: e.recovery } : {}), ...(e.readiness ? { readiness: e.readiness } : {}) });
          return e.code;
        }
        log('internal_error', { route, err: e instanceof Error ? e.name : 'unknown' });
        if (!res.headersSent) sendError(res, 'internal', 'internal error');
        return 'internal';
      })
      .then((code) => {
        log('request', { route, method: req.method, status: res.statusCode, ms: Date.now() - t0, code: typeof code === 'string' ? code : undefined });
      });
  });
}

async function dispatch(route: string, body: Record<string, unknown>, d: ServerDeps): Promise<object> {
  const s = d.session;
  switch (route) {
    case '/session/init':
      return s.init(body as InitRequest);
    case '/navigate':
      return s.navigate(body as unknown as NavigateRequest);
    case '/inspect':
      return s.inspect(body as InspectRequest);
    case '/click':
      return s.click(body as ClickRequest);
    case '/fill':
      return s.fill(body as unknown as FillRequest);
    case '/select':
      return s.select(body as unknown as SelectRequest);
    case '/upload':
      return s.upload(body as unknown as UploadRequest);
    case '/screenshot':
      return s.screenshot(body as ScreenshotRequest);
    case '/extract':
      return s.extract(body as unknown as ExtractRequest);
    case '/state/export':
      return s.exportState();
    case '/fetch':
      return fetchVia(s, body as unknown as FetchRequest);
    case '/capture':
      return capture(s, body as unknown as CaptureRequest);
    case '/crawl/start':
      s.ensureReady();
      return d.crawler.start(body as unknown as CrawlRequest);
    default:
      throw new WorkerFail('bad_request', 'unknown route');
  }
}
