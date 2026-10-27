import { isIP } from 'node:net';
import { RbaError } from '../core/errors.js';
import type { Email, MailSlurpClient } from './mailslurp.js';

export interface VerificationQuery {
  inboxId: string;
  inboxAddress: string;
  /** Only emails received at or after this instant (minus clock skew) count. */
  sinceIso: string;
  targetOrigin: string;
  /** Origins a verification link may point to (target + configured auth origins). */
  allowedLinkOrigins: string[];
  fromContains?: string;
  subjectContains?: string;
  /** Substring the chosen link must contain, e.g. "/verify". */
  linkContains?: string;
  /** Sender sites the inbox is bound to (email modes): mail from any other sender is ignored. */
  allowedSenderSites?: string[];
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Email ids already evaluated (persisted by the caller across restarts). */
  seen?: Set<string>;
  onEvaluated?: (e: EvaluatedEmail) => void;
}

export interface EvaluatedEmail {
  emailId: string;
  accepted: boolean;
  reason: string;
}

export interface VerificationResult {
  emailId: string;
  receivedAt: string;
  subject: string | null;
  from: string | null;
  /** Validated link (its query string may hold a one-time token; never log it). */
  link: string | null;
  /** Numeric one-time code found in the email, when no link qualified. */
  code: string | null;
  skipped: EvaluatedEmail[];
}

/** Tolerated difference between the local clock and MailSlurp's createdAt. */
const CLOCK_SKEW_MS = 30 * 1000;
const MAX_CONSECUTIVE_ERRORS = 3;

/** Registrable-domain approximation (last two labels, three for common 2nd-level ccTLDs). */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const sl = parts[parts.length - 2]!;
  const n = ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu'].includes(sl) && parts[parts.length - 1]!.length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** Site key for a host: registrable domain, or the literal for IP hosts. */
export function siteKey(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return isIP(h) ? h : siteOf(h);
}

/** Site of a sender ("Name <a@b.example>" or "a@b.example"); '' when there is none. */
export function senderSite(from: string | null | undefined): string {
  const d = (from ?? '').toLowerCase().match(/@([a-z0-9.\-[\]:]+)/)?.[1];
  return d ? siteKey(d.replace(/[>\]]+$/, '')) : '';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/** Extract candidate URLs from an untrusted body (HTML or text). No HTML is rendered or executed. */
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) out.add(decodeEntities(m[1]!.trim()));
  for (const m of body.matchAll(/https?:\/\/[^\s"'<>()\]]+/gi)) out.add(decodeEntities(m[0].replace(/[.,;:!?]+$/, '')));
  return [...out];
}

export function validateLink(raw: string, allowedOrigins: string[]): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'unparsable URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: `scheme ${u.protocol} not allowed` };
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL' };
  if (!allowedOrigins.includes(u.origin)) return { ok: false, reason: `origin ${u.origin} is not the target or a configured auth origin` };
  return { ok: true, url: u.toString() };
}

const VERIFY_HINT = /(verif|confirm|activat|validate|magic|token|signup|register|complete)/i;

/** Decide whether one email is the verification message for this query. */
export function evaluateEmail(email: Email, q: VerificationQuery): { result?: Omit<VerificationResult, 'skipped'>; reason: string } {
  const to = (email.to ?? []).map((t) => t.toLowerCase());
  if (!to.some((t) => t.includes(q.inboxAddress.toLowerCase()))) return { reason: 'not addressed to this inbox address' };
  if (email.inboxId && email.inboxId !== q.inboxId) return { reason: 'belongs to a different inbox' };
  const created = Date.parse(email.createdAt);
  if (!Number.isFinite(created)) return { reason: 'malformed: invalid createdAt' };
  if (created < Date.parse(q.sinceIso) - CLOCK_SKEW_MS) return { reason: 'received before this job started' };
  if (typeof email.body !== 'string' || email.body.length === 0) return { reason: 'malformed: empty body' };
  if (email.body.length > 2_000_000) return { reason: 'malformed: body too large' };
  const from = (email.from ?? '').toLowerCase();
  if (q.allowedSenderSites && !q.allowedSenderSites.includes(senderSite(from))) {
    return { reason: `unrelated: sender not from a site this inbox is bound to (${q.allowedSenderSites.join(', ')})` };
  }
  if (q.fromContains && !from.includes(q.fromContains.toLowerCase())) return { reason: 'sender does not match fromContains' };
  if (q.subjectContains && !(email.subject ?? '').toLowerCase().includes(q.subjectContains.toLowerCase())) {
    return { reason: 'subject does not match subjectContains' };
  }

  const targetSite = siteOf(new URL(q.targetOrigin).hostname);
  const senderDomain = from.match(/@([a-z0-9.-]+)/)?.[1] ?? '';
  const links = extractLinks(email.body);
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const l of links) {
    const v = validateLink(l, q.allowedLinkOrigins);
    if (v.ok) valid.push(v.url);
    else rejected.push(v.reason);
  }
  const relatedSender = senderDomain !== '' && siteOf(senderDomain) === targetSite;
  if (!relatedSender && valid.length === 0) {
    return { reason: `unrelated: sender not from ${targetSite} and no link to an allowed origin` };
  }

  let chosen: string | null = null;
  const pool = q.linkContains ? valid.filter((l) => l.includes(q.linkContains!)) : valid;
  chosen = pool.find((l) => VERIFY_HINT.test(new URL(l).pathname + new URL(l).search)) ?? (q.linkContains ? pool[0] ?? null : null);

  let code: string | null = null;
  if (!chosen) {
    const text = email.body.replace(/<[^>]+>/g, ' ');
    code = text.match(/\b(?:code|otp|pin)\b[^0-9]{0,40}(\d{4,8})\b/i)?.[1] ?? null;
  }
  if (!chosen && !code) {
    return { reason: rejected.length ? `no acceptable verification link (${[...new Set(rejected)].slice(0, 3).join('; ')})` : 'no verification link or code found' };
  }
  return {
    reason: 'accepted',
    result: { emailId: email.id, receivedAt: email.createdAt, subject: email.subject ?? null, from: email.from ?? null, link: chosen, code },
  };
}

