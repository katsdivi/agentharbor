/**
 * media_inspect / media_sanitize / media_verify on registry artifacts.
 * Sanitizing writes to a private temp file, verifies it, and only then promotes
 * it to a new artifact (verdict verified_for_policy or partial). A failed output
 * is deleted, never promoted. The source artifact is locked while it is read and
 * its stored hash is re-checked after the operation.
 */
import { RbaError } from '../core/errors.js';
import type { Ctx } from '../core/context.js';
import { requireTools, type Runner } from './exec.js';
import { capabilities } from './formats.js';
import { defaultEnv, handlerFor, POLICY_VERSIONS, removeQuietly, summarize, toolVersions, type SanitizeOptions, type VerifyReport } from './media.js';
import type { FileRow, FileView } from './registry.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sanitizationStatus } from './acceptance.js';

const TOOLS_BY_POLICY: Record<string, string[]> = {
  image_metadata: ['ffmpeg', 'exiftool'],
  pdf_document_properties: ['pdfinfo', 'pdftotext', 'pdftoppm', 'pdfsig', 'pdfdetach'],
  av_container_tags: ['ffmpeg', 'ffprobe', 'exiftool'],
};
/** Tools that must exist before a sanitize/verify starts (optional ones excluded). */
const REQUIRED_BY_POLICY: Record<string, string[]> = {
  image_metadata: ['ffmpeg'],
  pdf_document_properties: ['pdfinfo', 'pdftotext', 'pdftoppm', 'pdfsig', 'pdfdetach'],
  av_container_tags: ['ffmpeg', 'ffprobe'],
};

/** Test hook: replace the subprocess runner (e.g. to simulate a hang). */
export const serviceHooks: { run?: Runner } = {};

function env(ctx: Ctx, signal?: AbortSignal) {
  return defaultEnv({ timeoutMs: ctx.cfg.files.toolTimeoutMs, maxImagePixels: ctx.cfg.files.maxImagePixels, tmp: (e) => ctx.files.tmpPath(e), signal, run: serviceHooks.run });
}

export async function inspectFile(ctx: Ctx, id: string, detailed: boolean): Promise<Record<string, unknown>> {
  const r = ctx.files.row(id);
  const cap = capabilities(r.format);
  if (!cap.inspect) return { artifactId: id, format: r.format, verdict: 'unsupported', reason: cap.unsupportedReason };
  const h = await handlerFor(r.format);
  const report = await h.inspect(ctx.files.absPath(r), detailed, env(ctx));
  return { artifactId: id, format: r.format, policyAvailable: cap.policy, ...report, ...(detailed ? { notice: 'Detailed values are shown because detailed inspection was requested; they are personal data.' } : {}) };
}

export interface SanitizeResult {
  verdict: VerifyReport['verdict'];
  summary: string;
  output: FileView | null;
  sanitize: unknown;
  verification: VerifyReport;
  /** Needed (as acceptRetainedFindings) for a requireSanitized upload when findings or gaps exist; null otherwise. */
  acceptanceDigest: string | null;
}

export async function sanitizeFile(ctx: Ctx, holder: string, id: string, opts: SanitizeOptions, signal: AbortSignal): Promise<SanitizeResult> {
  ctx.files.sweepTmpIfDue();
  const src = ctx.files.row(id);
  if (src.origin !== 'imported' && src.origin !== 'sanitized') throw new RbaError('invalid_input', 'unknown artifact origin');
  const cap = capabilities(src.format);
  if (!cap.sanitize) throw new RbaError('invalid_input', `unsupported format "${src.format}": ${cap.unsupportedReason}`, { verdict: 'unsupported' });
  const h = await handlerFor(src.format);
  if (!serviceHooks.run) requireTools(REQUIRED_BY_POLICY[cap.policy!] ?? []);
  // Lock long enough for the slowest legitimate run (many tool calls at the tool timeout).
  ctx.files.lock(id, holder, Math.max(15 * 60_000, ctx.cfg.files.toolTimeoutMs * 60));
  const tmp = ctx.files.tmpPath(src.rel_path.split('.').pop() ?? 'bin');
  try {
    const e = env(ctx, signal);
    const info = await h.sanitize(ctx.files.absPath(src), tmp, opts, e);
    signal.throwIfAborted();
    const v = await finishVerify(ctx, src, tmp, h, e);
    signal.throwIfAborted();
    info.tools = { ...info.tools, ...(await toolVersions(TOOLS_BY_POLICY[info.policy] ?? [])) };
    if (v.verdict === 'failed' || v.verdict === 'unsupported') {
      return { verdict: v.verdict, summary: summarize(v), output: null, sanitize: info, verification: v, acceptanceDigest: null };
    }
    const buf = readFileSync(tmp);
    const view = ctx.files.commit(tmp, buf.subarray(0, 65536), buf.length, v.outputSha256, cleanName(src.display_name), 'sanitized', src.id, info.policy, v.verdict, { sanitize: info, verification: v, sourceSha256: src.sha256 });
    return { verdict: v.verdict, summary: summarize(v), output: view, sanitize: info, verification: v, acceptanceDigest: sanitizationStatus(ctx, view.artifactId).acceptanceDigest };
  } finally {
    removeQuietly(tmp); // no-op after a successful commit (renamed away)
    ctx.files.unlock(id, holder);
  }
}

