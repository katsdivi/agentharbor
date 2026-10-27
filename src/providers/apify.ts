import { RbaError } from '../core/errors.js';
import type { AccountUsage, BrowserProvider, ProviderRun, RunInfo, RunState, StartRunOptions } from './types.js';

export interface ApifyProviderOptions {
  token: string;
  actorId: string;
  /** Build tag or number to run (Apify `build` run option). */
  build?: string;
  apiBaseUrl: string;
  /** How long to wait for the container web server to become ready. */
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Test harness only: accept http:// container URLs (the fake Apify API
   * serves local workers). Never set from environment variables.
   */
  allowInsecureContainerUrl?: boolean;
  fetchImpl?: typeof fetch;
}

interface ApifyRun {
  id: string;
  status: string;
  statusMessage?: string | null;
  containerUrl?: string;
  isContainerServerReady?: boolean;
  usageTotalUsd?: number | null;
  usage?: Record<string, number | null> | null;
  stats?: { computeUnits?: number; runTimeSecs?: number } | null;
  finishedAt?: string | null;
}

const TERMINAL: Record<string, RunState> = {
  SUCCEEDED: 'finished',
  FAILED: 'failed',
  'TIMED-OUT': 'timed_out',
  ABORTED: 'aborted',
};

/** Usage figures for a finished run may still change after it ends (Apify docs); before this quiet period they are provider_preliminary. */
const RECONCILE_QUIET_MS = 10 * 60 * 1000;

export class ApifyProvider implements BrowserProvider {
  readonly name = 'apify';
  readonly kind = 'remote' as const;
  private readonly f: typeof fetch;

  constructor(private readonly o: ApifyProviderOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  private async api<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.f(`${this.o.apiBaseUrl}/v2${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.o.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: { type?: string; message?: string } };
        msg = `${res.status} ${j.error?.type ?? ''}: ${j.error?.message ?? ''}`.trim();
      } catch {
        /* non-JSON error body: keep the status only */
      }
      const code = res.status === 401 || res.status === 403 ? 'config_missing' : res.status === 402 ? 'quota_exhausted' : 'provider_error';
      throw new RbaError(code, `Apify API ${method} ${path.split('?')[0]} failed: ${msg}`);
    }
    return (JSON.parse(text) as { data: T }).data;
  }

  async startRun(opts: StartRunOptions): Promise<ProviderRun> {
    const q = new URLSearchParams({ timeout: String(Math.ceil(opts.timeoutSecs)), memory: String(opts.memoryMb) });
    if (this.o.build) q.set('build', this.o.build);
    const run = await this.api<ApifyRun>('POST', `/actors/${encodeURIComponent(this.o.actorId)}/runs?${q}`, opts.input, opts.signal);
    try {
      opts.onRunCreated?.(run.id);
      return await this.waitReady(run.id, opts.signal);
    } catch (e) {
      // Never leave a billable run behind when startup fails or is cancelled.
      await this.abortRun(run.id).catch(() => undefined);
      throw e;
    }
  }

  private async waitReady(runId: string, signal?: AbortSignal): Promise<ProviderRun> {
    const deadline = Date.now() + (this.o.startupTimeoutMs ?? 180_000);
    const interval = this.o.pollIntervalMs ?? 1500;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const run = await this.api<ApifyRun>('GET', `/actor-runs/${runId}`);
      if (TERMINAL[run.status]) {
        throw new RbaError('provider_error', `worker run ended during startup: ${run.status} ${run.statusMessage ?? ''}`.trim());
      }
      if (run.status === 'RUNNING' && run.containerUrl) {
        const url = run.containerUrl.replace(/\/+$/, '');
        if (!url.startsWith('https://') && !this.o.allowInsecureContainerUrl) {
          throw new RbaError('provider_error', 'refusing non-HTTPS container URL');
        }
        // isContainerServerReady is not always present on the run object (observed live),
        // so probe the worker's unauthenticated /health endpoint directly.
        if (run.isContainerServerReady || (await this.healthy(url))) return { runId, workerUrl: url };
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new RbaError('timeout', 'worker did not become ready before the startup timeout');
  }

  private async healthy(url: string): Promise<boolean> {
    try {
      const r = await this.f(`${url}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!r.ok) return false;
      const j = (await r.json()) as { ok?: boolean; protocolVersion?: number };
      return j.ok === true && j.protocolVersion === 1;
    } catch {
      return false;
    }
  }

  async getRun(runId: string): Promise<RunInfo> {
    const run = await this.api<ApifyRun>('GET', `/actor-runs/${runId}`);
    const state: RunState = TERMINAL[run.status] ?? (run.status === 'RUNNING' ? 'running' : run.status === 'READY' ? 'starting' : run.status === 'ABORTING' || run.status === 'TIMING-OUT' ? 'running' : 'unknown');
    const finishedAt = run.finishedAt ?? null;
    // Apify gives no "final" signal; after this quiet period the figure is labelled
    // provider_reconciled (it can still change; the usage module re-reads it).
    const quietPeriodPassed = !!finishedAt && Date.now() - Date.parse(finishedAt) > RECONCILE_QUIET_MS;
    return {
      runId,
      state,
      statusMessage: run.statusMessage ?? null,
      usageUsd: typeof run.usageTotalUsd === 'number' ? run.usageTotalUsd : null,
      computeUnits: run.stats?.computeUnits ?? run.usage?.ACTOR_COMPUTE_UNITS ?? null,
      residentialProxyGb: run.usage?.PROXY_RESIDENTIAL_TRANSFER_GBYTES ?? null,
      runtimeSecs: run.stats?.runTimeSecs ?? null,
      preliminary: !quietPeriodPassed,
      finishedAt,
    };
  }

  async abortRun(runId: string): Promise<void> {
    try {
      await this.api('POST', `/actor-runs/${runId}/abort`);
    } catch (e) {
      // Aborting an already finished run is not an error for our purposes.
      const info = await this.getRun(runId).catch(() => null);
      if (!info || info.state === 'running' || info.state === 'starting') throw e;
    }
  }

  async accountUsage(): Promise<AccountUsage> {
    const d = await this.api<{
      monthlyUsageCycle?: { startAt?: string; endAt?: string };
      limits?: { maxMonthlyUsageUsd?: number };
      current?: { monthlyUsageUsd?: number };
    }>('GET', '/users/me/limits');
    return {
      monthlyUsageUsd: d.current?.monthlyUsageUsd ?? null,
      monthlyLimitUsd: d.limits?.maxMonthlyUsageUsd ?? null,
      cycleStart: d.monthlyUsageCycle?.startAt ?? null,
      cycleEnd: d.monthlyUsageCycle?.endAt ?? null,
    };
  }
}
