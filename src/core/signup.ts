import type { ClickResponse, InspectResponse, NavigateResponse, ProxyMode } from '../../actor/src/protocol.js';
import { DISPOSABLE_PROVIDER_EXPIRY_MS, assertReadable, boundSites, boundSitesFor, isTombstoned, recordInbox, type EmailMode } from '../email/inboxes.js';
import { waitForVerification, type VerificationResult } from '../email/verification.js';
import type { AccountRow } from './accounts.js';
import { requireMail, type Ctx } from './context.js';
import { generatePassword } from './crypto.js';
import { RbaError } from './errors.js';
import { resolveRoute, type ExecutionMode, type ProxyKind } from './modes.js';
import { JobBlocked, OutcomeUnknown } from './jobs.js';
import { registerSecret, safeUrl } from './redact.js';
import { isConditionNotMet, readinessBody } from './readiness.js';
import { Usage } from './usage.js';

export type FieldValue = string | { secret: 'email' | 'password' | 'display_name' };

/**
 * One form step, run in order: fill a field, choose <select> options, or click
 * (radio, checkbox, or a "next step" button of a multi-page signup). Clicks here
 * happen BEFORE the account-creating submit; `submitSelector` is that final submit.
 */
export type SignupField =
  | { selector: string; value: FieldValue }
  | { selector: string; select: string[] }
  | { selector: string; click: true; waitForNavigation?: boolean };

export interface RegisterParams {
  targetOrigin: string;
  signupUrl: string;
  fields: SignupField[];
  submitSelector: string;
  /** Text expected after a successful submission, e.g. "Check your email". */
  successText?: string;
  /** Texts meaning the site refused the signup (e.g. "domain not allowed"). */
  rejectionTexts?: string[];
  verification?: {
    required?: boolean;
    fromContains?: string;
    subjectContains?: string;
    linkContains?: string;
    timeoutSecs?: number;
    /** For code-based verification: field to type the code into and its submit button. */
    codeSelector?: string;
    codeSubmitSelector?: string;
    /**
     * Text the site shows once verification succeeded (e.g. "Email verified" or the
     * logged-in page). Without it, following the link is reported as
     * completed_unconfirmed: a page load is not a confirmation.
     */
    successText?: string;
  };
  displayName?: string;
  label?: string;
  mode?: ExecutionMode;
  proxy?: { kind: ProxyKind; country?: string };
  proxyMode?: ProxyMode;
  country?: string;
  /** Marks a synthetic identity: only allowed for targets the user authorised for testing. */
  synthetic?: boolean;
  /**
   * Inbox mode for a new account (docs/CLAUDE-ACC-PLUGIN.md §4): kept (default) persists
   * until deleted; disposable is open 1 h (extendable once to 24 h), then closed and
   * emptied, reopenable for 7 days, then retired.
   */
  emailMode?: EmailMode;
  /** Resume a previous attempt (never resubmits if the site may have received it). */
  accountId?: string;
  keepSessionOpen?: boolean;
  /** How long to wait for the submit click's navigation (default 30s). */
  submitTimeoutSecs?: number;
}

const GOOGLE = /(^|\.)(google\.[a-z.]+|gmail\.com|googlemail\.com|youtube\.com|withgoogle\.com)$/i;

export function assertRegistrable(ctx: Ctx, targetOrigin: string, signupUrl: string): { authOrigins: string[] } {
  const host = new URL(targetOrigin).hostname;
  if (GOOGLE.test(host)) {
    throw new RbaError('forbidden', 'automated creation of Google accounts is not supported; add an existing dedicated Google account instead');
  }
  const t = ctx.cfg.targets.find((x) => x.origin === new URL(targetOrigin).origin);
  if (!t) {
    throw new RbaError('unauthorized_target', `${targetOrigin} is not listed in RBA_AUTHORIZED_TARGETS; add it to .env only if you are authorised to create accounts there`);
  }
  const su = new URL(signupUrl).origin;
  if (su !== t.origin && !t.authOrigins.includes(su)) throw new RbaError('invalid_input', 'signupUrl must be on the target or one of its auth origins');
  return { authOrigins: t.authOrigins };
}

/** How long the signup page may take to show its first form field. */
const SIGNUP_FORM_READY_MS = 20_000;
/** How long to wait for the success text after a submit or verification. */
const SIGNUP_CONFIRM_WAIT_MS = 15_000;

/**
 * Inspect the page, first waiting (bounded) for `text` when given. The text not
 * appearing is not an error here: the caller records the confirmation as missing.
 */
