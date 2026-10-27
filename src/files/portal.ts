/**
 * portal_upload: upload one file artifact to a web portal through the existing
 * remote session machinery (lease, account restore, network policy, worker
 * transfer with sha256 check).
 *
 * Authorisation boundaries:
 *  - the user's request authorises THIS upload only; it does not authorise
 *    submitting applications, publishing, paying or accepting agreements;
 *  - without explicit fileInputSelector + submitSelector the job only inspects
 *    the page and returns `needs_input` (no file is selected);
 *  - selecting a file can already transmit it (some pages upload on change), so
 *    `selected_in_browser` is reported as possibly sent;
 *  - after the submit click, a timeout is `outcome_unknown`: the page is inspected
 *    for the confirmation, nothing is retried, and a repeat of the same file to
 *    the same target is refused unless allowRepeat is set.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ClickResponse, ExtractResponse, InspectResponse, NavigateResponse, ProxyMode, UploadResponse } from '../../actor/src/protocol.js';
import type { Ctx } from '../core/context.js';
import { RbaError } from '../core/errors.js';
import type { ExecutionMode, ProxyKind } from '../core/modes.js';
import { JobBlocked, OutcomeUnknown, TERMINAL_SQL } from '../core/jobs.js';
import { safeUrl } from '../core/redact.js';
import { isConditionNotMet, readinessBody } from '../core/readiness.js';

/** How long the target page may take to show the named file input. */
const PORTAL_READY_MS = 20_000;
/** How long to wait for the confirmation selector/text after submitting. */
const PORTAL_CONFIRM_WAIT_MS = 15_000;
import { assertSanitizedForUpload, recordAcceptance, type SanitizationStatus } from './acceptance.js';
import { sanitizeDisplayName, type FileRow } from './registry.js';

export interface PortalUploadParams {
  artifactId: string;
  targetUrl: string;
  mode?: ExecutionMode;
  proxy?: { kind: ProxyKind; country?: string };
  /** Legacy form of mode/proxy. */
  proxyMode?: ProxyMode;
  accountId?: string;
  country?: string;
  fileInputSelector?: string;
  submitSelector?: string;
  confirmation?: { selector?: string; textContains?: string; sizeSelector?: string; sha256Selector?: string; filenameSelector?: string };
  requireSanitized?: boolean;
  /**
   * With requireSanitized: the acceptanceDigest ("acc1:...") of this artifact's current
   * verification, after the user has seen and accepted its retained findings / gaps.
   */
  acceptRetainedFindings?: string;
  /** File name sent to the portal. Default under requireSanitized: upload.<ext> (the original name is personal data). */
  uploadFileName?: string;
  dialog?: { action: 'accept' | 'dismiss'; types?: Array<'alert' | 'confirm' | 'prompt' | 'beforeunload'>; maxDialogs?: number };
  allowRepeat?: boolean;
  submitTimeoutSecs?: number;
}

export type Outcome = 'needs_input' | 'portal_confirmed' | 'sent_unconfirmed' | 'outcome_unknown' | 'not_sent' | 'blocked';

export interface Stages {
  transferredToWorker: boolean;
  selectedInBrowser: boolean;
  sentToDestination: boolean | 'unknown';
  portalConfirmed: boolean;
}

export function dedupeKey(sha256: string, targetUrl: string): string {
  const u = new URL(targetUrl);
  return createHash('sha256').update(`${sha256}|${u.origin}${u.pathname}`).digest('hex').slice(0, 32);
}

export { sanitizationStatus, type SanitizationStatus } from './acceptance.js';

