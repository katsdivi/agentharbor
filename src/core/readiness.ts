/**
 * Orchestrator side of navigation readiness (see actor/src/protocol.ts `Readiness`).
 *
 * Worker builds before capability 'readiness' reject the new request keys
 * (`readyWhen`, `settleMs`) as unknown. Internal callers (portal, signup,
 * scrape_extract defaults) then send the legacy request and get no readiness
 * report; an EXPLICIT readyWhen from the user is refused with config_missing
 * (redeploy), never silently ignored.
 */
import type { HealthResponse } from '../../actor/src/protocol.js';
import type { Ctx } from './context.js';
import { RbaError } from './errors.js';

const SUPPORT = new Map<string, boolean>();

export async function supportsReadiness(ctx: Ctx, sessionId: string): Promise<boolean> {
  const known = SUPPORT.get(sessionId);
  if (known !== undefined) return known;
  let ok = false;
  try {
    const h = await ctx.sessions.get(sessionId).client.call<HealthResponse>('/health', undefined, { timeoutMs: 15_000 });
    ok = (h.capabilities ?? []).includes('readiness');
  } catch {
    return false; // not cached: a transient failure must not pin the legacy path
  }
  if (SUPPORT.size > 1000) SUPPORT.clear();
  SUPPORT.set(sessionId, ok);
  return ok;
}

const NEW_KEYS = ['readyWhen', 'settleMs'] as const;

/**
 * Request body for a worker that may predate readiness. `explicit`: the user
 * asked for readyWhen/settleMs, so an old worker is an error, not a downgrade.
 */
export async function readinessBody<T extends Record<string, unknown>>(ctx: Ctx, sessionId: string, body: T, explicit: boolean): Promise<T> {
  if (!NEW_KEYS.some((k) => body[k] !== undefined)) return body;
  if (await supportsReadiness(ctx, sessionId)) return body;
  if (explicit) {
    throw new RbaError('config_missing', 'this browser worker build has no readiness support (readyWhen/settleMs). Redeploy the worker (npm run deploy-actor) and start a new session.');
  }
  const legacy: Record<string, unknown> = { ...body };
  for (const k of NEW_KEYS) delete legacy[k];
  return legacy as T;
}

/** A required readiness condition was not met (worker code condition_not_met). */
export function isConditionNotMet(e: unknown): boolean {
  return e instanceof RbaError && e.details?.workerCode === 'condition_not_met';
}