async function inspectWaiting(ctx: Ctx, sid: string, body: Record<string, unknown>, text: string | undefined, signal: AbortSignal, stopTexts: string[] = []): Promise<InspectResponse> {
  // Read at once first: no wait when the outcome (success or a rejection) is already shown.
  const now = await ctx.sessions.call<InspectResponse>(sid, '/inspect', body, { signal });
  const shown = pageText(now);
  if (!text || shown.includes(text.toLowerCase()) || stopTexts.some((t) => shown.includes(t.toLowerCase()))) return now;
  const withCond = await readinessBody(ctx, sid, { ...body, readyWhen: { textContains: text.slice(0, 500), timeoutMs: SIGNUP_CONFIRM_WAIT_MS } }, false);
  if (!('readyWhen' in withCond)) return now; // older worker: no wait possible
  try {
    return await ctx.sessions.call<InspectResponse>(sid, '/inspect', withCond, { signal });
  } catch (e) {
    if (!isConditionNotMet(e)) throw e;
  }
  return ctx.sessions.call<InspectResponse>(sid, '/inspect', body, { signal });
}

function pageText(i: InspectResponse): string {
  return (i.text ?? '').toLowerCase();
}

/**
 * Registration job: created -> running -> awaiting_email -> verifying -> completed
 * (or failed / cancelled / blocked). Side-effect rules:
 *  - the signup form is submitted at most once per account; the submission time
 *    is persisted *before* clicking;
 *  - if the outcome of a submission is unknown (timeout, crash), the account is
 *    marked `unknown` and the inbox is checked instead of resubmitting;
 *  - a rejected email domain fails the job; no other domain is tried.
 */