export function preflight(ctx: Ctx, p: PortalUploadParams, ownJobId?: string): { origins: string[]; key: string; sanitization: SanitizationStatus } {
  const f = ctx.files.row(p.artifactId);
  const sanitization = assertSanitizedForUpload(ctx, f, p);
  if (f.size > ctx.cfg.limits.maxUploadBytes) throw new RbaError('invalid_input', `file is ${f.size} bytes; uploads are limited to ${ctx.cfg.limits.maxUploadBytes} (RBA_MAX_UPLOAD_MB)`);
  let target: URL;
  try {
    target = new URL(p.targetUrl);
  } catch {
    throw new RbaError('invalid_input', 'targetUrl is not a URL');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new RbaError('invalid_input', 'targetUrl must be http(s)');
  const acct = p.accountId ? ctx.accounts.row(p.accountId) : null;
  const origins = ctx.sessions.originsFor(acct);
  if (!origins.includes('*') && !origins.includes(target.origin)) {
    throw new RbaError('unauthorized_target', acct ? `${target.origin} is not this account's target or one of its auth origins` : `${target.origin} is not in RBA_ALLOWED_ORIGINS`);
  }
  const key = dedupeKey(f.sha256, p.targetUrl);
  if (!p.allowRepeat) {
    const prior = ctx.db.get<{ id: string; status: string; params_json: string }>(
      `SELECT id, status, params_json FROM jobs WHERE kind = 'portal_upload' AND json_extract(params_json, '$.dedupeKey') = ? AND id != ? AND (submitted_at IS NOT NULL OR status NOT IN ${TERMINAL_SQL}) ORDER BY created_at DESC LIMIT 1`,
      key,
      ownJobId ?? '',
    );
    if (prior) {
      let priorArtifactId: string | null = null;
      try {
        priorArtifactId = (JSON.parse(prior.params_json) as { artifactId?: string }).artifactId ?? null;
      } catch {
        /* keep null */
      }
      throw new RbaError(
        'conflict',
        `the same file bytes were already sent (or may have been sent) to this target by job ${prior.id} (${prior.status}, artifact ${priorArtifactId}${priorArtifactId && priorArtifactId !== p.artifactId ? ': a different artifact with identical content' : ''}). Check the portal before uploading again; pass allowRepeat: true only if a second copy is intended.`,
        { priorJobId: prior.id, priorArtifactId },
      );
    }
  }
  return { origins, key, sanitization };
}

export async function runPortalUpload(ctx: Ctx, jobId: string, p: PortalUploadParams, signal: AbortSignal): Promise<{ outcome: Outcome; stages: Stages; [k: string]: unknown }> {
  const stages: Stages = { transferredToWorker: false, selectedInBrowser: false, sentToDestination: false, portalConfirmed: false };
  // Lock FIRST, then re-check: a concurrent media_verify (which also locks) cannot
  // change the verdict or the acceptance digest between the check and the upload.
  ctx.files.lock(p.artifactId, jobId, 30 * 60_000);
  let sid: string | null = null;
  const f = ctx.files.row(p.artifactId);
  try {
    const { origins, sanitization } = preflight(ctx, p, jobId);
    const fileName = uploadFileName(f, p);
    // Stored copy must still match its recorded hash.
    if (ctx.files.rehash(f) !== f.sha256) throw new RbaError('conflict', 'the stored file changed since import; refusing to upload');
    const session = await ctx.sessions.start({ accountId: p.accountId, mode: p.mode, proxy: p.proxy, proxyMode: p.proxyMode, country: p.country, purpose: 'interactive', signal });
    sid = session.sessionId;
    ctx.db.run('UPDATE jobs SET session_id = ? WHERE id = ?', sid, jobId);
    ctx.jobs.event(jobId, 'running', `session ${sid} (${session.executionMode}${session.route.proxy ? ` via ${session.route.proxy.kind}` : ''}${session.egress?.status ? `, egress ${session.egress.status}` : ''})`);
    // Readiness: the document must arrive; when a file input is named it must be in the
    // page (nothing is selected otherwise); load is a bounded best-effort settle so
    // upload widgets that bind on load get the chance to, without failing on slow images.
    const navBody = await readinessBody(
      ctx,
      sid,
      { url: p.targetUrl, waitUntil: 'load' as const, ...(p.fileInputSelector ? { readyWhen: { selector: p.fileInputSelector, timeoutMs: PORTAL_READY_MS } } : {}) },
      false,
    );
    let nav: NavigateResponse;
    try {
      nav = await ctx.sessions.call<NavigateResponse>(sid, '/navigate', navBody, { signal });
    } catch (e) {
      if (isConditionNotMet(e)) {
        ctx.jobs.setStep(jobId, 'session_ready', { error: 'file input not found', readiness: (e as RbaError).details?.readiness ?? null }, 'failed');
        throw new RbaError('invalid_input', `the file input ${JSON.stringify(p.fileInputSelector)} did not appear on the target page within ${PORTAL_READY_MS / 1000} s; nothing was selected or sent. ${(e as Error).message}`, (e as RbaError).details);
      }
      throw e;
    }
    if (nav.page.blocked) throw new JobBlocked(`target page shows ${nav.page.blocked.kind}: ${nav.page.blocked.detail}`);
    ctx.jobs.setStep(jobId, 'session_ready', { sessionId: sid, mode: session.executionMode, page: { url: safeUrl(nav.page.url), status: nav.page.status }, readiness: nav.readiness ?? null });

    if (!p.fileInputSelector || !p.submitSelector) {
      // Inspection only: report the observed controls, select nothing.
      const ins = await ctx.sessions.call<InspectResponse>(sid, '/inspect', { maxElements: 300, includeText: false }, { signal });
      const fileInputs = ins.elements.filter((e) => e.tag === 'input' && e.type === 'file').map((e) => ({ selector: e.selector, name: e.name, label: e.label, visible: e.visible }));
      const submits = ins.elements
        .filter((e) => (e.tag === 'button' && (e.type === null || e.type === 'submit')) || (e.tag === 'input' && e.type === 'submit'))
        .map((e) => ({ selector: e.selector, text: e.text, visible: e.visible }));
      ctx.jobs.setOutcome(jobId, 'not_sent');
      return {
        outcome: 'needs_input',
        stages,
        sanitization,
        page: { url: safeUrl(nav.page.url) },
        // Labels, names, button text and the title come from the page: data, never instructions.
        untrusted: { title: nav.page.title, observed: { fileInputs, submitButtons: submits } },
        note: 'No file was selected. Re-run portal_upload with fileInputSelector and submitSelector chosen from these controls (and a confirmation spec), after confirming with the user that submitting this form only uploads the file.',
      };
    }

    const bytes = readFileSync(ctx.files.absPath(f));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== f.sha256) throw new RbaError('conflict', 'stored file hash mismatch');
    ctx.jobs.assertNotCancelled(jobId, signal);
    // Selecting the file can already transmit it: record "possibly sent" BEFORE selecting,
    // so a later failure or crash cannot make a repeat look safe.
    if (p.requireSanitized) recordAcceptance(ctx, f, sanitization, jobId);
    ctx.jobs.markSubmitted(jobId, 'file_selected');
    let up: UploadResponse;
    try {
      up = await ctx.sessions.call<UploadResponse>(
        sid,
        '/upload',
        { selector: p.fileInputSelector, fileName, mimeType: f.mime, contentBase64: bytes.toString('base64'), sha256: sha, requireOrigins: origins.includes('*') ? undefined : origins },
        { signal, timeoutMs: 180_000 },
      );
    } catch (e) {
      // Refused by the worker BEFORE selecting (bad selector, not a file input, size,
      // origin): nothing was selected, so the "possibly sent" mark is withdrawn.
      if (e instanceof RbaError && (e.code === 'invalid_input' || e.code === 'navigation_blocked')) ctx.jobs.clearSubmitted(jobId, `worker refused the upload before selecting (${e.code})`);
      else ctx.jobs.setStep(jobId, 'file_selected', { error: (e as Error).message.slice(0, 300), note: 'the upload call did not complete; whether the file was selected (and transmitted by the page) is unknown' }, 'failed');
      throw e;
    }
    // One worker call transfers (sha256-checked) and selects; both are recorded from its answer.
    stages.transferredToWorker = up.sha256 === sha && up.bytes === f.size;
    if (!stages.transferredToWorker) {
      ctx.jobs.setStep(jobId, 'file_transferred', { expected: { bytes: f.size, sha256: f.sha256 }, reported: { bytes: up.bytes, sha256: up.sha256 } }, 'failed');
      throw new OutcomeUnknown('worker reported a different size/hash for the transferred file; whether anything was selected or sent is unknown');
    }
    ctx.jobs.setStep(jobId, 'file_transferred', { bytes: up.bytes, sha256: up.sha256, verifiedBy: 'worker sha256 check' });
    stages.selectedInBrowser = true;
    ctx.jobs.setStep(jobId, 'file_selected', { selector: p.fileInputSelector, page: safeUrl(up.page.url), note: 'the page may already have transmitted the file' });
    ctx.jobs.event(jobId, 'running', `transferred to worker (${up.bytes} bytes, sha256 verified) and selected in the file input; the page may already have transmitted it`);

    ctx.jobs.assertNotCancelled(jobId, signal);
    const submitMs = Math.min(p.submitTimeoutSecs ?? 60, 120) * 1000;
    let clickErr: unknown = null;
    let cancelled: unknown = null;
    ctx.jobs.setStep(jobId, 'form_submitted', { selector: p.submitSelector }, 'started');
    try {
      const c = await ctx.sessions.call<ClickResponse>(sid, '/click', { selector: p.submitSelector, waitForNavigation: true, timeoutMs: submitMs, ...(p.dialog ? { dialog: p.dialog } : {}) }, { signal });
      if (c.page.blocked) {
        ctx.jobs.setStep(jobId, 'form_submitted', { blocked: c.page.blocked.kind, page: safeUrl(c.page.url) }, 'failed');
        throw new JobBlocked(`after submit the page shows ${c.page.blocked.kind}`);
      }
      // The click completed and the page navigated: that is NOT a confirmation.
      stages.sentToDestination = true;
      ctx.jobs.setStep(jobId, 'form_submitted', { clickCompleted: true, page: safeUrl(c.page.url), httpStatus: c.page.status });
    } catch (e) {
      if (e instanceof JobBlocked) throw e;
      if (e instanceof RbaError && e.code === 'cancelled') cancelled = e;
      else if ((e as Error)?.name === 'AbortError') cancelled = e;
      clickErr = e;
      stages.sentToDestination = 'unknown';
      ctx.jobs.setStep(jobId, 'form_submitted', { clickCompleted: 'unknown', error: (e as Error).message.slice(0, 300) }, 'failed');
    }

    // Read what the portal actually shows (also after a timeout, before any retry decision).
    const conf = p.confirmation ?? {};
    const fields: Record<string, { selector: string }> = {};
    if (conf.selector) fields.confirmation = { selector: conf.selector };
    if (conf.sizeSelector) fields.size = { selector: conf.sizeSelector };
    if (conf.sha256Selector) fields.sha256 = { selector: conf.sha256Selector };
    if (conf.filenameSelector) fields.filename = { selector: conf.filenameSelector };
    let shown: Record<string, unknown> = {};
    let pageText = '';
    let pageInfo: { url: string; title: string; status: number | null } | null = null;
    let readError: string | null = null;
    // The confirmation may render after the navigation (or after an XHR): wait for it,
    // bounded. Not appearing is not an error here: it is evidence (confirmation_missing).
    let confirmWait: 'met' | 'not_met' | 'none' = (conf.selector || conf.textContains) && !clickErr ? 'met' : 'none';
    const waitFor = async <T>(route: '/extract' | '/inspect', body: Record<string, unknown>, cond: Record<string, unknown> | undefined): Promise<T> => {
      // No extra wait after a failed/timed-out submit: that path keeps its immediate
      // read and stays outcome_unknown unless the confirmation is already shown.
      if (cond && !clickErr) {
        const withCond = await readinessBody(ctx, sid!, { ...body, readyWhen: { ...cond, timeoutMs: PORTAL_CONFIRM_WAIT_MS } }, false);
        try {
          return await ctx.sessions.call<T & { page?: never }>(sid!, route, withCond, { signal });
        } catch (e) {
          if (!isConditionNotMet(e)) throw e;
          confirmWait = 'not_met';
        }
      }
      return ctx.sessions.call<T & { page?: never }>(sid!, route, body, { signal });
    };
    if (!cancelled) {
      try {
        if (Object.keys(fields).length) {
          const ex = await waitFor<ExtractResponse>('/extract', { spec: { fields } }, conf.selector ? { selector: conf.selector } : undefined);
          shown = (ex.items[0] ?? {}) as Record<string, unknown>;
          pageInfo = { url: safeUrl(ex.page.url), title: ex.page.title, status: ex.page.status };
        }
        if (conf.textContains || !pageInfo) {
          const ins = await waitFor<InspectResponse>('/inspect', { maxElements: 1, includeText: true, maxTextChars: 20_000 }, conf.textContains ? { textContains: conf.textContains } : undefined);
          pageText = ins.text ?? '';
          pageInfo = { url: safeUrl(ins.page.url), title: ins.page.title, status: ins.page.status };
        }
      } catch (e) {
        readError = (e as Error).message.slice(0, 300);
        if ((e instanceof RbaError && e.code === 'cancelled') || (e as Error)?.name === 'AbortError') cancelled = e;
      }
    }
    // A filename display alone is never a confirmation (hasSpec ignores filenameSelector).
    const textOk = conf.textContains ? pageText.toLowerCase().includes(conf.textContains.toLowerCase()) : true;
    const selectorOk = conf.selector ? !!shown.confirmation : true;
    const hasSpec = !!(conf.textContains || conf.selector || conf.sizeSelector || conf.sha256Selector);
    const sizeMatch = conf.sizeSelector ? String(shown.size ?? '').trim() === String(f.size) : null;
    const shaMatch = conf.sha256Selector ? String(shown.sha256 ?? '').trim().toLowerCase() === f.sha256 : null;
    stages.portalConfirmed = !readError && !cancelled && hasSpec && textOk && selectorOk && sizeMatch !== false && shaMatch !== false;
    if (stages.portalConfirmed && stages.sentToDestination === 'unknown') stages.sentToDestination = true;
    const evidence = {
      page: pageInfo,
      spec: { selector: !!conf.selector, textContains: !!conf.textContains, sizeSelector: !!conf.sizeSelector, sha256Selector: !!conf.sha256Selector },
      matched: { text: conf.textContains ? textOk : null, selector: conf.selector ? selectorOk : null, size: sizeMatch, sha256: shaMatch },
      untrustedShown: shown,
      readError,
      confirmationWait: { condition: confirmWait, timeoutMs: confirmWait === 'none' ? 0 : PORTAL_CONFIRM_WAIT_MS },
      submitError: clickErr ? (clickErr as Error).message.slice(0, 300) : null,
    };
    ctx.jobs.setStep(jobId, stages.portalConfirmed ? 'confirmation_observed' : 'confirmation_missing', evidence, stages.portalConfirmed ? 'done' : 'failed');
    if (cancelled) throw cancelled; // job ends cancelled; the evidence above is kept and the outcome stays unknown
    const outcome: Outcome = stages.portalConfirmed ? 'portal_confirmed' : stages.sentToDestination === true ? 'sent_unconfirmed' : 'outcome_unknown';
    ctx.jobs.setOutcome(jobId, outcome === 'portal_confirmed' ? 'confirmed' : outcome === 'sent_unconfirmed' ? 'submitted_unconfirmed' : 'outcome_unknown');
    return {
      outcome,
      stages,
      sanitization,
      artifact: { artifactId: f.id, size: f.size, sha256: f.sha256, origin: f.origin, verification: f.verdict, uploadedFileName: fileName },
      destination: {
        page: pageInfo,
        untrusted: { shown },
        sizeMatches: sizeMatch,
        sha256Matches: shaMatch,
      },
      ...(clickErr ? { submitError: (clickErr as Error).message.slice(0, 300) } : {}),
      ...(readError ? { confirmationReadError: readError } : {}),
      note:
        outcome === 'portal_confirmed'
          ? 'The portal displayed the expected confirmation.'
          : outcome === 'sent_unconfirmed'
            ? `The submit click completed but ${hasSpec ? 'the confirmation spec did not match' : 'no confirmation spec was given'}; a click or page load is not a confirmation. Check the portal. Do not re-upload without checking.`
            : 'Outcome unknown (the submit did not complete in time). The file may have been received; check the portal before any retry. A repeat is refused unless allowRepeat is set.',
    };
  } finally {
    if (sid) await ctx.sessions.close(sid).catch(() => undefined); // worker run ends; its in-memory copy goes with it
    ctx.files.unlock(p.artifactId, jobId);
  }
}

/** Job lifecycle status for a portal outcome: only an observed confirmation is `completed`. */
export function portalJobStatus(outcome: Outcome): 'completed' | 'completed_unconfirmed' | 'outcome_unknown' {
  if (outcome === 'portal_confirmed' || outcome === 'needs_input') return 'completed';
  if (outcome === 'sent_unconfirmed') return 'completed_unconfirmed';
  return 'outcome_unknown';
}

/** Name sent to the destination: explicit, else neutral under requireSanitized (the original name is personal data). */
export function uploadFileName(f: FileRow, o: { uploadFileName?: string; requireSanitized?: boolean }): string {
  if (o.uploadFileName) return sanitizeDisplayName(o.uploadFileName);
  if (o.requireSanitized) return `upload.${f.rel_path.split('.').pop() ?? 'bin'}`;
  return f.display_name;
}
