/**
 * Per-run execution reports (docs/dev/INTERFACES.md §6).
 *
 * Reports are DERIVED from durable state: the sessions row (execution mode,
 * stored route, egress), usage rows, file artifacts and acceptances, the jobs
 * that ran in the session (params/result), and W2's cleanup queue (through an
 * exported `pendingCleanup(ctx, {jobId?, sessionId?})` when it is present).
 * `finalizeSession` / `finalizeJob` snapshot the derived report into
 * `run_reports`. Reading a finalized report refreshes only the fields that
 * legitimately change afterwards: provider-reported cost and cleanup.
 *
 * Reports contain references (account id and origin, artifact ids and
 * hashes), never credentials, page text or file names other than the one sent.
 * Everything is passed through redactDeep before it is stored.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../core/context.js';
import { nowIso } from '../core/db.js';
import { RbaError } from '../core/errors.js';
import type { ExecutionMode } from '../core/modes.js';
import { redactDeep } from '../core/redact.js';
import type { SessionRow } from '../core/sessions.js';
import { sanitizationStatus } from '../files/acceptance.js';
import type { FileRow } from '../files/registry.js';
import type { ExecutionReport, StoredReport } from './types.js';

export type { ExecutionReport, StoredReport } from './types.js';

export interface ReportRef {
  runId?: string;
  jobId?: string;
  sessionId?: string;
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  session_id: string | null;
  params_json: string;
  result_json: string | null;
  submitted_at: string | null;
  created_at: string;
}

type PendingCleanup = (ctx: Ctx, ref: { jobId?: string; sessionId?: string }) => unknown;

/** Optional W2 hook; resolved lazily so this module works with or without it. */
let pendingCleanupFn: PendingCleanup | null | undefined;
async function loadPendingCleanup(): Promise<PendingCleanup | null> {
  if (pendingCleanupFn !== undefined) return pendingCleanupFn;
  pendingCleanupFn = null;
  for (const spec of ['../core/recovery.js', '../core/jobs.js']) {
    try {
      const m = (await import(spec)) as { pendingCleanup?: PendingCleanup };
      if (typeof m.pendingCleanup === 'function') {
        pendingCleanupFn = m.pendingCleanup;
        break;
      }
    } catch {
      /* module absent */
    }
  }
  return pendingCleanupFn;
}

/** Test hook: replace (or remove with null) the cleanup source. */
export function setPendingCleanupForTests(fn: PendingCleanup | null | undefined): void {
  pendingCleanupFn = fn;
}