export async function runRegistration(ctx: Ctx, jobId: string, p: RegisterParams, signal: AbortSignal): Promise<void> {
  const mail = requireMail(ctx);
  const { authOrigins } = assertRegistrable(ctx, p.targetOrigin, p.signupUrl);
  const targetOrigin = new URL(p.targetOrigin).origin;
  const allowedLinkOrigins = [targetOrigin, ...authOrigins];

  // ---- account + inbox + credentials -------------------------------------
  let acct: AccountRow;
  if (p.accountId) {
    acct = ctx.accounts.row(p.accountId);
    if (acct.target_origin !== targetOrigin) throw new RbaError('invalid_input', 'accountId belongs to a different target');
    if (acct.status === 'active') throw new RbaError('conflict', 'account is already active');
  } else {
    ctx.usage.assertInboxQuota();
    // Check the browser budget before consuming a (capped) inbox creation.
    // The new account is bound to the resolved route for its whole life.
    const route = resolveRoute({ mode: p.mode, proxy: p.proxy, proxyMode: p.proxyMode, country: p.country }, ctx.cfg);
    if (route.mode === 'local') ctx.usage.assertConcurrency();
    else await ctx.usage.assertCanStart(ctx.cfg.apify.workerMemoryMb, ctx.cfg.limits.maxSessionMinutes, route.workerProxyMode);
    acct = ctx.accounts.create({
      targetOrigin,
      label: p.label ?? null,
      proxyMode: route.workerProxyMode,
      executionMode: route.mode,
      proxyCountry: route.proxy?.country ?? null,
      status: 'pending',
      synthetic: !!p.synthetic,
    });
    const reservation = ctx.usage.reserveInbox();
    const resTag = Usage.reservationTag(reservation);
    let inbox: { id: string; emailAddress: string };
    try {
      inbox = await mail.createInbox({
        name: `rba ${acct.id}`,
        tags: ['rba', acct.id, resTag],
        expiresInMs:
          p.emailMode === 'disposable'
            ? DISPOSABLE_PROVIDER_EXPIRY_MS
            : ctx.cfg.mailslurp.inboxExpiresHours
              ? ctx.cfg.mailslurp.inboxExpiresHours * 3600_000
              : undefined,
        useDomainPool: ctx.cfg.mailslurp.useDomainPool,
      });
    } catch (e) {
      // The provider may have created the inbox even though the call failed (e.g. a
      // timeout). Release the slot only if the provider confirms there is none;
      // otherwise adopt it, or leave the reservation for the recovery sweep.
      const found = await mail.findInboxesByTag(resTag).catch(() => null);
      if (found === null) throw e; // unknown: reservation kept, recovered later
      if (found.length === 0) {
        ctx.usage.settleInbox(reservation, null);
        throw e;
      }
      inbox = found[0]!;
    }
    // Record the inbox and link it to the account together: no window in which a
    // provider inbox exists but neither record points to it.
    // An address is never reused: a retired/deleted one coming back is refused.
    if (isTombstoned(ctx, inbox.emailAddress)) {
      await mail.deleteInbox(inbox.id).catch(() => undefined);
      ctx.usage.settleInbox(reservation, inbox.id);
      throw new RbaError('conflict', 'the provider returned an address that was deleted before; try again');
    }
    const created = inbox;
    ctx.db.tx(() => {
      ctx.usage.settleInbox(reservation, created.id);
      ctx.accounts.update(acct.id, { email: created.emailAddress, inboxId: created.id });
      recordInbox(ctx, { accountId: acct.id, inboxId: created.id, address: created.emailAddress, mode: p.emailMode ?? 'kept', boundSites: boundSitesFor(allowedLinkOrigins) });
    });
    ctx.accounts.setCredentials(acct.id, { password: generatePassword() });
    acct = ctx.accounts.row(acct.id);
  }
  ctx.db.run('UPDATE jobs SET account_id = ? WHERE id = ?', acct.id, jobId);
  ctx.jobs.event(jobId, 'running', `account ${acct.id} with inbox ${acct.email}`);
  const creds = ctx.accounts.getCredentials(acct.id);
  if (!creds || !acct.email || !acct.inbox_id) throw new RbaError('internal', 'account is missing inbox or credentials');
  // A closed disposable inbox must be reopened explicitly; mail from other sites is never used.
  const senderSites = boundSites(assertReadable(ctx, acct));

  const priorSubmit = ctx.db.get<{ submitted_at: string }>(
    `SELECT submitted_at FROM jobs WHERE account_id = ? AND kind = 'register' AND submitted_at IS NOT NULL ORDER BY submitted_at LIMIT 1`,
    acct.id,
  )?.submitted_at;

  const session = await ctx.sessions.start({ accountId: acct.id, mode: p.mode, proxy: p.proxy, proxyMode: p.proxyMode, country: p.country, purpose: 'register', restoreState: false, signal });
  const sid = session.sessionId;
  ctx.db.run('UPDATE jobs SET session_id = ? WHERE id = ?', sid, jobId);
  ctx.jobs.setStep(jobId, 'session_ready', { sessionId: sid, mode: session.executionMode });
  let keepOpen = false;
  try {
    let submittedAt = priorSubmit ?? null;
    let submitConfirmed = false;
    if (priorSubmit) {
      // This job carries the earlier submission: its side effect already happened.
      ctx.db.run('UPDATE jobs SET submitted_at = ? WHERE id = ?', priorSubmit, jobId);
      ctx.jobs.setStep(jobId, 'form_submitted', { submittedAt: priorSubmit, byEarlierJob: true });
      ctx.jobs.event(jobId, 'running', 'a previous attempt already submitted the form; checking the inbox instead of resubmitting');
    } else {
      // ---- fill and submit (bounded retries only before the side effect) ----
      let lastErr: unknown;
      for (let attempt = 0; attempt <= ctx.cfg.limits.maxRetries; attempt++) {
        signal.throwIfAborted();
        try {
          // Ready = the first form control is in the page (forms rendered by script
          // included); slow optional resources do not hold or fail the signup.
          const first = p.fields[0]?.selector;
          const navBody = await readinessBody(ctx, sid, { url: p.signupUrl, waitUntil: 'domcontentloaded' as const, ...(first ? { readyWhen: { selector: first, timeoutMs: SIGNUP_FORM_READY_MS } } : {}) }, false);
          const nav = await ctx.sessions.call<NavigateResponse>(sid, '/navigate', navBody, { signal });
          if (nav.page.blocked) throw new JobBlocked(`signup page shows ${nav.page.blocked.kind}: ${nav.page.blocked.detail}`);
          lastErr = null;
          break;
        } catch (e) {
          // A form field that never appeared on a loaded page will not appear on retry.
          if (e instanceof JobBlocked || isConditionNotMet(e) || (e instanceof RbaError && ['navigation_blocked', 'cancelled', 'lease_lost'].includes(e.code))) throw e;
          lastErr = e;
          ctx.jobs.event(jobId, 'running', `navigation attempt ${attempt + 1} failed: ${(e as Error).message}`);
        }
      }
      if (lastErr) throw lastErr;

      const values = { email: acct.email, password: creds.password, display_name: p.displayName ?? '' };
      for (const f of p.fields) {
        signal.throwIfAborted();
        if ('select' in f) {
          await ctx.sessions.call(sid, '/select', { selector: f.selector, values: f.select }, { signal });
          continue;
        }
        if ('click' in f) {
          // An intermediate step (e.g. "Signup" -> details form). Not the account-creating submit.
          const c = await ctx.sessions.call<ClickResponse>(sid, '/click', { selector: f.selector, waitForNavigation: !!f.waitForNavigation }, { signal });
          if (c.page.blocked) throw new JobBlocked(`signup step shows ${c.page.blocked.kind}: ${c.page.blocked.detail}`);
          if (f.waitForNavigation && p.rejectionTexts?.length) {
            const step = await ctx.sessions.call<InspectResponse>(sid, '/inspect', { includeText: true, maxElements: 1, maxTextChars: 8000 }, { signal });
            const rejected = p.rejectionTexts.find((t) => pageText(step).includes(t.toLowerCase()));
            if (rejected) {
              ctx.accounts.quarantine(acct.id, `signup step rejected by site: "${rejected}"`);
              throw new RbaError('forbidden', `site rejected the signup at an intermediate step ("${rejected}"); nothing was submitted for account creation; not retrying with another email/domain`);
            }
          }
          continue;
        }
        const isSecret = typeof f.value !== 'string';
        const value = typeof f.value === 'string' ? f.value : values[f.value.secret];
        if (typeof f.value !== 'string' && f.value.secret === 'display_name' && !p.displayName) {
          throw new RbaError('invalid_input', 'a field asks for display_name but no displayName was provided');
        }
        await ctx.sessions.call(sid, '/fill', { selector: f.selector, value, ...(isSecret ? { requireOrigins: allowedLinkOrigins } : {}) }, { signal });
      }

      ctx.jobs.assertNotCancelled(jobId, signal);
      ctx.accounts.setStatus(acct.id, 'registering');
      ctx.jobs.markSubmitted(jobId, 'form_submitted');
      submittedAt = ctx.jobs.row(jobId).submitted_at;
      let submitFailed = false;
      try {
        const submitMs = Math.min(p.submitTimeoutSecs ?? 30, 120) * 1000;
        const clicked = await ctx.sessions.call<ClickResponse>(sid, '/click', { selector: p.submitSelector, waitForNavigation: true, timeoutMs: submitMs }, { signal, timeoutMs: submitMs + 15_000 });
        ctx.jobs.setStep(jobId, 'form_submitted', { clickCompleted: true, page: safeUrl(clicked.page.url), httpStatus: clicked.page.status, blocked: clicked.page.blocked?.kind ?? null });
        if (clicked.page.blocked) {
          ctx.accounts.setStatus(acct.id, 'blocked', `${clicked.page.blocked.kind} after signup submit`);
          throw new JobBlocked(`site requires human verification or blocked access after submit (${clicked.page.blocked.kind}); stopped`);
        }
      } catch (e) {
        if (e instanceof JobBlocked) throw e;
        submitFailed = true;
        ctx.jobs.setStep(jobId, 'form_submitted', { clickCompleted: 'unknown', error: (e as Error).message.slice(0, 300) }, 'failed');
        if (e instanceof RbaError && (e.code === 'timeout' || e.code === 'worker_error')) {
          ctx.accounts.setStatus(acct.id, 'unknown', 'signup submission outcome unknown (timeout); not resubmitted');
          ctx.jobs.event(jobId, 'running', 'submission timed out; outcome unknown. Will look for a verification email instead of resubmitting.');
        } else {
          // Any other failure after the submission marker: the click may or may not have
          // reached the site. Never leave the account stuck in `registering`.
          ctx.accounts.setStatus(acct.id, 'unknown', `signup submission outcome unknown (${e instanceof RbaError ? e.code : 'error'}); not resubmitted`);
          throw e;
        }
      }

      // After a failed/timed-out submit: immediate read only (no wait for the success text),
      // so that path keeps its outcome-unknown semantics.
      const after = await inspectWaiting(ctx, sid, { includeText: true, maxElements: 20, maxTextChars: 4000 }, submitFailed ? undefined : p.successText, signal, p.rejectionTexts ?? []).catch(() => null);
      if (after) {
        if (after.page.blocked) {
          ctx.accounts.setStatus(acct.id, 'blocked', `${after.page.blocked.kind} after signup submit`);
          throw new JobBlocked(`site requires human verification or blocked access after submit (${after.page.blocked.kind}); stopped`);
        }
        const rejected = (p.rejectionTexts ?? []).find((t) => pageText(after).includes(t.toLowerCase()));
        if (rejected) {
          ctx.accounts.quarantine(acct.id, `signup rejected by site: "${rejected}"`);
          ctx.jobs.setOutcome(jobId, 'rejected');
          ctx.jobs.setStep(jobId, 'confirmation_missing', { rejectedText: rejected, page: safeUrl(after.page.url) }, 'failed');
          throw new RbaError('forbidden', `site rejected the signup ("${rejected}"); not retrying with another email/domain`);
        }
        submitConfirmed = !!p.successText && pageText(after).includes(p.successText.toLowerCase());
        ctx.jobs.setStep(jobId, 'form_submitted', { page: safeUrl(after.page.url), httpStatus: after.page.status, successText: p.successText ? submitConfirmed : null });
        if (p.successText && !submitConfirmed) {
          ctx.jobs.event(jobId, 'running', `success text not found after submit (page ${safeUrl(after.page.url)}); waiting for email anyway`);
        }
      } else {
        ctx.jobs.event(jobId, 'running', 'the page after submit could not be read; continuing with the inbox check');
      }
    }

    const v = p.verification ?? {};
    if (v.required === false) {
      await ctx.sessions.saveState(sid);
      ctx.jobs.setResult(jobId, { accountId: acct.id, email: acct.email, verifiedVia: 'none', confirmed: submitConfirmed, sessionId: p.keepSessionOpen ? sid : null });
      if (submitConfirmed) {
        ctx.accounts.setStatus(acct.id, 'active', 'verification not required by caller; success text observed after submit');
        ctx.jobs.setStep(jobId, 'confirmation_observed', { successText: true });
        ctx.jobs.transition(jobId, 'completed', 'submitted; success text observed; verification not required; browser state saved', { outcome: 'confirmed' });
      } else {
        ctx.accounts.setStatus(acct.id, 'unknown', 'submitted; no success text observed (pass successText to confirm); not resubmitted');
        ctx.jobs.setStep(jobId, 'confirmation_missing', { successText: p.successText ? false : 'not specified' }, 'failed');
        ctx.jobs.transition(jobId, 'completed_unconfirmed', 'submitted, but no confirmation was observed (a click or page load is not one); browser state saved', { outcome: 'submitted_unconfirmed' });
      }
    } else {
      ctx.accounts.setStatus(acct.id, 'awaiting_verification');
      ctx.jobs.setStep(jobId, 'verification_pending', { inbox: acct.email, since: submittedAt });
      ctx.jobs.transition(jobId, 'awaiting_email', `waiting for verification email to ${acct.email}`);
      const timeoutMs = Math.min(v.timeoutSecs ?? ctx.cfg.limits.emailWaitMaxSecs, ctx.cfg.limits.emailWaitMaxSecs) * 1000;
      const evaluated: Array<{ emailId: string; reason: string }> = [];
      let found: VerificationResult;
      try {
        found = await waitForVerification(
          mail,
          {
            inboxId: acct.inbox_id,
            inboxAddress: acct.email,
            sinceIso: submittedAt ?? new Date().toISOString(),
            targetOrigin,
            allowedLinkOrigins,
            fromContains: v.fromContains,
            subjectContains: v.subjectContains,
            linkContains: v.linkContains,
            allowedSenderSites: senderSites,
            timeoutMs,
            pollMs: ctx.cfg.limits.emailWaitMaxSecs < 30 ? 500 : 5000,
            signal,
            seen: consumedEmailIds(ctx, acct.id),
            onEvaluated: (e) => {
              evaluated.push({ emailId: e.emailId, reason: e.reason });
              ctx.jobs.setProgress(jobId, { emailsEvaluated: evaluated });
            },
          },
          {
            onEmailReceived: (id) => ctx.usage.admitEmail(id),
          },
        );
      } catch (e) {
        if (e instanceof RbaError && e.code === 'timeout') {
          const st = ctx.accounts.row(acct.id).status;
          if (st !== 'unknown') ctx.accounts.setStatus(acct.id, 'awaiting_verification', 'verification email not received in time');
          ctx.jobs.setStep(jobId, 'verification_pending', { timedOutAfterSecs: Math.round(timeoutMs / 1000), emailsEvaluated: evaluated.length }, 'failed');
          throw new OutcomeUnknown(`${e.message}. The form was submitted at ${submittedAt}; do not resubmit. Re-run account_register with accountId=${acct.id} to keep waiting.`);
        }
        throw e;
      }

      ctx.jobs.transition(jobId, 'verifying', `verification email ${found.emailId} accepted`);
      if (found.link) {
        const nav = await ctx.sessions.call<NavigateResponse>(sid, '/navigate', { url: found.link, waitUntil: 'load' }, { signal });
        if (nav.page.blocked) throw new JobBlocked(`verification page shows ${nav.page.blocked.kind}`);
        ctx.jobs.setStep(jobId, 'verification_followed', { via: 'link', emailId: found.emailId, link: safeUrl(found.link), page: safeUrl(nav.page.url), httpStatus: nav.page.status });
        ctx.jobs.event(jobId, 'verifying', `followed verification link on ${safeUrl(found.link)} -> ${safeUrl(nav.page.url)}`);
        if (nav.page.status !== null && nav.page.status >= 400) {
          throw new OutcomeUnknown(`the verification link answered HTTP ${nav.page.status} (${safeUrl(nav.page.url)}); the account is not confirmed. Do not resubmit the signup; check the inbox (email_search) or the site.`);
        }
      } else if (found.code) {
        registerSecret(found.code, 4);
        if (!v.codeSelector || !v.codeSubmitSelector) {
          ctx.codes.set(jobId, found.code);
          throw new RbaError('invalid_input', `verification uses a code; re-run with verification.codeSelector/codeSubmitSelector, or fill it with browser_fill secret "verification_code" and jobId ${jobId}`);
        }
        await ctx.sessions.call(sid, '/fill', { selector: v.codeSelector, value: found.code, requireOrigins: allowedLinkOrigins }, { signal });
        const c = await ctx.sessions.call<ClickResponse>(sid, '/click', { selector: v.codeSubmitSelector, waitForNavigation: true }, { signal });
        ctx.jobs.setStep(jobId, 'verification_followed', { via: 'code', emailId: found.emailId, page: safeUrl(c.page.url), httpStatus: c.page.status });
        if (c.page.blocked) throw new JobBlocked(`verification page shows ${c.page.blocked.kind}`);
      }
      // Postcondition: the site must SHOW the verified state (verification.successText).
      let confirmed = false;
      let shownUrl: string | null = null;
      if (v.successText) {
        const after = await inspectWaiting(ctx, sid, { includeText: true, maxElements: 1, maxTextChars: 8000 }, v.successText, signal).catch(() => null);
        confirmed = !!after && pageText(after).includes(v.successText.toLowerCase());
        shownUrl = after ? safeUrl(after.page.url) : null;
      }
      await ctx.sessions.saveState(sid);
      ctx.jobs.setResult(jobId, { accountId: acct.id, email: acct.email, verifiedVia: found.link ? 'link' : 'code', emailId: found.emailId, confirmed, sessionId: p.keepSessionOpen ? sid : null });
      if (confirmed) {
        ctx.accounts.setStatus(acct.id, 'active', null, { verified: true });
        ctx.jobs.setStep(jobId, 'confirmation_observed', { successText: true, page: shownUrl });
        ctx.jobs.transition(jobId, 'completed', 'account verified (confirmation text observed) and browser state saved', { outcome: 'confirmed' });
      } else {
        ctx.accounts.setStatus(acct.id, 'awaiting_verification', v.successText ? 'verification followed but the success text was not shown' : 'verification followed; no verification.successText given, so the result was not confirmed');
        ctx.jobs.setStep(jobId, 'confirmation_missing', { successText: v.successText ? false : 'not specified', page: shownUrl }, 'failed');
        ctx.jobs.transition(jobId, 'completed_unconfirmed', `verification ${found.link ? 'link followed' : 'code submitted'}, but no confirmation was observed (a page load is not one); browser state saved`, { outcome: 'submitted_unconfirmed' });
      }
    }
    keepOpen = !!p.keepSessionOpen;
  } finally {
    if (!keepOpen) await ctx.sessions.close(sid).catch(() => undefined);
  }
}

/** Email ids already accepted by earlier jobs of this account: never reused for a new job. */
export function consumedEmailIds(ctx: Ctx, accountId: string): Set<string> {
  const rows = ctx.db.all<{ result_json: string | null }>(`SELECT result_json FROM jobs WHERE account_id = ? AND result_json IS NOT NULL`, accountId);
  const ids = new Set<string>();
  for (const r of rows) {
    const id = (JSON.parse(r.result_json!) as { emailId?: string }).emailId;
    if (id) ids.add(id);
  }
  return ids;
}
