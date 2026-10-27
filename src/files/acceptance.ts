/**
 * Acceptance of retained findings / inspection gaps, bound to exact state.
 *
 * `reportDigest` is the SHA-256 of a canonical JSON (sorted keys, sorted
 * finding lists) of: artifact id and SHA-256, source SHA-256, policy and
 * policy version, verdict, residual, retained findings, inspection gaps and the
 * verification id (a random nonce per sanitize/verify run). Timestamps, tool
 * versions and free-text `detail` strings are excluded.
 *
 * `acceptanceDigest` = "acc1:" + reportDigest. portal_upload (and
 * browser_upload with an artifact) requires exactly this string, recomputed
 * from the CURRENT stored state, so an acceptance cannot carry over to another
 * artifact, a new sanitize or verify run, or a policy version change.
 *
 * Limit: this binds the decision to the state the user was shown; it cannot
 * prove that a person saw it. A model holding the digest can pass it on
 * without asking, exactly as it could pass the old boolean.
 */
import { createHash } from 'node:crypto';
import type { Ctx } from '../core/context.js';
import { newId, nowIso } from '../core/db.js';
import { RbaError } from '../core/errors.js';
import { POLICY_VERSIONS, summarize, type VerifyReport } from './media.js';
import type { FileRow } from './registry.js';

export const ACCEPTANCE_PREFIX = 'acc1:';
export const ACCEPTANCE_RE = /^acc1:[0-9a-f]{64}$/;

type Finding = VerifyReport['retainedFindings'][number];

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const sorted = <T>(xs: T[]): T[] => [...xs].map((x) => [canonical(x), x] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);

export interface DigestInput {
  artifactId: string;
  artifactSha256: string;
  sourceSha256: string | null;
  policy: string;
  policyVersion: number | null;
  verdict: string | null;
  residual: unknown[];
  retainedFindings: Finding[];
  inspectionGaps: string[];
  verificationId: string | null;
}

export function reportDigest(d: DigestInput): string {
  const body = {
    v: 1,
    artifactId: d.artifactId,
    artifactSha256: d.artifactSha256,
    sourceSha256: d.sourceSha256,
    policy: d.policy,
    policyVersion: d.policyVersion,
    verdict: d.verdict,
    residual: sorted((d.residual as Array<Record<string, unknown>>).map((r) => ({ category: r.category, name: r.name, where: r.where }))),
    retainedFindings: sorted(d.retainedFindings.map((f) => ({ category: f.category, name: f.name, where: f.where, count: f.count }))),
    inspectionGaps: sorted(d.inspectionGaps),
    verificationId: d.verificationId,
  };
  return createHash('sha256').update(canonical(body)).digest('hex');
}

/** What is known about an artifact's sanitization, from its stored verification report. */
export interface SanitizationStatus {
  origin: string;
  policy: string | null;
  verdict: string | null;
  summary: string | null;
  residual: unknown[];
  retainedFindings: Finding[];
  inspectionGaps: string[];
  /** Version of the inspection policy that produced the stored verification (null: before versions existed). */
  policyVersion: number | null;
  currentPolicyVersion: number | null;
  /** The stored verification is older than the current policy (or unversioned). */
  stale: boolean;
  /** The source is gone, so the stored verification can no longer be re-run. */
  frozen: boolean;
  verificationId: string | null;
  verifiedAt: string | null;
  reportDigest: string | null;
  /** Pass this as acceptRetainedFindings after the user accepted the findings and gaps above (null when none are needed). */
  acceptanceDigest: string | null;
}

export function sanitizationStatus(ctx: Ctx, idOrRow: string | FileRow): SanitizationStatus {
  const f = typeof idOrRow === 'string' ? ctx.files.row(idOrRow) : idOrRow;
  let stored: { verification?: Partial<VerifyReport>; sourceSha256?: string } = {};
  try {
    stored = JSON.parse(f.report_json ?? '{}');
  } catch {
    stored = {};
  }
  const v = stored.verification ?? {};
  const current = f.policy ? (POLICY_VERSIONS[f.policy] ?? null) : null;
  const pv = v.policyVersion ?? f.policy_version ?? null;
  const verificationId = v.verificationId ?? f.verification_id ?? null;
  const stale = f.origin === 'sanitized' && (pv === null || current === null || pv < current || !verificationId || v.retainedFindings === undefined || v.inspectionGaps === undefined);
  let frozen = false;
  if (f.origin === 'sanitized' && f.source_id) {
    const src = ctx.db.get<{ status: string }>('SELECT status FROM files WHERE id = ?', f.source_id);
    frozen = !src || src.status !== 'ready';
  }
  const gaps = [...(v.inspectionGaps ?? [])];
  if (stale) {
    gaps.push(
      `the stored verification was made under ${f.policy ?? 'an unknown policy'}${pv ? `@${pv}` : ' before policy versions existed'}; the current inspection is ${f.policy ?? '?'}@${current ?? '?'}${frozen ? ' and it cannot be re-run because the source artifact was deleted' : '; run media_verify on this artifact'}`,
    );
  }
  const findings = v.retainedFindings ?? [];
  const residual = v.residual ?? [];
  const digest =
    f.origin === 'sanitized'
      ? reportDigest({
          artifactId: f.id,
          artifactSha256: f.sha256,
          sourceSha256: stored.sourceSha256 ?? null,
          policy: f.policy ?? '',
          policyVersion: pv,
          verdict: f.verdict,
          residual,
          retainedFindings: findings,
          inspectionGaps: gaps,
          verificationId,
        })
      : null;
  return {
    origin: f.origin,
    policy: f.policy,
    verdict: f.verdict,
    summary: f.origin === 'sanitized' && v.verdict ? summarize({ verdict: v.verdict, policy: v.policy ?? f.policy ?? '', residual, retainedFindings: findings, inspectionGaps: gaps }) : null,
    residual,
    retainedFindings: findings,
    inspectionGaps: gaps,
    policyVersion: pv,
    currentPolicyVersion: current,
    stale,
    frozen,
    verificationId,
    verifiedAt: v.verifiedAt ?? f.verified_at ?? null,
    reportDigest: digest,
    acceptanceDigest: digest && (findings.length || gaps.length) ? `${ACCEPTANCE_PREFIX}${digest}` : null,
  };
}