function cleanName(n: string): string {
  const i = n.lastIndexOf('.');
  return i > 0 ? `${n.slice(0, i)}-clean${n.slice(i)}` : `${n}-clean`;
}

async function finishVerify(ctx: Ctx, src: FileRow, outPath: string, h: Awaited<ReturnType<typeof handlerFor>>, e: ReturnType<typeof env>): Promise<VerifyReport> {
  const partial = await h.verify(ctx.files.absPath(src), outPath, e);
  const unchanged = ctx.files.rehash(src) === src.sha256;
  const out = readFileSync(outPath);
  const { createHash } = await import('node:crypto');
  const outputSha256 = createHash('sha256').update(out).digest('hex');
  const checks = [...partial.checks, { name: 'source_unchanged', ok: unchanged, method: 'sha256', detail: unchanged ? 'source sha256 unchanged' : 'SOURCE CHANGED' }];
  return {
    ...partial,
    checks,
    verdict: unchanged ? partial.verdict : 'failed',
    sourceSha256Unchanged: unchanged,
    outputSha256,
    policyVersion: POLICY_VERSIONS[partial.policy] ?? 0,
    verificationId: `ver_${randomBytes(12).toString('hex')}`,
    verifiedAt: new Date().toISOString(),
  };
}

/** Re-run verification of a sanitized artifact against its source. */
export async function verifyFile(ctx: Ctx, id: string, signal?: AbortSignal): Promise<VerifyReport & { artifactId: string; sourceArtifactId: string; summary: string; acceptanceDigest: string | null }> {
  // Locked while verifying: an upload of this artifact cannot run (or read a half-updated report) meanwhile.
  const holder = `verify_${randomBytes(6).toString('hex')}`;
  ctx.files.lock(id, holder, Math.max(15 * 60_000, ctx.cfg.files.toolTimeoutMs * 60));
  try {
    return await verifyLocked(ctx, id, signal);
  } finally {
    ctx.files.unlock(id, holder);
  }
}

async function verifyLocked(ctx: Ctx, id: string, signal?: AbortSignal): Promise<VerifyReport & { artifactId: string; sourceArtifactId: string; summary: string; acceptanceDigest: string | null }> {
  const out = ctx.files.row(id);
  if (out.origin !== 'sanitized' || !out.source_id) throw new RbaError('invalid_input', 'media_verify checks a sanitized output against its source; this artifact is not a sanitized output');
  let src: FileRow;
  try {
    src = ctx.files.row(out.source_id);
  } catch {
    throw new RbaError('not_found', `the source artifact ${out.source_id} was deleted; only the stored verification report is available (file_inspect)`);
  }
  const h = await handlerFor(out.format);
  const cap = capabilities(out.format);
  if (!serviceHooks.run) requireTools(REQUIRED_BY_POLICY[cap.policy!] ?? []);
  const outStored = ctx.files.rehash(out);
  if (outStored !== out.sha256) throw new RbaError('conflict', 'the stored output changed since it was created; delete it and sanitize again');
  const v = await finishVerify(ctx, src, ctx.files.absPath(out), h, env(ctx, signal));
  const prev = out.report_json ? (JSON.parse(out.report_json) as Record<string, unknown>) : {};
  ctx.files.updateVerification(id, v.verdict, { ...prev, verification: v, sourceSha256: src.sha256 });
  return { ...v, summary: summarize(v), artifactId: id, sourceArtifactId: src.id, acceptanceDigest: sanitizationStatus(ctx, id).acceptanceDigest };
}
