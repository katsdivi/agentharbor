import type {
  BlockSignal,
  EgressReport,
  InitResponse,
  PageSummary,
  ProxyMode,
  StateExportResponse,
  StatusResponse,
  WorkerInput,
  WorkerRoute,
} from '../../actor/src/protocol.js';
import type { BrowserProvider } from '../providers/types.js';
import { WorkerClient } from '../providers/worker-client.js';
import type { Accounts, AccountRow } from './accounts.js';
import type { Config } from './config.js';
import { randomToken, sha256Hex, type Vault } from './crypto.js';
import { newId, nowIso, type Db } from './db.js';
import { RbaError } from './errors.js';
import { describeMode, resolveRoute, type ExecutionMode, type ProxyKind, type ResolvedRoute } from './modes.js';
import { enqueueCleanup, runCleanupKind } from './recovery.js';
import { registerSecret, safeUrl } from './redact.js';
import type { Usage } from './usage.js';

export type SessionStatus = 'starting' | 'ready' | 'closing' | 'closed' | 'failed';

export interface SessionRow {
  id: string;
  provider: string;
  provider_run_id: string | null;
  container_url: string | null;
  token_blob: string | null;
  account_id: string | null;
  lease_id: string | null;
  proxy_mode: ProxyMode;
  execution_mode: ExecutionMode | null;
  route_json: string | null;
  status: SessionStatus;
  egress_json: string | null;
  memory_mb: number;
  max_minutes: number;
  purpose: string;
  created_at: string;
  ready_at: string | null;
  closed_at: string | null;
  last_activity_at: string | null;
  error: string | null;
}

interface Live {
  client: WorkerClient;
  row: SessionRow;
  /** Origins allowed for top-level navigation in this session. */
  allowedOrigins: string[];
}

export interface StartOptions {
  accountId?: string;
  /** Use an existing lease from account_acquire instead of taking a new one. */
  leaseId?: string;
  /** Execution mode (see src/core/modes.ts). Never falls back to another mode. */
  mode?: ExecutionMode;
  proxy?: { kind: ProxyKind; country?: string };
  /** Legacy: direct | datacenter | residential (remote modes only). */
  proxyMode?: ProxyMode;
  country?: string;
  maxMinutes?: number;
  restoreState?: boolean;
  purpose?: 'interactive' | 'register' | 'crawl' | 'operation';
  signal?: AbortSignal;
}

export interface SessionView {
  sessionId: string;
  status: SessionStatus;
  accountId: string | null;
  leaseId: string | null;
  proxyMode: ProxyMode;
  executionMode: ExecutionMode;
  route: SessionRoute;
  egress: EgressReport | null;
  restoredBrowserState: boolean | null;
  allowedNavigationOrigins: string[];
  /** Effective origins page resources may come from: navigation origins + RBA_SUBRESOURCE_ORIGINS. */
  allowedResourceOrigins: string[];
  createdAt: string;
  expiresAt: string;
  note?: string;
}

/** Where the session's requests originate and what was (not) verified about it. */
export interface SessionRoute {
  mode: ExecutionMode;
  provider: string;
  proxy: ResolvedRoute['proxy'];
  source: ResolvedRoute['source'] | 'stored';
  verification: 'verified' | 'not_checked' | 'failed' | 'pending';
  meaning: string;
  limits: string[];
}

export interface Providers {
  remote: BrowserProvider | null;
  local: BrowserProvider | null;
}

/** Local mode does not contact any IP-echo service: this URL is blocked by the worker's own policy, so no request leaves. */
const LOCAL_EGRESS_DISABLED = 'http://127.0.0.1:9/egress-check-disabled-in-local-mode';

export function routeLimits(mode: ExecutionMode): string[] {
  switch (mode) {
    case 'local':
      return [
        "Requests originate from this computer's network; no route check is performed in local mode.",
        'The browser uses a fresh temporary automation profile, not your personal browser profile.',
      ];
    case 'remote_direct':
      return ['Requests originate from the remote provider worker without a proxy. The reported egress IP is informational.'];
    case 'remote_proxy':
      return [
        "Verified means the browser's egress IP differed from the worker's direct IP at session start, through the requested proxy. It is not proof of location, of a stable IP for the whole session, or of anonymity.",
      ];
  }
}