/**
 * The requireSanitized gate (shared by portal_upload and browser_upload with an
 * artifact). Throws before any session work; returns the status to report.
 */
export function assertSanitizedForUpload(ctx: Ctx, f: FileRow, o: { requireSanitized?: boolean; acceptRetainedFindings?: unknown }): SanitizationStatus {
  if (o.acceptRetainedFindings === true || o.acceptRetainedFindings === false) {
    throw new RbaError(
      'invalid_input',
      'acceptRetainedFindings is no longer a boolean: pass the acceptanceDigest string ("acc1:...") reported by media_sanitize / media_verify (or by the refusal) for THIS artifact, after the user has seen and accepted its retained findings and inspection gaps.',
    );
  }
  if (o.acceptRetainedFindings !== undefined && (typeof o.acceptRetainedFindings !== 'string' || !ACCEPTANCE_RE.test(o.acceptRetainedFindings))) {
    throw new RbaError('invalid_input', 'acceptRetainedFindings must be an acceptance digest of the form acc1:<64 hex>');
  }
  const sanitization = sanitizationStatus(ctx, f);
  if (!o.requireSanitized) return sanitization;
  if (f.origin !== 'sanitized') throw new RbaError('forbidden', 'requireSanitized: this artifact is an original, not a sanitized output; the original is never uploaded in its place. Run media_sanitize and use its output artifact.', { sanitization });
  if (f.verdict !== 'verified_for_policy') throw new RbaError('forbidden', `requireSanitized: the sanitized output's verification is "${f.verdict}", not verified_for_policy; refusing to upload it.`, { sanitization });
  if (sanitization.stale && !sanitization.frozen) {
    throw new RbaError('forbidden', `requireSanitized: ${sanitization.inspectionGaps[sanitization.inspectionGaps.length - 1]}. A stale verification cannot be accepted; re-verify first.`, { needsDecision: 'reverify', sanitization });
  }
  if (sanitization.acceptanceDigest) {
    const given = o.acceptRetainedFindings as string | undefined;
    const what = `${sanitization.retainedFindings.length} privacy-relevant item(s) kept by design and ${sanitization.inspectionGaps.length} uninspected structure(s): ${[...sanitization.retainedFindings.map((x) => x.name), ...sanitization.inspectionGaps].join('; ')}`;
    if (!given) {
      throw new RbaError('forbidden', `requireSanitized: policy ${f.policy} removed its targeted fields, but the file still contains ${what}. Show these to the user; upload only if they explicitly accept them, by passing acceptRetainedFindings: "${sanitization.acceptanceDigest}". Nothing is deleted automatically.`, {
        needsDecision: 'acceptRetainedFindings',
        acceptanceDigest: sanitization.acceptanceDigest,
        sanitization,
      });
    }
    if (given !== sanitization.acceptanceDigest) {
      throw new RbaError('forbidden', `requireSanitized: the acceptance digest does not match this artifact's current verification (a different artifact, a newer sanitize or verify run, or a policy change). Show the current findings to the user again: ${what}.`, {
        needsDecision: 'acceptRetainedFindings',
        acceptanceDigest: sanitization.acceptanceDigest,
        sanitization,
      });
    }
  }
  return sanitization;
}

/** Durable record of an accepted digest (audit trail; also listed in the run report). */
export function recordAcceptance(ctx: Ctx, f: FileRow, s: SanitizationStatus, jobId: string | null): void {
  if (!s.acceptanceDigest || !s.reportDigest) return;
  ctx.db.run(
    `INSERT INTO file_acceptances (id, artifact_id, artifact_sha256, report_digest, policy, policy_version, findings, gaps, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('acc'),
    f.id,
    f.sha256,
    s.reportDigest,
    f.policy ?? '',
    s.policyVersion ?? 0,
    s.retainedFindings.length,
    s.inspectionGaps.length,
    jobId,
    nowIso(),
  );
}
