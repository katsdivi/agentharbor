/** Error taxonomy surfaced to Claude through MCP tool results. */
export type ErrorCode =
  | 'config_missing'
  | 'not_found'
  | 'invalid_input'
  | 'lease_conflict'
  | 'lease_lost'
  | 'budget_exceeded'
  | 'concurrency_limit'
  | 'quota_exhausted'
  | 'provider_error'
  | 'worker_error'
  | 'navigation_blocked'
  | 'stale_ref'
  | 'blocked_by_site'
  | 'unauthorized_target'
  | 'forbidden'
  | 'timeout'
  | 'cancelled'
  | 'conflict'
  | 'internal';

export class RbaError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RbaError';
  }
}

export function asRbaError(e: unknown): RbaError {
  if (e instanceof RbaError) return e;
  if (e instanceof Error && e.name === 'AbortError') return new RbaError('cancelled', 'operation cancelled');
  return new RbaError('internal', e instanceof Error ? e.message : String(e));
}
