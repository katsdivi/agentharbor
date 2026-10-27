import type { ExecutionMode, ResolvedRoute } from '../core/modes.js';

/** Per-run execution report (docs/dev/INTERFACES.md §6), plus the approved optional `files[].detail`. */
export interface ExecutionReport {
  reportVersion: 1;
  runId: string;
  jobId?: string;
  createdAt: string;
  requestedMode: ExecutionMode | null;
  effectiveMode: ExecutionMode;
  route: { proxy: ResolvedRoute['proxy']; verification: 'verified' | 'not_checked' | 'failed' | 'pending'; limits: string[] };
  account: { id: string; origin: string } | null; // reference only, never credentials
  files: Array<{
    artifactId: string;
    sha256: string;
    sanitization: string;
    detail?: {
      fileName: string | null;
      policy: string | null;
      policyVersion: number | null;
      verdict: string | null;
      findings: number;
      gaps: number;
      acceptanceDigest: string | null;
    };
  }>;
  confirmation: { kind: string; evidence: string } | null;
  cleanup: { pending: string[]; done: string[] };
  cost: { estimatedUsd: number | null; providerReportedUsd: number | null; basis: string };
  uncertain: string[];
}

/** What run_report returns: the report plus where it came from. */
export interface StoredReport {
  report: ExecutionReport;
  /** Snapshot taken at finalize (cost and cleanup are refreshed on read), or derived live from durable state. */
  source: 'finalized_snapshot' | 'derived_live';
  finalizedAt: string | null;
  sessionId: string | null;
}
