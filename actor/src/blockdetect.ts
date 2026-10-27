/**
 * Heuristic detection of captchas / human verification / access blocks.
 * The worker only REPORTS these; it never attempts to solve or bypass them.
 *
 * Three outcomes, kept separate on purpose:
 *  - integration detected: a CAPTCHA/anti-bot vendor's script, hidden badge or
 *    invisible widget is on the page, but nothing asks the user to act. Many
 *    ordinary pages load reCAPTCHA v3 / invisible widgets on every view, so this
 *    is reported in `integrations` and is NOT a block.
 *  - challenge required: a visible widget or challenge page (checkbox, image
 *    challenge, Cloudflare interstitial, "verify you are human" page).
 *  - access denied: the site refused the request (HTTP 403 / 429). The status
 *    alone says nothing about which mechanism refused it.
 */
import type { Page } from 'playwright';
import type { BlockSignal, IntegrationSignal } from './protocol.js';

type Vendor = IntegrationSignal['vendor'];

interface PageProbe {
  /** Visible challenge widgets: vendor + short evidence. */
  challenges: Array<{ vendor: Vendor; evidence: string }>;
  /** Vendor presence without a visible challenge. */
  integrations: Array<{ vendor: Vendor; evidence: string }>;
  /** Cloudflare-style interstitial markers present. */
  interstitial: string[];
  text: string;
  textLength: number;
}

/** Fixed in-page function (no caller-supplied code). Self-contained: it is serialized. */
function probePage(): PageProbe {
  const vendorOf = (src: string): 'recaptcha' | 'hcaptcha' | 'turnstile' | null => {
    if (/(google\.com|recaptcha\.net)\/recaptcha|gstatic\.com\/recaptcha/i.test(src)) return 'recaptcha';
    if (/hcaptcha\.com/i.test(src)) return 'hcaptcha';
    if (/challenges\.cloudflare\.com/i.test(src)) return 'turnstile';
    return null;
  };
  // Visible = rendered with a real size, not hidden, and on (or near) the page:
  // reCAPTCHA parks its hidden challenge frame at top:-10000px.
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) return false;
    if (r.bottom <= 0 || r.right <= 0) return false;
    let e: Element | null = el;
    while (e) {
      const st = getComputedStyle(e);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.1) return false;
      e = e.parentElement;
    }
    return true;
  };
  const challenges: PageProbe['challenges'] = [];
  const integrations: PageProbe['integrations'] = [];
  const host = (s: string) => {
    try {
      return new URL(s).hostname;
    } catch {
      return 'unknown';
    }
  };
  document.querySelectorAll('iframe[src]').forEach((el) => {
    const src = (el as HTMLIFrameElement).src || '';
    const v = vendorOf(src);
    if (!v) return;
    const invisibleMode = /[?&#]size=invisible\b/i.test(src);
    const isChallengeFrame = /\/bframe|frame=challenge/i.test(src);
    if (visible(el) && (!invisibleMode || isChallengeFrame)) {
      challenges.push({ vendor: v, evidence: `visible ${isChallengeFrame ? 'challenge' : 'widget'} frame (${host(src)})` });
    } else {
      integrations.push({ vendor: v, evidence: `${invisibleMode ? 'invisible-mode' : 'hidden'} frame (${host(src)})` });
    }
  });
  document.querySelectorAll('script[src]').forEach((el) => {
    const src = (el as HTMLScriptElement).src || '';
    const v = vendorOf(src);
    if (v) integrations.push({ vendor: v, evidence: `script (${host(src)})` });
  });
  const containers: Array<[string, 'recaptcha' | 'hcaptcha' | 'turnstile']> = [
    ['.g-recaptcha', 'recaptcha'],
    ['.h-captcha', 'hcaptcha'],
    ['.cf-turnstile', 'turnstile'],
  ];
  for (const [sel, v] of containers) {
    document.querySelectorAll(sel).forEach((el) => {
      const invisibleMode = (el.getAttribute('data-size') ?? '').toLowerCase() === 'invisible';
      if (!invisibleMode && visible(el)) challenges.push({ vendor: v, evidence: `visible ${sel} widget` });
      else integrations.push({ vendor: v, evidence: `${invisibleMode ? 'invisible' : 'hidden'} ${sel} element` });
    });
  }
  if (document.querySelector('.grecaptcha-badge')) integrations.push({ vendor: 'recaptcha', evidence: 'reCAPTCHA badge' });
  const interstitial = ['#challenge-form', '#cf-challenge-running', '#challenge-running', '#challenge-stage'].filter((s) => document.querySelector(s) !== null);
  if (/^just a moment/i.test(document.title)) interstitial.push('title "Just a moment..."');
  const full = document.body?.innerText ?? '';
  return { challenges: challenges.slice(0, 5), integrations: integrations.slice(0, 10), interstitial, text: full.slice(0, 20000).toLowerCase(), textLength: full.length };
}

const HUMAN_PHRASES = [
  'verify you are human',
  'verify you are a human',
  'are you a robot',
  'unusual traffic',
  'confirm you are not a robot',
  "i'm not a robot",
  'checking your browser',
];

/** Phrase matches only count on short pages (an interstitial), not inside long articles. */
const PHRASE_PAGE_MAX_CHARS = 3000;

export interface PageSignals {
  blocked: BlockSignal | null;
  integrations: IntegrationSignal[];
}

function dedupe(list: IntegrationSignal[]): IntegrationSignal[] {
  const seen = new Set<string>();
  return list.filter((i) => {
    const k = `${i.vendor}|${i.evidence}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function detectSignals(page: Page, status: number | null): Promise<PageSignals> {
  const url = page.url();
  let probe: PageProbe | null = null;
  try {
    probe = await page.evaluate(probePage);
  } catch {
    probe = null;
  }
  const integrations = dedupe(probe?.integrations ?? []);
  const text = probe?.text ?? '';
  const out = (b: BlockSignal | null): PageSignals => ({ blocked: b, integrations });
  try {
    const u = new URL(url);
    if (u.hostname === 'accounts.google.com' && (u.pathname.includes('/challenge/') || text.includes("verify it's you") || text.includes('verify it’s you'))) {
      return out({ kind: 'interactive_login_challenge', category: 'challenge_required', detail: 'Google account challenge page' });
    }
  } catch {
    /* about:blank etc. */
  }
  if (probe && probe.challenges.length > 0) {
    const what = probe.challenges.map((c) => `${c.vendor}: ${c.evidence}`).slice(0, 3).join(', ');
    return out({ kind: 'captcha', category: 'challenge_required', detail: `visible challenge (${what})` });
  }
  if (probe && probe.interstitial.length > 0) {
    return out({ kind: 'human_verification', category: 'challenge_required', detail: `challenge page markers (${probe.interstitial.join(', ')})` });
  }
  const phrase = HUMAN_PHRASES.find((p) => text.includes(p));
  if (phrase && ((probe?.textLength ?? 0) <= PHRASE_PAGE_MAX_CHARS || status === 403 || status === 429 || status === 503)) {
    return out({ kind: 'human_verification', category: 'challenge_required', detail: `page text mentions "${phrase}"` });
  }
  if (status === 429) return out({ kind: 'rate_limited', category: 'access_denied', detail: 'HTTP 429 Too Many Requests' });
  if (status === 403) return out({ kind: 'access_denied', category: 'access_denied', detail: 'HTTP 403 Forbidden (the status does not say which mechanism refused the request)' });
  return out(null);
}

export async function detectBlock(page: Page, status: number | null): Promise<BlockSignal | null> {
  return (await detectSignals(page, status)).blocked;
}
