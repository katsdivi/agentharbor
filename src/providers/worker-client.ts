import { COMMAND_RECOVERY_MS, commandDeadlineMs, type WorkerErrorCode, type WorkerRoute } from '../../actor/src/protocol.js';
import { RbaError, type ErrorCode } from '../core/errors.js';

const MAP: Partial<Record<WorkerErrorCode, ErrorCode>> = {
  navigation_blocked: 'navigation_blocked',
  stale_ref: 'stale_ref',
  bad_request: 'invalid_input',
  element_not_found: 'invalid_input',
  ambiguous_selector: 'invalid_input',
  upload_too_large: 'invalid_input',
  timeout: 'timeout',
  // A required readiness condition was not met; details.workerCode tells it apart from a page timeout.
  condition_not_met: 'timeout',
  proxy_unavailable: 'provider_error',
  egress_unverified: 'provider_error',
};

/** Worker routes executed under the command lock and its deadline (see actor/src/server.ts). */
const LOCKED_ROUTES = new Set<string>(['/session/init', '/navigate', '/inspect', '/click', '/fill', '/select', '/upload', '/screenshot', '/extract', '/state/export', '/crawl/start']);

/** HTTP client for one worker. The bearer token never leaves this object. */
export class WorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly f: typeof fetch = fetch,
  ) {}

  /**
   * Client timeout: at least the worker's own command deadline plus its recovery
   * time and network slack, so the worker's structured `timeout` (with what it
   * did about the operation) arrives before the client gives up.
   */
  static clientTimeoutMs(route: string, body: unknown): number {
    if (WorkerClient.testTimeoutMs !== null) return WorkerClient.testTimeoutMs;
    return commandDeadlineMs(route, body) + COMMAND_RECOVERY_MS + 15_000;
  }

  /** Tests only: force a short client timeout to exercise the no-answer path. */
  static testTimeoutMs: number | null = null;

  async call<T>(route: WorkerRoute, body?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal; query?: string } = {}): Promise<T> {
    // Commands that run under the worker's deadline get at least that long; other
    // routes (/shutdown, /status, crawl polling) keep the caller's short timeout.
    const floor = LOCKED_ROUTES.has(route) ? WorkerClient.clientTimeoutMs(route, body) : 0;
    const timeout = AbortSignal.timeout(WorkerClient.testTimeoutMs ?? Math.max(opts.timeoutMs ?? (floor || 90_000), floor));
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}${route}${opts.query ? `?${opts.query}` : ''}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: 'error',
      });
    } catch (e) {
      if (opts.signal?.aborted) throw new RbaError('cancelled', 'cancelled');
      if (timeout.aborted) throw new RbaError('timeout', `worker call ${route} got no answer in time`, { clientTimeout: true });
      throw new RbaError('worker_error', `worker unreachable on ${route}: ${(e as Error).message}`);
    }
    let parsed: { ok: boolean; error?: { code: WorkerErrorCode; message: string; recovery?: string; readiness?: unknown } } & Record<string, unknown>;
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      throw new RbaError('worker_error', `worker returned non-JSON (${res.status}) on ${route}`);
    }
    if (!res.ok || !parsed.ok) {
      const code = parsed.error?.code ?? 'internal';
      throw new RbaError(MAP[code] ?? 'worker_error', parsed.error?.message ?? `worker error ${res.status}`, {
        workerCode: code,
        ...(parsed.error?.recovery ? { recovery: parsed.error.recovery } : {}),
        ...(parsed.error?.readiness ? { readiness: parsed.error.readiness } : {}),
      });
    }
    return parsed as T;
  }
}