/**
 * Bounded, cancellable polling for the verification email of one job.
 * Never picks "the newest email": every candidate must be addressed to the
 * job's inbox, arrive after the job started, relate to the target, and carry a
 * link to an allowed origin (or a code).
 */
export async function waitForVerification(
  client: MailSlurpClient,
  q: VerificationQuery,
  hooks: { onEmailReceived?: (id: string) => void } = {},
): Promise<VerificationResult> {
  const deadline = Date.now() + q.timeoutMs;
  const pollMs = Math.max(250, q.pollMs ?? 5000);
  const seen = q.seen ?? new Set<string>();
  const skipped: EvaluatedEmail[] = [];
  let since = new Date(Date.parse(q.sinceIso) - CLOCK_SKEW_MS).toISOString();
  let consecutiveErrors = 0;
  while (true) {
    q.signal?.throwIfAborted();
    let previews: import("./mailslurp.js").EmailPreview[];
    try {
      previews = await client.listEmails(q.inboxId, since, q.signal);
      consecutiveErrors = 0;
    } catch (e) {
      // Transient provider errors are retried a bounded number of times (reads only: no side effects).
      if (!(e instanceof RbaError) || e.code !== 'provider_error' || ++consecutiveErrors > MAX_CONSECUTIVE_ERRORS) throw e;
      previews = [];
    }
    for (const p of previews) {
      if (!p || typeof p.id !== 'string' || seen.has(p.id)) continue;
      seen.add(p.id);
      hooks.onEmailReceived?.(p.id);
      let full: Email;
      try {
        full = await client.getEmail(p.id, q.signal);
      } catch (e) {
        if (e instanceof RbaError && e.code === 'cancelled') throw e;
        const ev = { emailId: p.id, accepted: false, reason: `malformed: could not fetch (${(e as Error).message})` };
        skipped.push(ev);
        q.onEvaluated?.(ev);
        continue;
      }
      const r = evaluateEmail(full, q);
      const ev = { emailId: p.id, accepted: !!r.result, reason: r.reason };
      q.onEvaluated?.(ev);
      if (r.result) return { ...r.result, skipped };
      skipped.push(ev);
    }
    // A full page (50, ascending) may hide newer mail: page forward by createdAt.
    let advanced = false;
    if (previews.length >= 50) {
      const last = previews[previews.length - 1]?.createdAt;
      if (last && Date.parse(last) > Date.parse(since)) {
        since = last;
        advanced = true;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new RbaError('timeout', `no matching verification email within ${Math.round(q.timeoutMs / 1000)}s`, { skipped });
    }
    // Only skip the wait when the cursor moved, so a page of identical timestamps cannot spin.
    if (!advanced) await sleep(Math.min(pollMs, remaining), q.signal);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RbaError('cancelled', 'cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new RbaError('cancelled', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