export class Sessions {
  private readonly live = new Map<string, Live>();
  /** Sessions this process started: the only ones it closes on shutdown or heartbeats. */
  private readonly owned = new Set<string>();
  private heartbeat: NodeJS.Timeout | null = null;
  /** Test hook: allow http:// worker URLs created by the fake provider. */
  fetchImpl: typeof fetch = fetch;

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly accounts: Accounts,
    private readonly usage: Usage,
    private readonly providers: Providers,
  ) {}

  /** The provider for a mode. Never substitutes the other one. */
  requireProvider(mode: ExecutionMode = 'remote_direct'): BrowserProvider {
    if (mode === 'local') {
      if (!this.providers.local) throw new RbaError('config_missing', 'execution mode local is unavailable in this installation. Not falling back to a remote worker.');
      const why = this.providers.local.unavailableReason?.() ?? null;
      if (why) throw new RbaError('config_missing', `execution mode local is unavailable: ${why}. Not falling back to a remote worker.`);
      return this.providers.local;
    }
    if (!this.providers.remote) {
      throw new RbaError('config_missing', `execution mode ${mode} needs the remote browser provider (APIFY_TOKEN / APIFY_ACTOR_ID missing in .env). Not falling back to local execution.`);
    }
    return this.providers.remote;
  }

  /** Provider that owns a stored session/run (by recorded provider name). */
  providerFor(r: { provider: string }): BrowserProvider | null {
    if (r.provider === 'local') return this.providers.local;
    return this.providers.remote;
  }

  /** Effective resource origins for a navigation list (what the worker enforces after init). */
  resourceOriginsFor(nav: string[]): string[] {
    if (nav.includes('*') || this.cfg.subresourceOrigins.includes('*')) return ['*'];
    return [...new Set([...nav, ...this.cfg.subresourceOrigins])];
  }

  /** Origins a session bound to `acct` may navigate to. */
  originsFor(acct: AccountRow | null): string[] {
    if (!acct) return this.cfg.allowedOrigins;
    const t = this.cfg.targets.find((x) => x.origin === acct.target_origin);
    return [acct.target_origin, ...(t?.authOrigins ?? [])];
  }

  startHeartbeat(): void {
    if (this.heartbeat) return;
    const every = Math.max(5, Math.floor(this.cfg.limits.leaseTtlSecs / 3)) * 1000;
    this.heartbeat = setInterval(() => this.renewLeases(), every);
    this.heartbeat.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private renewLeases(): void {
    for (const l of this.live.values()) {
      if (!l.row.lease_id || !this.owned.has(l.row.id)) continue;
      try {
        this.accounts.renew(l.row.lease_id, this.cfg.limits.leaseTtlSecs);
      } catch {
        // Lease lost (expired and reclaimed elsewhere): stop using this account.
        this.db.log('warn', `session ${l.row.id} lost lease ${l.row.lease_id}`);
      }
    }
  }

  async start(o: StartOptions): Promise<SessionView> {
    const acct = o.accountId ? this.accounts.row(o.accountId) : null;
    const route = resolveRoute({ mode: o.mode, proxy: o.proxy, proxyMode: o.proxyMode, country: o.country, account: acct }, this.cfg);
    const provider = this.requireProvider(route.mode);
    const isLocal = route.mode === 'local';
    if (!this.vault.available) throw new RbaError('config_missing', 'RBA_ENCRYPTION_KEY missing; sessions need encrypted token storage');
    const maxMinutes = Math.min(o.maxMinutes ?? this.cfg.limits.maxSessionMinutes, this.cfg.limits.maxSessionMinutes);
    const memoryMb = this.cfg.apify.workerMemoryMb;
    const proxyMode: ProxyMode = route.workerProxyMode;

    const allowedOrigins = this.originsFor(acct);
    if (allowedOrigins.length === 0) {
      throw new RbaError('config_missing', 'RBA_ALLOWED_ORIGINS is empty: sessions without an account have no navigation origins. Set the exact origins to allow (or "*" explicitly for any public origin).');
    }

    // A previous holder whose lease lapsed (crashed orchestrator) may still have a
    // live remote browser on these cookies: stop it before anyone else uses them.
    if (acct) await this.reapAccount(acct.id);
    // Local runs have no provider bill: only the concurrency limit applies to them.
    const providerUsd = isLocal ? null : await this.usage.providerAccount();

    const id = newId('sess');
    let leaseId: string | null = null;
    let reclaimed = false;
    const token = randomToken();
    registerSecret(token);
    const created = nowIso();
    // Gate + lease + row insert in one IMMEDIATE transaction: parallel starts serialize.
    this.db.tx(() => {
      if (isLocal) this.usage.assertConcurrency();
      else this.usage.assertBudget(memoryMb, maxMinutes, proxyMode, providerUsd);
      if (acct) {
        if (o.leaseId) {
          this.accounts.assertUsable(acct.id);
          this.accounts.assertLease(acct.id, o.leaseId);
          leaseId = o.leaseId;
        } else {
          const l = this.accounts.acquire(acct.id, `session:${id}`, this.cfg.limits.leaseTtlSecs);
          leaseId = l.leaseId;
          reclaimed = l.reclaimedStale;
        }
      }
      this.db.run(
        `INSERT INTO sessions (id, provider, account_id, lease_id, proxy_mode, execution_mode, route_json, status, memory_mb, max_minutes, purpose, created_at, token_blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)`,
        id,
        provider.name,
        acct?.id ?? null,
        leaseId,
        proxyMode,
        route.mode,
        JSON.stringify({ proxy: route.proxy, source: route.source }),
        memoryMb,
        maxMinutes,
        o.purpose ?? 'interactive',
        created,
        this.vault.encrypt(token, `session:${id}:token`),
      );
    });
    this.owned.add(id);

    const input: WorkerInput = {
      protocolVersion: 1,
      tokenHash: sha256Hex(token),
      proxy: {
        mode: proxyMode,
        country: route.proxy?.country,
        sessionKey: route.mode === 'remote_proxy' ? (acct?.proxy_session_key ?? undefined) : undefined,
      },
      idleTimeoutSecs: this.cfg.limits.idleTimeoutSecs,
      maxLifetimeSecs: maxMinutes * 60,
      network: { allowedNavigationOrigins: allowedOrigins, allowedSubresourceOrigins: this.cfg.subresourceOrigins, allowPrivateHosts: this.cfg.allowPrivateHosts },
      egressCheckUrl: isLocal ? LOCAL_EGRESS_DISABLED : this.cfg.egressCheckUrl,
      maxUploadBytes: this.cfg.limits.maxUploadBytes,
    };
    let runId: string | null = null;
    try {
      const run = await provider.startRun({
        input,
        memoryMb,
        timeoutSecs: maxMinutes * 60 + 60,
        signal: o.signal,
        onRunCreated: (rid) => {
          runId = rid;
          this.db.run('UPDATE sessions SET provider_run_id = ? WHERE id = ?', rid, id);
        },
      });
      runId = run.runId;
      this.db.run('UPDATE sessions SET provider_run_id = ?, container_url = ? WHERE id = ?', run.runId, run.workerUrl, id);
      if (!isLocal) this.usage.record('apify_browser_run', run.runId, 0, 'compute_units', 0, 'estimate', { state: 'starting' });
      const client = new WorkerClient(run.workerUrl, token, this.fetchImpl);

      let restored = false;
      let storageState;
      if (acct && o.restoreState !== false) {
        storageState = this.accounts.loadState(acct.id) ?? undefined;
        restored = !!storageState;
      }
      const init = await client.call<InitResponse>('/session/init', { storageState }, { timeoutMs: 120_000, signal: o.signal });
      if (route.mode === 'remote_proxy' && init.egress.status !== 'verified') {
        throw new RbaError('provider_error', `proxy route could not be verified (${init.egress.note}); refusing to continue without the requested route`);
      }
      this.db.run(
        `UPDATE sessions SET status = 'ready', ready_at = ?, last_activity_at = ?, egress_json = ? WHERE id = ?`,
        nowIso(),
        nowIso(),
        JSON.stringify(init.egress),
        id,
      );
      const row = this.row(id);
      this.live.set(id, { client, row, allowedOrigins });
      this.startHeartbeat();
      return {
        ...this.view(row, allowedOrigins),
        restoredBrowserState: acct ? restored : null,
        note: [
          reclaimed ? 'A stale lease from a crashed holder was reclaimed; saved state may be outdated.' : '',
          restored ? 'Saved cookies/localStorage were loaded; verify the login is still valid before relying on it.' : '',
        ]
          .filter(Boolean)
          .join(' ') || undefined,
      };
    } catch (e) {
      this.db.run(`UPDATE sessions SET status = 'failed', closed_at = ?, error = ? WHERE id = ?`, nowIso(), (e as Error).message.slice(0, 500), id);
      let stopped = true;
      if (runId) {
        stopped = await provider
          .abortRun(runId)
          .then(() => true)
          .catch(() => false);
        if (!stopped) {
          // Not confirmed stopped: keep tracking the run (and keep the lease) until the cleanup queue confirms it.
          enqueueCleanup(this.db, { kind: runCleanupKind(provider), ref: runId, sessionId: id, accountId: acct?.id ?? null, error: 'abort after a failed start was not confirmed' });
        }
        await this.recordRunUsage(id).catch(() => undefined);
      }
      if (leaseId && !o.leaseId && stopped) this.accounts.release(leaseId);
      throw e;
    }
  }

  row(id: string): SessionRow {
    const r = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
    if (!r) throw new RbaError('not_found', `session ${id} not found`);
    return r;
  }

  view(r: SessionRow, allowedOrigins?: string[]): SessionView {
    return {
      sessionId: r.id,
      status: r.status,
      accountId: r.account_id,
      leaseId: r.lease_id,
      proxyMode: r.proxy_mode,
      executionMode: this.modeOf(r),
      route: this.routeOf(r),
      egress: r.egress_json ? (JSON.parse(r.egress_json) as EgressReport) : null,
      restoredBrowserState: null,
      allowedNavigationOrigins: allowedOrigins ?? this.originsFor(r.account_id ? this.safeAccount(r.account_id) : null),
      allowedResourceOrigins: this.resourceOriginsFor(allowedOrigins ?? this.originsFor(r.account_id ? this.safeAccount(r.account_id) : null)),
      createdAt: r.created_at,
      expiresAt: new Date(Date.parse(r.created_at) + r.max_minutes * 60_000).toISOString(),
    };
  }

  modeOf(r: SessionRow): ExecutionMode {
    return r.execution_mode ?? (r.proxy_mode === 'direct' ? 'remote_direct' : 'remote_proxy');
  }

  routeOf(r: SessionRow): SessionRoute {
    const mode = this.modeOf(r);
    let stored: { proxy: ResolvedRoute['proxy']; source: ResolvedRoute['source'] } | null = null;
    try {
      stored = r.route_json ? JSON.parse(r.route_json) : null;
    } catch {
      stored = null;
    }
    const egress = r.egress_json ? (JSON.parse(r.egress_json) as EgressReport) : null;
    const verification: SessionRoute['verification'] =
      mode !== 'remote_proxy' ? 'not_checked' : egress ? (egress.status === 'verified' ? 'verified' : 'failed') : r.status === 'failed' ? 'failed' : 'pending';
    return {
      mode,
      provider: r.provider,
      proxy: stored?.proxy ?? (mode === 'remote_proxy' ? { kind: r.proxy_mode as ProxyKind } : null),
      source: stored?.source ?? 'stored',
      verification,
      meaning: describeMode(mode),
      limits: routeLimits(mode),
    };
  }

  private safeAccount(id: string): AccountRow | null {
    try {
      return this.accounts.row(id);
    } catch {
      return null;
    }
  }

  /** Live handle; rehydrates sessions started by a previous MCP server process. */
  get(id: string): Live {
    const cached = this.live.get(id);
    if (cached) {
      cached.row = this.row(id);
      if (cached.row.status !== 'ready') throw new RbaError('conflict', `session ${id} is ${cached.row.status}`);
      return cached;
    }
    const r = this.row(id);
    if (r.status !== 'ready' || !r.container_url || !r.token_blob) throw new RbaError('conflict', `session ${id} is ${r.status}`);
    const token = this.vault.decrypt(r.token_blob, `session:${id}:token`).toString('utf8');
    registerSecret(token);
    const acct = r.account_id ? this.safeAccount(r.account_id) : null;
    const live: Live = { client: new WorkerClient(r.container_url, token, this.fetchImpl), row: r, allowedOrigins: this.originsFor(acct) };
    this.live.set(id, live);
    this.startHeartbeat();
    return live;
  }

  /** Account-bound sessions must still hold their lease before every command. */
  private checkLease(l: Live): void {
    if (l.row.account_id && l.row.lease_id) {
      this.accounts.assertUsable(l.row.account_id);
      this.accounts.assertLease(l.row.account_id, l.row.lease_id);
      this.accounts.renew(l.row.lease_id, this.cfg.limits.leaseTtlSecs);
    }
  }

  /** Execute a worker command with lease enforcement and block handling. */
  async call<T extends { page?: PageSummary | null }>(id: string, route: WorkerRoute, body?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal; query?: string } = {}): Promise<T> {
    const l = this.get(id);
    this.checkLease(l);
    let res: T;
    try {
      res = await l.client.call<T>(route, body, opts);
    } catch (e) {
      if (e instanceof RbaError && e.code === 'timeout' && (e.details?.clientTimeout || e.details?.recovery === 'terminated')) {
        // The operation may still be running remotely (no answer), or the worker could
        // not cancel it. Stop the run BEFORE the lease is released, so it cannot keep
        // acting on the account after someone else may hold it.
        const closed = await this.close(id).catch(() => null);
        throw new RbaError(
          'timeout',
          `${e.message}. The remote browser run was stopped so the operation cannot continue; the session is ${closed?.status ?? 'being closed'}${l.row.lease_id ? ' and its account lease is released only once the run is confirmed stopped' : ''}. Start a new session to continue.`,
          e.details,
        );
      }
      if (e instanceof RbaError && e.code === 'worker_error' && /unreachable/.test(e.message)) {
        await this.reapOne(this.row(id)).catch(() => undefined);
      }
      throw e;
    }
    this.db.run('UPDATE sessions SET last_activity_at = ? WHERE id = ?', nowIso(), id);
    if (res.page?.blocked) this.onBlocked(l.row, res.page.blocked, res.page.url);
    return res;
  }

  /** Stop-and-report: never solve, never swap account or proxy. */
  onBlocked(row: SessionRow, b: BlockSignal, url: string): void {
    this.db.log('warn', `session ${row.id} block signal ${b.kind} at ${safeUrl(url)}`);
    if (row.account_id) {
      this.accounts.quarantine(row.account_id, `${b.kind} at ${safeUrl(url)}: ${b.detail}`.slice(0, 300));
    }
  }

  async status(id: string): Promise<Record<string, unknown>> {
    const r = this.row(id);
    const out: Record<string, unknown> = { session: this.view(r), error: r.error };
    const statusProvider = this.providerFor(r);
    if (r.provider_run_id && statusProvider) {
      try {
        const info = await statusProvider.getRun(r.provider_run_id);
        out.providerRun = { state: info.state, statusMessage: info.statusMessage, runtimeSecs: info.runtimeSecs, usageUsd: info.usageUsd, usageBasis: info.usageUsd === null ? 'unavailable' : info.preliminary ? 'provider_preliminary' : 'provider_reconciled' };
        if (r.status === 'ready' && info.state !== 'running' && info.state !== 'starting') await this.reapOne(r);
      } catch (e) {
        out.providerRun = `unavailable: ${(e as Error).message}`;
      }
    }
    if (r.status === 'ready') {
      try {
        out.worker = await this.get(id).client.call<StatusResponse>('/status', undefined, { timeoutMs: 15_000 });
      } catch (e) {
        out.worker = `unreachable: ${(e as Error).message}`;
      }
    }
    return out;
  }

  async saveState(id: string): Promise<{ accountId: string; savedAt: string; cookieCount: number; originCount: number }> {
    const l = this.get(id);
    if (!l.row.account_id) throw new RbaError('invalid_input', 'session is not bound to an account; nothing to save state into');
    this.checkLease(l);
    const r = await l.client.call<StateExportResponse>('/state/export', {});
    this.accounts.saveState(l.row.account_id, r.storageState);
    return { accountId: l.row.account_id, savedAt: nowIso(), cookieCount: r.storageState.cookies.length, originCount: r.storageState.origins.length };
  }

  async close(id: string, o: { saveState?: boolean } = {}): Promise<Record<string, unknown>> {
    const r = this.row(id);
    if (r.status === 'closed' || r.status === 'failed') return { sessionId: id, status: r.status, alreadyClosed: true };
    let saved: unknown = null;
    if (o.saveState && r.account_id && r.status === 'ready') {
      try {
        saved = await this.saveState(id);
      } catch (e) {
        saved = `state not saved: ${(e as Error).message}`;
      }
    }
    this.db.run(`UPDATE sessions SET status = 'closing' WHERE id = ?`, id);
    const l = this.live.get(id);
    if (l) await l.client.call('/shutdown', {}, { timeoutMs: 10_000 }).catch(() => undefined);
    if (!(await this.stopRun(r))) {
      // Could not confirm the run stopped: keep the lease (it lapses on its own if
      // the run is gone; the reaper finishes the session once the run has ended).
      this.db.run(`UPDATE sessions SET error = ? WHERE id = ?`, 'abort not confirmed; lease kept until the run is confirmed stopped', id);
      const p = this.providerFor(r);
      if (r.provider_run_id && p) enqueueCleanup(this.db, { kind: runCleanupKind(p), ref: r.provider_run_id, sessionId: id, accountId: r.account_id, error: 'abort not confirmed at close' });
      return { sessionId: id, status: 'closing', stateSaved: saved, note: 'The remote run could not be confirmed stopped yet; the account lease is kept until it is.' };
    }
    this.finish(r, 'closed', null);
    const usage = await this.recordRunUsage(id).catch(() => null);
    return { sessionId: id, status: 'closed', stateSaved: saved, usage };
  }

  /** Abort the run; true once it is confirmed no longer running. */
  private async stopRun(r: SessionRow): Promise<boolean> {
    const provider = this.providerFor(r);
    if (!r.provider_run_id || !provider) return true;
    try {
      await provider.abortRun(r.provider_run_id);
      return true;
    } catch {
      try {
        const info = await provider.getRun(r.provider_run_id);
        return !['running', 'starting'].includes(info.state);
      } catch {
        return false;
      }
    }
  }

  private finish(r: SessionRow, status: SessionStatus, error: string | null): void {
    this.db.run(`UPDATE sessions SET status = ?, closed_at = ?, error = COALESCE(?, error) WHERE id = ?`, status, nowIso(), error, r.id);
    if (r.lease_id) this.accounts.release(r.lease_id);
    this.live.delete(r.id);
    this.owned.delete(r.id);
    this.onFinished?.(r.id);
  }

  /** Called once a session reaches closed/failed (the context snapshots its run report). */
  onFinished: ((sessionId: string) => void) | null = null;

  async recordRunUsage(id: string): Promise<Record<string, unknown> | null> {
    const r = this.row(id);
    const provider = this.providerFor(r);
    if (!r.provider_run_id || !provider) return null;
    if (provider.kind === 'local') return { usd: 0, basis: 'local_no_provider_charge' };
    const info = await provider.getRun(r.provider_run_id);
    this.usage.recordRun(info, r.memory_mb, r.created_at);
    return { usd: info.usageUsd, basis: info.usageUsd === null ? 'estimate' : info.preliminary ? 'provider_preliminary' : 'provider_reconciled', runtimeSecs: info.runtimeSecs };
  }

  /** Crash recovery for one session: if its run is gone, close it and free its lease. */
  async reapOne(r: SessionRow): Promise<boolean> {
    if (!['starting', 'ready', 'closing'].includes(r.status)) return false;
    const tooOld = Date.now() > Date.parse(r.created_at) + (r.max_minutes + 5) * 60_000;
    // An account session whose lease lapsed (holder crashed) must not keep a browser
    // on those cookies: another job may now hold the account.
    const leaseLapsed =
      !!r.lease_id && r.status !== 'starting' && !this.db.get('SELECT 1 FROM leases WHERE lease_id = ? AND expires_at > ?', r.lease_id, Date.now());
    let mustStop = tooOld || leaseLapsed;
    let reason = leaseLapsed ? 'account lease lapsed' : 'worker run ended or session expired';
    let ended = mustStop;
    const provider = this.providerFor(r);
    if (r.provider_run_id && provider) {
      let info: Awaited<ReturnType<BrowserProvider['getRun']>> | null = null;
      try {
        info = await provider.getRun(r.provider_run_id);
      } catch {
        info = null;
      }
      if (!info) {
        // Provider unreachable. Past its own hard timeout the provider has stopped the
        // run itself (tooOld > max_minutes + 5 > run timeout); otherwise the stop is
        // unconfirmed: keep the session open and let the cleanup queue retry.
        if (mustStop && !tooOld) {
          this.markStopPending(r, `${reason}; provider unreachable, stop not confirmed`);
          return false;
        }
      } else {
        const running = ['running', 'starting'].includes(info.state);
        if (running && r.proxy_mode === 'residential' && (info.residentialProxyGb ?? 0) > this.cfg.apify.residentialReserveGb) {
          mustStop = true;
          reason = `residential bandwidth reserve exceeded (${info.residentialProxyGb} GB > RBA_RESIDENTIAL_RESERVE_GB)`;
        }
        ended = mustStop || !running;
        if (mustStop && running) {
          const stopped = await provider
            .abortRun(r.provider_run_id)
            .then(() => true)
            .catch(() => false);
          if (!stopped) {
            this.markStopPending(r, `${reason}; abort failed`);
            return false;
          }
        }
        if (provider.kind === 'remote') this.usage.recordRun(info, r.memory_mb, r.created_at);
      }
    } else if (r.status === 'starting' && Date.now() - Date.parse(r.created_at) > 10 * 60_000) {
      ended = true;
    }
    if (ended) this.finish(r, r.status === 'closing' ? 'closed' : 'failed', `${reason} (reaped)`);
    return ended;
  }

  /** A run that must stop could not be confirmed stopped: lease kept, cleanup queued. */
  private markStopPending(r: SessionRow, why: string): void {
    this.db.run(`UPDATE sessions SET status = 'closing', error = ? WHERE id = ? AND status IN ('starting', 'ready', 'closing')`, why.slice(0, 500), r.id);
    const p = this.providerFor(r);
    if (r.provider_run_id && p) enqueueCleanup(this.db, { kind: runCleanupKind(p), ref: r.provider_run_id, sessionId: r.id, accountId: r.account_id, error: why });
  }

  /**
   * Called by the cleanup queue once a run is confirmed stopped: finish the
   * session and release its lease (also for a session already marked failed by a
   * start whose abort was unconfirmed).
   */
  confirmRunStopped(sessionId: string, note: string): void {
    const r = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', sessionId);
    if (!r) return;
    if (['starting', 'ready', 'closing'].includes(r.status)) this.finish(r, r.status === 'closing' ? 'closed' : 'failed', note);
    else if (r.lease_id) this.accounts.release(r.lease_id);
  }

  /** Recovery re-attached a job to this session: this process now owns (and closes) it. */
  adopt(sessionId: string): void {
    this.owned.add(sessionId);
  }

  /** Reap active sessions of one account (stale holders) before a new start. */
  async reapAccount(accountId: string): Promise<void> {
    for (const r of this.db.all<SessionRow>(`SELECT * FROM sessions WHERE account_id = ? AND status IN ('starting', 'ready', 'closing')`, accountId)) {
      if (!this.owned.has(r.id)) await this.reapOne(r);
    }
  }

  /** Startup/periodic sweep: reap dead sessions and drop expired leases. */
  async reapAll(): Promise<{ reaped: number; expiredLeases: number }> {
    let reaped = 0;
    for (const r of this.db.all<SessionRow>(`SELECT * FROM sessions WHERE status IN ('starting', 'ready', 'closing')`)) {
      if (await this.reapOne(r)) reaped++;
    }
    const expiredLeases = this.db.run('DELETE FROM leases WHERE expires_at <= ?', Date.now()).changes;
    return { reaped, expiredLeases };
  }

  /** Sessions started by this process (closed on shutdown). */
  ownedIds(): string[] {
    return [...this.owned];
  }
}
