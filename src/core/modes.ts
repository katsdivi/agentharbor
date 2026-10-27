/**
 * Execution modes: where a session's browser and HTTP requests originate.
 *
 *  - local          the worker runs on this computer with a fresh temporary
 *                   automation profile; requests originate from this computer's
 *                   network. Never reads or imports the personal browser profile.
 *  - remote_direct  the remote (Apify) worker without a proxy; requests originate
 *                   from the provider's worker. Default for existing installs.
 *  - remote_proxy   the remote worker through the requested proxy
 *                   (datacenter | residential). Fails closed when the proxy cannot
 *                   be obtained or its route cannot be verified.
 *
 * Resolution never falls back from one mode to another: a mode that cannot be
 * honoured is refused with an error naming what is missing.
 */
import type { ProxyMode } from '../../actor/src/protocol.js';
import type { Config } from './config.js';
import { RbaError } from './errors.js';

export const EXECUTION_MODES = ['local', 'remote_direct', 'remote_proxy'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type ProxyKind = 'datacenter' | 'residential';

export interface ResolvedRoute {
  mode: ExecutionMode;
  /** Non-null only for remote_proxy. */
  proxy: { kind: ProxyKind; country?: string } | null;
  source: 'explicit' | 'account' | 'config_default' | 'legacy_proxyMode';
  /** Proxy mode actually sent to the worker. */
  workerProxyMode: ProxyMode;
}

export interface RouteRequest {
  mode?: ExecutionMode;
  proxy?: { kind: ProxyKind; country?: string };
  /** Legacy parameter: direct | datacenter | residential (remote only). */
  proxyMode?: ProxyMode;
  country?: string;
  account?: { id: string; execution_mode: string | null; proxy_mode: string; proxy_country: string | null } | null;
}

export function isExecutionMode(v: unknown): v is ExecutionMode {
  return typeof v === 'string' && (EXECUTION_MODES as readonly string[]).includes(v);
}

/** Documented derivation for rows and parameters that predate execution modes. */
export function modeFromLegacy(proxyMode: string | null | undefined): ExecutionMode {
  return proxyMode === 'datacenter' || proxyMode === 'residential' ? 'remote_proxy' : 'remote_direct';
}

export function describeMode(m: ExecutionMode): string {
  switch (m) {
    case 'local':
      return 'runs on this computer (requests originate from this network) with a temporary automation profile; never uses your personal browser profile';
    case 'remote_direct':
      return 'runs on the remote provider; requests originate from the provider worker without a proxy';
    case 'remote_proxy':
      return 'runs on the remote provider through the requested proxy; refused if the proxy route cannot be obtained or verified';
  }
}

function upperCountry(c: string | null | undefined): string | undefined {
  return c ? c.toUpperCase() : undefined;
}

/**
 * Resolve the route for a session. Precedence: explicit mode (or legacy
 * proxyMode) > the account's bound mode > configuration default.
 * Throws invalid_input on contradictions; never coerces.
 */
export function resolveRoute(req: RouteRequest, cfg: Pick<Config, 'proxy'> & { defaultExecutionMode?: ExecutionMode | null }): ResolvedRoute {
  if (req.mode !== undefined && !isExecutionMode(req.mode)) throw new RbaError('invalid_input', `unknown execution mode ${String(req.mode)}; use local | remote_direct | remote_proxy`);

  // 1. What the caller asked for.
  let mode: ExecutionMode | undefined = req.mode;
  let source: ResolvedRoute['source'] = 'explicit';
  let kind: ProxyKind | undefined = req.proxy?.kind;
  if (req.proxyMode !== undefined) {
    if (mode === undefined) {
      mode = modeFromLegacy(req.proxyMode);
      source = 'legacy_proxyMode';
    } else if (mode !== 'remote_proxy' && req.proxyMode !== 'direct') {
      throw new RbaError('invalid_input', `mode ${mode} cannot use proxyMode ${req.proxyMode}; use mode remote_proxy for a proxied route`);
    } else if (mode === 'remote_proxy' && req.proxyMode === 'direct') {
      throw new RbaError('invalid_input', 'mode remote_proxy needs a proxy (datacenter or residential), not proxyMode direct');
    }
    if (req.proxyMode !== 'direct') {
      if (kind && kind !== req.proxyMode) throw new RbaError('invalid_input', `proxy.kind ${kind} contradicts proxyMode ${req.proxyMode}`);
      kind = req.proxyMode;
    }
  }
  const country = upperCountry(req.proxy?.country ?? req.country);

  // 2. Account binding: an account's cookies were created on one route; never move them silently.
  const acct = req.account ?? null;
  if (acct) {
    const bound: ExecutionMode = isExecutionMode(acct.execution_mode) ? acct.execution_mode : modeFromLegacy(acct.proxy_mode);
    if (mode === undefined) {
      mode = bound;
      source = 'account';
    } else if (mode !== bound) {
      throw new RbaError('invalid_input', `account ${acct.id} is bound to execution mode ${bound}; refusing to switch routes silently (requested ${mode})`);
    }
    if (bound === 'remote_proxy') {
      const acctKind = acct.proxy_mode as ProxyKind;
      if (kind && kind !== acctKind) throw new RbaError('invalid_input', `account ${acct.id} is configured for proxy ${acctKind}; refusing to switch routes silently`);
      kind = acctKind;
      const acctCountry = upperCountry(acct.proxy_country);
      if (acctCountry && country && country !== acctCountry) {
        throw new RbaError('invalid_input', `account ${acct.id} is configured for proxy country ${acctCountry}; refusing to switch routes silently (requested ${country})`);
      }
    }
  }

  // 3. Configuration default.
  if (mode === undefined) {
    if (cfg.defaultExecutionMode) {
      mode = cfg.defaultExecutionMode;
    } else {
      mode = modeFromLegacy(cfg.proxy.defaultMode);
      if (mode === 'remote_proxy') kind = kind ?? (cfg.proxy.defaultMode as ProxyKind);
    }
    source = 'config_default';
    if (mode === 'remote_proxy' && !kind && cfg.proxy.defaultMode !== 'direct') kind = cfg.proxy.defaultMode as ProxyKind;
  }

  if (mode === 'remote_proxy') {
    if (!kind) throw new RbaError('invalid_input', 'mode remote_proxy needs proxy.kind (datacenter or residential)');
    const c = country ?? upperCountry(acct?.proxy_country) ?? upperCountry(cfg.proxy.country);
    return { mode, proxy: c ? { kind, country: c } : { kind }, source, workerProxyMode: kind };
  }
  if (kind) throw new RbaError('invalid_input', `mode ${mode} does not use a proxy; remove proxy settings or use mode remote_proxy`);
  if (req.country) throw new RbaError('invalid_input', `country applies only to mode remote_proxy (requested mode ${mode})`);
  return { mode, proxy: null, source, workerProxyMode: 'direct' };
}
