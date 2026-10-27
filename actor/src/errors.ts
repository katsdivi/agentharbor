import { scrubUrlsInText } from './urlsafe.js';
import type { Readiness, WorkerErrorCode } from './protocol.js';

export class WorkerFail extends Error {
  /** How far a navigation got when it failed (sent as `error.readiness`). */
  readiness?: Readiness;
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
  ) {
    super(message);
  }

  withReadiness(r: Readiness): this {
    this.readiness = r;
    return this;
  }
}

export const HTTP_STATUS: Record<WorkerErrorCode, number> = {
  unauthorized: 401,
  bad_request: 400,
  not_ready: 409,
  navigation_blocked: 403,
  navigation_failed: 502,
  stale_ref: 409,
  element_not_found: 404,
  ambiguous_selector: 409,
  action_failed: 422,
  timeout: 504,
  upload_too_large: 413,
  proxy_unavailable: 502,
  egress_unverified: 502,
  condition_not_met: 412,
  busy: 429,
  shutting_down: 503,
  internal: 500,
};

/** First line of an error message, with the given secrets removed. */
export function cleanMessage(e: unknown, secrets: string[] = []): string {
  let m = e instanceof Error ? e.message : String(e);
  m = scrubUrlsInText(m.split('\n')[0] ?? '');
  for (const s of secrets) {
    if (s && s.length > 0) m = m.split(s).join('[REDACTED]');
  }
  return m.slice(0, 500);
}

export function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(e.message));
}
