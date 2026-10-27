/**
 * Worker routes for saved read operations (see protocol.ts FetchRequest / CaptureRequest).
 *
 * POST /fetch: one HTTP request from the session's browser context. Playwright's
 *   `context.request` shares the context's cookie jar (Set-Cookie updates it) and
 *   uses the browser's launch proxy, i.e. this worker's PolicyProxy (and, in proxy
 *   modes, the upstream proxy behind it). It is NOT seen by `context.route`, so
 *   every hop is checked here first against the resource policy, and redirects
 *   are followed manually (maxRedirects: 0 per hop) so no hop is sent unchecked.
 *   The PolicyProxy then applies the same allowlist + address policy again at
 *   connection time.
 *
 * POST /capture: navigate the interactive page (policy-checked like /navigate),
 *   run fixed steps (no caller code), and record the page's own document / xhr /
 *   fetch exchanges with bounded bodies.
 *
 * Neither route logs URLs beyond safeUrlForLog, headers or bodies.
 */
import type { Page, Response } from 'playwright';
import { clampTimeout, type BrowserSession } from './browser.js';
import { WorkerFail, cleanMessage, isTimeout } from './errors.js';
import { log } from './log.js';
import { checkUrl, safeUrlForLog } from './netpolicy.js';
import {
  CAPTURE_MAX_BODY_BYTES,
  CAPTURE_MAX_EXCHANGES,
  CAPTURE_MAX_STEPS,
  CAPTURE_MAX_WAIT_MS,
  FETCH_MAX_REDIRECTS,
  FETCH_MAX_REQUEST_BODY_BYTES,
  FETCH_MAX_RESPONSE_BYTES,
  type BlockSignal,
  type CapturedExchange,
  type CaptureRequest,
  type CaptureResponse,
  type CaptureStep,
  type FetchRequest,
  type FetchResponse,
} from './protocol.js';
import { ValidationError, isObj, onlyKeys } from './validate.js';

