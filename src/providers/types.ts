import type { WorkerInput } from '../../actor/src/protocol.js';

/**
 * A browser provider runs one isolated worker (see actor/src/protocol.ts) per
 * session and exposes it over HTTP(S). Two exist:
 *  - `apify` (kind remote): execution modes remote_direct and remote_proxy;
 *  - `local` (kind local): execution mode local only, used solely when that mode
 *    is explicitly requested or configured. Target-site traffic then originates
 *    from this computer. Sessions never fall back from one provider to the other.
 */
export interface StartRunOptions {
  input: WorkerInput;
  memoryMb: number;
  timeoutSecs: number;
  signal?: AbortSignal;
  /** Called as soon as the provider has accepted the run (before it is ready), so a crash can't orphan it. */
  onRunCreated?: (runId: string) => void;
}

export interface ProviderRun {
  runId: string;
  /** Base URL of the worker HTTP server. */
  workerUrl: string;
}

export type RunState = 'starting' | 'running' | 'finished' | 'failed' | 'aborted' | 'timed_out' | 'unknown';

export interface RunInfo {
  runId: string;
  state: RunState;
  statusMessage: string | null;
  /** Provider-reported total cost in USD, when the API exposes it. */
  usageUsd: number | null;
  computeUnits: number | null;
  residentialProxyGb: number | null;
  runtimeSecs: number | null;
  /** True while the run is active or within the settling window after it ends. */
  preliminary: boolean;
  finishedAt: string | null;
}

export interface AccountUsage {
  monthlyUsageUsd: number | null;
  monthlyLimitUsd: number | null;
  cycleStart: string | null;
  cycleEnd: string | null;
}

export interface BrowserProvider {
  readonly name: string;
  readonly kind: 'remote' | 'local';
  /** Start a worker and wait until its HTTP server is ready. Aborts the run on failure. */
  startRun(opts: StartRunOptions): Promise<ProviderRun>;
  getRun(runId: string): Promise<RunInfo>;
  abortRun(runId: string): Promise<void>;
  accountUsage(): Promise<AccountUsage>;
  /** Why this provider cannot start a run right now (checked before any row is written), or null. */
  unavailableReason?(): string | null;
}