const parse = <T>(s: string | null | undefined): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export class Reports {
  constructor(private readonly ctx: Ctx) {}

  // ---------------------------------------------------------------- resolution

  private resolve(ref: ReportRef): { session: SessionRow; jobs: JobRow[]; jobId: string | undefined } {
    const db = this.ctx.db;
    let session: SessionRow | undefined;
    let jobId = ref.jobId;
    if (ref.sessionId) session = db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', ref.sessionId);
    else if (ref.runId) session = db.get<SessionRow>('SELECT * FROM sessions WHERE provider_run_id = ?', ref.runId);
    else if (ref.jobId) {
      const j = db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', ref.jobId);
      if (!j) throw new RbaError('not_found', `job ${ref.jobId} not found`);
      if (!j.session_id) throw new RbaError('not_found', `job ${ref.jobId} (${j.kind}) started no browser session, so there is no run to report; its result is in job_status`);
      session = db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', j.session_id);
    } else throw new RbaError('invalid_input', 'provide one of runId, jobId or sessionId');
    if (!session) throw new RbaError('not_found', 'no browser session found for that reference');
    const jobs = db.all<JobRow>('SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at', session.id);
    if (!jobId && jobs.length) jobId = jobs[jobs.length - 1]!.id;
    return { session, jobs, jobId };
  }

  // ---------------------------------------------------------------- derivation

  /** Build the report from durable state (no snapshot involved). */
  async derive(ref: ReportRef): Promise<{ report: ExecutionReport; sessionId: string }> {
    const { session: s, jobs, jobId } = this.resolve(ref);
    const ctx = this.ctx;
    const uncertain: string[] = [];
    const route = ctx.sessions.routeOf(s);
    const stored = parse<{ source?: string }>(s.route_json);
    const effectiveMode: ExecutionMode = route.mode;
    const requestedMode: ExecutionMode | null = stored?.source === 'explicit' || stored?.source === 'legacy_proxyMode' ? effectiveMode : null;
    const limits = [...route.limits];
    if (stored?.source && requestedMode === null) limits.push(`The mode was not requested explicitly; it came from ${stored.source === 'account' ? "the account's stored mode" : stored.source === 'config_default' ? 'the configured default' : stored.source}.`);
    if (!stored) limits.push('The session predates stored routes; its mode was derived from the legacy proxy setting.');
    let verification: ExecutionReport['route']['verification'];
    if (effectiveMode === 'local') verification = 'not_checked';
    else if (route.verification === 'verified') verification = 'verified';
    else if (route.verification === 'failed') verification = 'failed';
    else {
      verification = 'not_checked';
      if (route.verification === 'pending') uncertain.push('Route verification had not completed when this report was derived.');
    }

    const acct = s.account_id ? ctx.db.get<{ id: string; target_origin: string }>('SELECT id, target_origin FROM accounts WHERE id = ?', s.account_id) : null;
    const account = s.account_id ? { id: s.account_id, origin: acct?.target_origin ?? '[account deleted]' } : null;

    // Files: artifacts uploaded by jobs that ran in this session.
    const files: ExecutionReport['files'] = [];
    let confirmation: ExecutionReport['confirmation'] = null;
    for (const j of jobs) {
      if (j.kind !== 'portal_upload') continue;
      const p = parse<{ artifactId?: string; requireSanitized?: boolean }>(j.params_json) ?? {};
      const r = parse<{ outcome?: string; stages?: Record<string, unknown>; artifact?: { uploadedFileName?: string }; destination?: { sizeMatches?: boolean | null; sha256Matches?: boolean | null } }>(j.result_json);
      if (p.artifactId) files.push(this.fileEntry(p.artifactId, j, r?.artifact?.uploadedFileName ?? null));
      if (j.id === jobId || !confirmation) confirmation = this.confirmationOf(j, r, uncertain);
    }
    if (!jobs.some((j) => j.kind === 'portal_upload') && s.purpose === 'interactive') {
      uncertain.push('Files sent interactively with browser_upload in this session are not itemised in this report.');
    }

    const cleanup = await this.cleanupOf(s, jobs, uncertain);
    const cost = this.costOf(s, uncertain);
    const report: ExecutionReport = {
      reportVersion: 1,
      runId: s.provider_run_id ?? `session:${s.id}`,
      ...(jobId ? { jobId } : {}),
      createdAt: s.created_at,
      requestedMode,
      effectiveMode,
      route: { proxy: route.proxy, verification, limits },
      account,
      files,
      confirmation,
      cleanup,
      cost,
      uncertain,
    };
    if (!s.provider_run_id) uncertain.push('The provider run id was not recorded (the session may not have started).');
    return { report: redactDeep(report), sessionId: s.id };
  }

  private fileEntry(artifactId: string, j: JobRow, fileName: string | null): ExecutionReport['files'][number] {
    const f = this.ctx.db.get<FileRow>('SELECT * FROM files WHERE id = ?', artifactId);
    const acc = this.ctx.db.get<{ report_digest: string }>('SELECT report_digest FROM file_acceptances WHERE job_id = ? AND artifact_id = ? ORDER BY accepted_at DESC LIMIT 1', j.id, artifactId);
    if (!f) return { artifactId, sha256: '', sanitization: 'unknown artifact' };
    if (f.status === 'deleted') {
      return { artifactId, sha256: f.sha256, sanitization: `${f.origin === 'sanitized' ? `sanitized (${f.verdict ?? 'no verdict'} under ${f.policy ?? '?'})` : 'original (not sanitized)'}; the plugin copy was deleted since, and its stored report with it`, detail: { fileName, policy: f.policy, policyVersion: f.policy_version ?? null, verdict: f.verdict, findings: 0, gaps: 0, acceptanceDigest: acc ? `acc1:${acc.report_digest}` : null } };
    }
    if (f.origin !== 'sanitized') {
      return { artifactId, sha256: f.sha256, sanitization: 'original (not sanitized)', detail: { fileName, policy: null, policyVersion: null, verdict: null, findings: 0, gaps: 0, acceptanceDigest: null } };
    }
    const st = sanitizationStatus(this.ctx, f);
    const fg = `${st.retainedFindings.length} retained finding(s), ${st.inspectionGaps.length} inspection gap(s)`;
    return {
      artifactId,
      sha256: f.sha256,
      sanitization: `${f.verdict ?? 'no verdict'} under ${f.policy}@${st.policyVersion ?? 'unversioned'}${st.stale ? ' (stale verification)' : ''}; ${fg}${acc ? '; accepted by digest' : ''}`,
      detail: { fileName, policy: f.policy, policyVersion: st.policyVersion, verdict: f.verdict, findings: st.retainedFindings.length, gaps: st.inspectionGaps.length, acceptanceDigest: acc ? `acc1:${acc.report_digest}` : null },
    };
  }

  /** A descriptor of what matched; page text is never copied (it is untrusted and could carry injected instructions). */
  private confirmationOf(j: JobRow, r: { outcome?: string; destination?: { sizeMatches?: boolean | null; sha256Matches?: boolean | null } } | null, uncertain: string[]): ExecutionReport['confirmation'] {
    if (!r?.outcome) {
      uncertain.push(`Job ${j.id} (${j.status}) has no recorded outcome${j.submitted_at ? ', and it may already have sent the file' : ''}.`);
      return null;
    }
    const d = r.destination ?? {};
    const extra = [d.sha256Matches === true ? 'the SHA-256 shown by the portal equals the artifact' : d.sha256Matches === false ? 'the SHA-256 shown by the portal DIFFERS' : null, d.sizeMatches === true ? 'the size shown equals the artifact' : d.sizeMatches === false ? 'the size shown DIFFERS' : null].filter(Boolean);
    const base: Record<string, string> = {
      portal_confirmed: 'the portal showed the configured confirmation',
      sent_unconfirmed: 'the form was submitted, but no configured confirmation matched',
      outcome_unknown: 'the submit did not complete in time; the page was inspected; the file may or may not have been received',
      needs_input: 'inspection only; no file was selected',
    };
    if (r.outcome === 'outcome_unknown' || r.outcome === 'sent_unconfirmed') uncertain.push(`Upload outcome of job ${j.id}: ${r.outcome}; check the portal before any retry.`);
    return { kind: r.outcome, evidence: [base[r.outcome] ?? r.outcome, ...extra].join('; ') };
  }

  private async cleanupOf(s: SessionRow, jobs: JobRow[], uncertain: string[]): Promise<ExecutionReport['cleanup']> {
    const pending: string[] = [];
    const done: string[] = [];
    if (s.status === 'closed' || s.status === 'failed') done.push(`session ${s.id} ${s.status}; ${s.provider === 'local' ? 'local worker process stopped' : 'remote worker run ended'}${s.closed_at ? ` at ${s.closed_at}` : ''}`);
    else pending.push(`session ${s.id} is ${s.status}; its worker run has not ended`);
    if (s.provider === 'local' && s.provider_run_id) {
      const nonce = s.provider_run_id.split(':')[2];
      if (nonce && existsSync(join(this.ctx.cfg.dataDir, 'local-runs', nonce))) pending.push('the local run directory (temporary browser profile and storage) still exists');
      else if (nonce) done.push('local run directory removed');
    }
    for (const j of jobs) {
      const locked = this.ctx.db.all<{ id: string }>('SELECT id FROM files WHERE locked_by = ? AND lock_expires > ?', j.id, Date.now());
      for (const l of locked) pending.push(`artifact ${l.id} is still locked by job ${j.id}`);
    }
    const fn = await loadPendingCleanup();
    if (!fn) {
      uncertain.push('Cleanup queue status is unknown (the cleanup queue is not available in this build).');
    } else {
      try {
        const items = (await fn(this.ctx, { sessionId: s.id, ...(jobs.length ? { jobId: jobs[jobs.length - 1]!.id } : {}) })) as unknown;
        for (const it of Array.isArray(items) ? items : []) pending.push(typeof it === 'string' ? it : JSON.stringify(it));
      } catch {
        uncertain.push('Cleanup queue status could not be read.');
      }
    }
    return { pending, done };
  }

  private costOf(s: SessionRow, uncertain: string[]): ExecutionReport['cost'] {
    if (s.provider === 'local') return { estimatedUsd: 0, providerReportedUsd: null, basis: 'local run: no provider charge; local compute and network use are not measured' };
    const plan = this.ctx.usage.sessionEstimate(s.memory_mb, s.max_minutes, s.proxy_mode).totalUsd;
    const u = s.provider_run_id ? this.ctx.db.get<{ usd: number | null; basis: string }>(`SELECT usd, basis FROM usage WHERE kind = 'apify_browser_run' AND ref = ?`, s.provider_run_id) : undefined;
    if (!u || u.usd === null) return { estimatedUsd: plan, providerReportedUsd: null, basis: 'planning estimate for the session (no run usage recorded yet)' };
    if (u.basis === 'provider_reconciled') return { estimatedUsd: plan, providerReportedUsd: u.usd, basis: 'provider-reported run usage (reconciled); estimate is the session planning estimate' };
    if (u.basis === 'provider_preliminary') {
      uncertain.push('The provider-reported cost is preliminary and may still change.');
      return { estimatedUsd: plan, providerReportedUsd: u.usd, basis: 'provider-reported run usage (preliminary); estimate is the session planning estimate' };
    }
    return { estimatedUsd: u.usd, providerReportedUsd: null, basis: 'local estimate from runtime x memory x configured CU price (provider figure not read yet)' };
  }

  // ---------------------------------------------------------------- storage

  private store(report: ExecutionReport, sessionId: string, kind: string): void {
    const t = nowIso();
    const id = `rpt_${sessionId}`;
    const json = JSON.stringify(redactDeep(report));
    this.ctx.db.run(
      `INSERT INTO run_reports (id, run_id, job_id, session_id, kind, report_version, report_json, finalized, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, job_id = excluded.job_id, kind = excluded.kind, report_json = excluded.report_json, finalized = 1, updated_at = excluded.updated_at`,
      id,
      report.runId.startsWith('session:') ? null : report.runId,
      report.jobId ?? null,
      sessionId,
      kind,
      report.reportVersion,
      json,
      t,
      t,
    );
  }

  /** Snapshot the report of a session (call when it closes). */
  async finalizeSession(sessionId: string): Promise<ExecutionReport> {
    const { report, sessionId: sid } = await this.derive({ sessionId });
    this.store(report, sid, 'session');
    return report;
  }

  /**
   * Snapshot the report of a job's session (call when the job reaches a terminal state).
   * Jobs that never started a browser session (e.g. media_sanitize) have no run: returns null.
   */
  async finalizeJob(jobId: string): Promise<ExecutionReport | null> {
    const j = this.ctx.db.get<{ session_id: string | null }>('SELECT session_id FROM jobs WHERE id = ?', jobId);
    if (!j || !j.session_id) return null;
    const { report, sessionId } = await this.derive({ jobId });
    this.store(report, sessionId, 'job');
    return report;
  }

  /** The finalized snapshot (cost and cleanup refreshed) or a live derivation. */
  async get(ref: ReportRef): Promise<StoredReport> {
    const db = this.ctx.db;
    let row: { report_json: string; session_id: string | null; updated_at: string } | undefined;
    if (ref.sessionId) row = db.get('SELECT report_json, session_id, updated_at FROM run_reports WHERE session_id = ? AND finalized = 1', ref.sessionId);
    else if (ref.runId) row = db.get('SELECT report_json, session_id, updated_at FROM run_reports WHERE run_id = ? AND finalized = 1', ref.runId);
    else if (ref.jobId) {
      row = db.get('SELECT report_json, session_id, updated_at FROM run_reports WHERE job_id = ? AND finalized = 1', ref.jobId);
      if (!row) {
        const j = db.get<{ session_id: string | null }>('SELECT session_id FROM jobs WHERE id = ?', ref.jobId);
        if (j?.session_id) row = db.get('SELECT report_json, session_id, updated_at FROM run_reports WHERE session_id = ? AND finalized = 1', j.session_id);
      }
    }
    if (row) {
      const snap = parse<ExecutionReport>(row.report_json);
      if (snap) {
        try {
          const live = await this.derive({ sessionId: row.session_id ?? undefined, runId: row.session_id ? undefined : snap.runId });
          snap.cost = live.report.cost;
          snap.cleanup = live.report.cleanup;
        } catch {
          snap.uncertain = [...snap.uncertain, 'Cost and cleanup could not be refreshed (the session record is gone); values are as of the snapshot.'];
        }
        return { report: redactDeep(snap), source: 'finalized_snapshot', finalizedAt: row.updated_at, sessionId: row.session_id };
      }
    }
    const { report, sessionId } = await this.derive(ref);
    return { report, source: 'derived_live', finalizedAt: null, sessionId };
  }
}