const FORBIDDEN_HEADERS = new Set(['cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'expect']);
const KEPT_RESPONSE_HEADERS = ['content-type', 'content-length', 'retry-after', 'location', 'www-authenticate'];
const MAX_HEADERS = 60;
const MAX_HEADER_VALUE = 8192;
const STORAGE_MAX_KEYS = 200;
const STORAGE_MAX_VALUE = 4096;

function httpUrl(v: unknown, where: string): void {
  if (typeof v !== 'string' || v.length > 8192) throw new ValidationError(`${where} must be a URL string`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ValidationError(`${where} must be a valid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ValidationError(`${where} must be http(s)`);
  if (u.username || u.password) throw new ValidationError(`${where} must not contain credentials`);
}

function intIn(v: unknown, min: number, max: number, where: string): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ValidationError(`${where} must be an integer in [${min}, ${max}]`);
}

export function validateFetchRequest(b: Record<string, unknown>): void {
  httpUrl(b.url, '/fetch: url');
  if (b.headers !== undefined) {
    const h = b.headers as Record<string, unknown>;
    const keys = Object.keys(h);
    if (keys.length > MAX_HEADERS) throw new ValidationError(`/fetch: at most ${MAX_HEADERS} headers`);
    for (const k of keys) {
      const v = h[k];
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(k)) throw new ValidationError('/fetch: header names must be lower-case tokens');
      if (FORBIDDEN_HEADERS.has(k) || k.startsWith('proxy-')) throw new ValidationError(`/fetch: header "${k}" is not allowed (cookies come from the browser context only)`);
      if (typeof v !== 'string' || v.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(v)) throw new ValidationError(`/fetch: header "${k}" must be a single-line string`);
    }
  }
  if (b.body !== undefined) {
    if (b.method !== 'POST') throw new ValidationError('/fetch: body is only allowed with POST');
    if (Buffer.byteLength(b.body as string, 'utf8') > FETCH_MAX_REQUEST_BODY_BYTES) throw new ValidationError('/fetch: body too large');
  }
  intIn(b.maxRedirects, 0, FETCH_MAX_REDIRECTS, '/fetch: maxRedirects');
  const sens = b.sensitiveHeaders as string[] | undefined;
  if (sens !== undefined && (sens.length > MAX_HEADERS || sens.some((h) => !/^[a-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(h)))) {
    throw new ValidationError('/fetch: sensitiveHeaders must be lower-case header names');
  }
  intIn(b.maxResponseBytes, 1, FETCH_MAX_RESPONSE_BYTES, '/fetch: maxResponseBytes');
}

const KEY_RE = /^[A-Za-z0-9+]{1,40}$/;

export function validateCaptureRequest(b: Record<string, unknown>): void {
  httpUrl(b.url, '/capture: url');
  intIn(b.waitMs, 0, CAPTURE_MAX_WAIT_MS, '/capture: waitMs');
  intIn(b.maxExchanges, 1, CAPTURE_MAX_EXCHANGES, '/capture: maxExchanges');
  intIn(b.maxBodyBytes, 1, CAPTURE_MAX_BODY_BYTES, '/capture: maxBodyBytes');
  if (b.steps === undefined) return;
  if (!Array.isArray(b.steps) || b.steps.length > CAPTURE_MAX_STEPS) throw new ValidationError(`/capture: steps must be an array of at most ${CAPTURE_MAX_STEPS}`);
  for (const [i, s] of (b.steps as unknown[]).entries()) {
    const w = `/capture: steps[${i}]`;
    if (!isObj(s)) throw new ValidationError(`${w} must be an object`);
    onlyKeys(s, ['action', 'selector', 'value', 'ms'], w);
    const sel = s.selector;
    if (sel !== undefined && (typeof sel !== 'string' || sel.length === 0 || sel.length > 2000)) throw new ValidationError(`${w}.selector must be a non-empty string`);
    if (s.value !== undefined && (typeof s.value !== 'string' || s.value.length > 2000)) throw new ValidationError(`${w}.value must be a string`);
    switch (s.action) {
      case 'goto':
        httpUrl(s.value, `${w}.value`);
        break;
      case 'click':
        if (sel === undefined) throw new ValidationError(`${w}: click needs a selector`);
        break;
      case 'fill':
        if (sel === undefined || s.value === undefined) throw new ValidationError(`${w}: fill needs selector and value`);
        break;
      case 'press':
        if (typeof s.value !== 'string' || !KEY_RE.test(s.value)) throw new ValidationError(`${w}: press needs a key name such as "Enter"`);
        break;
      case 'wait':
        intIn(s.ms, 0, CAPTURE_MAX_WAIT_MS, `${w}.ms`);
        if (s.ms === undefined) throw new ValidationError(`${w}: wait needs ms`);
        break;
      default:
        throw new ValidationError(`${w}.action must be goto|click|fill|press|wait`);
    }
  }
}

function blockedFor(status: number): BlockSignal | null {
  if (status === 403) return { kind: 'access_denied', category: 'access_denied', detail: 'HTTP 403' };
  if (status === 429) return { kind: 'rate_limited', category: 'access_denied', detail: 'HTTP 429' };
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchVia(s: BrowserSession, req: FetchRequest): Promise<FetchResponse> {
  s.ensureReady();
  const ctx = s.context!;
  const timeout = clampTimeout(req.timeoutMs);
  const deadline = Date.now() + timeout;
  const maxRedirects = req.maxRedirects ?? FETCH_MAX_REDIRECTS;
  const maxBytes = req.maxResponseBytes ?? FETCH_MAX_RESPONSE_BYTES;
  let headers: Record<string, string> = { ...(req.headers ?? {}) };
  let method: string = req.method;
  let body: string | undefined = req.body;
  let url = req.url;
  const chain: string[] = [];
  for (let hop = 0; ; hop++) {
    const chk = await checkUrl(s.policy, url, { topLevelNavigation: false });
    if (!chk.ok) {
      log('fetch_blocked', { url: safeUrlForLog(url), hop });
      throw new WorkerFail('navigation_blocked', `request ${hop === 0 ? '' : 'redirect '}to ${safeUrlForLog(url)} refused: ${chk.reason}`);
    }
    chain.push(url);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new WorkerFail('timeout', 'fetch exceeded its timeout');
    let resp;
    try {
      resp = await ctx.request.fetch(url, { method, headers, data: body, maxRedirects: 0, timeout: remaining, failOnStatusCode: false });
    } catch (e) {
      if (isTimeout(e) || /Timeout|timed out/i.test((e as Error)?.message ?? '')) throw new WorkerFail('timeout', cleanMessage(e));
      if (/403|tunnel|ECONNRESET|socket hang up/i.test((e as Error)?.message ?? '')) {
        throw new WorkerFail('navigation_blocked', `request to ${safeUrlForLog(url)} failed at the network policy proxy: ${cleanMessage(e)}`);
      }
      throw new WorkerFail('navigation_failed', cleanMessage(e));
    }
    const status = resp.status();
    const rh = resp.headers();
    if (rh['x-rba-blocked'] === '1') {
      await resp.dispose().catch(() => undefined);
      throw new WorkerFail('navigation_blocked', `request to ${safeUrlForLog(url)} refused by the network policy proxy`);
    }
    const loc = rh['location'];
    if (status >= 300 && status < 400 && status !== 304 && loc) {
      await resp.dispose().catch(() => undefined);
      if (hop >= maxRedirects) throw new WorkerFail('navigation_failed', `more than ${maxRedirects} redirects`);
      let next: string;
      try {
        next = new URL(loc, url).href;
      } catch {
        throw new WorkerFail('navigation_failed', 'redirect with an invalid Location');
      }
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type'));
      }
      if (new URL(next).origin !== new URL(url).origin) {
        if (!req.allowCrossOriginRedirects) {
          throw new WorkerFail('navigation_blocked', `redirect to another origin (${safeUrlForLog(next)}) refused; nothing was sent there`);
        }
        const drop = new Set(['authorization', ...(req.sensitiveHeaders ?? [])]);
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k)));
      }
      url = next;
      continue;
    }
    let buf: Buffer;
    try {
      buf = method === 'HEAD' ? Buffer.alloc(0) : await resp.body();
    } catch (e) {
      throw new WorkerFail('navigation_failed', `could not read the response: ${cleanMessage(e)}`);
    } finally {
      await resp.dispose().catch(() => undefined);
    }
    const kept: Record<string, string> = {};
    for (const k of KEPT_RESPONSE_HEADERS) if (rh[k] !== undefined) kept[k] = rh[k]!.slice(0, 1000);
    log('fetched', { url: safeUrlForLog(url), status, hops: chain.length });
    return {
      status,
      url,
      redirectChain: chain,
      contentType: rh['content-type'] ?? '',
      headers: kept,
      body: buf.subarray(0, maxBytes).toString('utf8'),
      bytes: buf.length,
      truncated: buf.length > maxBytes,
      blocked: blockedFor(status),
    };
  }
}

const CAPTURED_TYPES = new Set(['document', 'xhr', 'fetch']);

export async function capture(s: BrowserSession, req: CaptureRequest): Promise<CaptureResponse> {
  const page = s.ensureReady();
  const timeout = clampTimeout(req.timeoutMs);
  const deadline = Date.now() + timeout;
  const left = () => Math.max(100, deadline - Date.now());
  const maxEx = req.maxExchanges ?? 100;
  const maxBody = req.maxBodyBytes ?? 256 * 1024;
  const exchanges: CapturedExchange[] = [];
  const work: Promise<unknown>[] = [];
  const locations: string[] = [];
  let over = false;
  let n = 0;

  const onResponse = (resp: Response) => {
    const r = resp.request();
    if (!CAPTURED_TYPES.has(r.resourceType())) return;
    try {
      if (r.frame().page() !== page) return;
    } catch {
      return;
    }
    if (exchanges.length >= maxEx) {
      over = true;
      return;
    }
    const ex: CapturedExchange = { id: ++n, resourceType: r.resourceType(), request: { method: r.method(), url: r.url(), headers: {} } };
    exchanges.push(ex);
    work.push(
      (async () => {
        ex.request.headers = await r.allHeaders().catch(() => r.headers());
        const pd = r.postData();
        if (pd !== null) {
          ex.request.body = pd.slice(0, maxBody);
          if (pd.length > maxBody) ex.truncated = true;
        }
        const status = resp.status();
        const h = await resp.allHeaders().catch(() => resp.headers());
        let body: string | undefined;
        if (!(status >= 300 && status < 400)) {
          try {
            const b = await resp.body();
            body = b.subarray(0, maxBody).toString('utf8');
            if (b.length > maxBody) ex.truncated = true;
          } catch {
            body = undefined;
          }
        }
        ex.response = { status, headers: h, contentType: h['content-type'] ?? '', ...(body !== undefined ? { body } : {}) };
      })().catch(() => undefined),
    );
  };
  const onNav = (f: import('playwright').Frame) => {
    if (f === page.mainFrame() && locations.length < 50) locations.push(f.url());
  };
  page.on('response', onResponse);
  page.on('framenavigated', onNav);
  try {
    await s.gotoChecked(page, req.url, { waitUntil: 'load', timeoutMs: left(), deadlineAt: deadline });
    for (const step of req.steps ?? []) await runStep(s, page, step, left());
    await sleep(Math.min(req.waitMs ?? 1500, left()));
  } finally {
    page.off('response', onResponse);
    page.off('framenavigated', onNav);
  }
  await Promise.race([Promise.allSettled(work), sleep(Math.min(5000, left()))]);
  const storage = await page
    .evaluate(
      ([maxKeys, maxVal]) => {
        const out: Record<string, string> = {};
        let k = 0;
        for (const st of [window.localStorage, window.sessionStorage]) {
          try {
            for (let i = 0; i < st.length && k < maxKeys; i++) {
              const key = st.key(i);
              if (key === null) continue;
              const v = st.getItem(key);
              if (v !== null && v.length <= maxVal) {
                out[key] = v;
                k++;
              }
            }
          } catch {
            /* storage unavailable (opaque origin) */
          }
        }
        return out;
      },
      [STORAGE_MAX_KEYS, STORAGE_MAX_VALUE] as const,
    )
    .catch(() => ({}));
  log('captured', { url: safeUrlForLog(page.url()), exchanges: exchanges.length, truncated: over });
  return { page: await s.summary(page), finalUrl: page.url(), locations, exchanges: [...exchanges].sort((a, b) => a.id - b.id), storage, truncated: over };
}

async function runStep(s: BrowserSession, page: Page, step: CaptureStep, timeoutMs: number): Promise<void> {
  switch (step.action) {
    case 'goto':
      await s.gotoChecked(page, step.value!, { waitUntil: 'load', timeoutMs, deadlineAt: Date.now() + timeoutMs });
      return;
    case 'click':
      await s.click({ selector: step.selector!, timeoutMs: Math.min(timeoutMs, 30_000) });
      return;
    case 'fill':
      await s.fill({ selector: step.selector!, value: step.value!, timeoutMs: Math.min(timeoutMs, 30_000) });
      return;
    case 'press':
      try {
        await page.keyboard.press(step.value!);
      } catch (e) {
        throw new WorkerFail('action_failed', cleanMessage(e));
      }
      await page.waitForLoadState('load', { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);
      {
        // A key press may submit a form: the page must still be on an allowed navigation origin.
        const u = page.url();
        const r = u === 'about:blank' ? { ok: true as const } : await checkUrl(s.policy, u, { topLevelNavigation: true });
        if (!r.ok) {
          await s.resetToBlank(page);
          throw new WorkerFail('navigation_blocked', `page left the allowed origins after a key press: ${r.reason}`);
        }
      }
      return;
    case 'wait':
      await sleep(Math.min(step.ms ?? 0, timeoutMs));
      return;
  }
}
