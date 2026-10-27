/**
 * One isolated Playwright Chromium session (one per Actor run).
 */
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type ElementHandle, type Page, type Response } from 'playwright';
import type {
  ClickRequest,
  DialogPolicy,
  DialogRecord,
  EgressReport,
  ElementInfo,
  ElementTarget,
  ExtractRequest,
  ExtractResponse,
  FillRequest,
  InitRequest,
  InitResponse,
  InspectRequest,
  InspectResponse,
  NavigateRequest,
  NavigateResponse,
  PageSummary,
  Readiness,
  ReadyCondition,
  ScreenshotRequest,
  ScreenshotResponse,
  SelectRequest,
  StorageState,
  UploadRequest,
  UploadResponse,
  WorkerInput,
} from './protocol.js';
import { DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_SETTLE_MS, MAX_COMMAND_TIMEOUT_MS, conditionBudgetMs, settleBudgetMs } from './protocol.js';
import { WorkerFail, cleanMessage, isTimeout } from './errors.js';
import { detectSignals } from './blockdetect.js';
import { extract, ExtractSpecError } from './extract.js';
import { log } from './log.js';
import { checkHost, checkUrl, defaultPort, makePolicy, normalizeOrigin, safeUrlForLog, type NetworkPolicy } from './netpolicy.js';
import { PolicyProxy, parseUpstream } from './policyproxy.js';

export const DEFAULT_TIMEOUT_MS = DEFAULT_COMMAND_TIMEOUT_MS;
const MAX_TIMEOUT_MS = MAX_COMMAND_TIMEOUT_MS;
const MAX_SCREENSHOT_HEIGHT = 16_384;

/**
 * Chromium args. WebRTC flags stop UDP from leaking around the proxy. No
 * `--proxy-bypass-list` is passed; the Playwright `bypass: '<-loopback>'`
 * option REMOVES Chromium's implicit loopback bypass so loopback traffic also
 * hits the policy proxy (and is blocked there unless explicitly allowed).
 */
const CHROMIUM_ARGS = [
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-quic',
];

export type ProxyUrlResolver = (input: WorkerInput) => Promise<string>;

/** The fields of CDP `Fetch.requestPaused` this worker reads. */
interface PausedRequest {
  requestId: string;
  frameId: string;
  redirectedRequestId?: string;
  request: { url: string };
}

interface NavBlock {
  url: string;
  reason: string;
  at: number;
}

export function clampTimeout(t: number | undefined): number {
  if (t === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.max(100, Math.min(MAX_TIMEOUT_MS, t));
}

export class BrowserSession {
  readonly policy: NetworkPolicy;
  private browser: Browser | null = null;
  context: BrowserContext | null = null;
  page: Page | null = null;
  private proxy: PolicyProxy | null = null;
  egress: EgressReport | null = null;
  initialized = false;
  initializing = false;
  initFailed = false;

  private generation = 0;
  private refsValid = false;
  private handles = new Map<string, ElementHandle>();
  private lastMainStatus = new WeakMap<Page, number | null>();
  private lastMainResponse = new WeakMap<Page, { resp: Response; at: number }>();
  private navBlocks = new WeakMap<Page, NavBlock>();
  private configuredResourceOrigins: Set<string>;
  private egressExemptionActive = true;
  /** Pages this worker created (interactive page, crawl page). Anything else is a popup. */
  private managed = new WeakSet<Page>();
  /** In-flight and recent requests of managed pages, for diagnostics. */
  private pending = new Map<import('playwright').Request, { url: string; resourceType: string; method: string; start: number; page: Page }>();
  private recent: Array<{ url: string; resourceType: string; method: string; durationMs: number; status: number | null; failure?: string }> = [];
  /** Dialog policy of the action currently running on a page (null: dismiss). */
  private dialogScope = new WeakMap<Page, { policy: DialogPolicy | null; used: number; records: DialogRecord[] }>();

  constructor(
    readonly input: WorkerInput,
    private resolveProxyUrl: ProxyUrlResolver,
  ) {
    // The egress-check origin must be reachable for the IP comparison at init
    // only; it is removed again right after (see endEgressExemption).
    let egressOrigin: string[] = [];
    try {
      egressOrigin = [new URL(input.egressCheckUrl).origin];
    } catch {
      /* invalid URL: the egress check fails closed */
    }
    this.policy = makePolicy(input.network, egressOrigin);
    this.configuredResourceOrigins = new Set(makePolicy(input.network).allowedResourceOrigins);
  }

  // ------------------------------------------------------------------ init

  async init(req: InitRequest): Promise<InitResponse> {
    if (this.initialized || this.initializing || this.initFailed) {
      throw new WorkerFail('bad_request', 'session already initialised (one init per worker)');
    }
    this.initializing = true;
    try {
      const res = await this.doInit(req);
      this.initialized = true;
      return res;
    } catch (e) {
      this.initFailed = true;
      await this.close();
      throw e;
    } finally {
      this.initializing = false;
    }
  }

  private async doInit(req: InitRequest): Promise<InitResponse> {
    const mode = this.input.proxy.mode;
    let upstream = null;
    if (mode !== 'direct') {
      let url: string;
      try {
        url = await this.resolveProxyUrl(this.input);
        upstream = parseUpstream(url);
      } catch (e) {
        log('proxy_unavailable', { mode, err: e instanceof WorkerFail ? e.code : (e as Error)?.name });
        throw new WorkerFail('proxy_unavailable', `could not obtain a ${mode} proxy; refusing to run without it`);
      }
    }
    this.proxy = new PolicyProxy(this.policy, upstream);
    const proxyPort = await this.proxy.start();

    // Set only by the local provider (RBA_LOCAL_RECORD_VIDEO_DIR); remote runs never record.
    const videoDir = process.env.RBA_WORKER_RECORD_VIDEO_DIR;
    this.browser = await chromium.launch({
      headless: true,
      proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '<-loopback>' },
      args: CHROMIUM_ARGS,
      // While recording, the worker's own shutdown closes the context (finalizing the
      // video) before the browser; Playwright's signal handlers would kill it first.
      ...(videoDir ? { handleSIGTERM: false, handleSIGINT: false } : {}),
    });
    const viewport = req.viewport ?? (videoDir ? { width: 1920, height: 1080 } : { width: 1280, height: 900 });
    this.context = await this.browser.newContext({
      storageState: req.storageState as never,
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport,
      ...(videoDir ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
      userAgent: req.userAgent,
      locale: req.locale,
    });
    await this.installNetworkGuards(this.context);
    this.context.on('page', (p) => {
      // Single-page session: close popups/new windows opened by pages.
      void p.opener().then((op) => {
        if (op) void p.close().catch(() => undefined);
      });
    });
    this.page = await this.newTrackedPage();

    const egress = await this.checkEgress(this.page);
    this.endEgressExemption();
    this.egress = egress;
    if (egress.status !== 'verified' && mode !== 'direct') {
      throw new WorkerFail('egress_unverified', `egress verification failed: ${egress.note}`);
    }
    log('session_ready', { mode, egress: egress.status });
    return { egress, browserVersion: this.browser.version() };
  }

  /**
   * After the init-time IP comparison, pages must not keep a channel to the
   * egress-check endpoint (e.g. api.apify.com): drop its origin from the
   * resource allowlist (the proxy shares this policy object) unless it was
   * configured explicitly, and stop exempting its URL from the allowlists.
   */
  private endEgressExemption(): void {
    this.egressExemptionActive = false;
    this.policy.allowedResourceOrigins = this.policy.allowedResourceOrigins.filter((o) => this.configuredResourceOrigins.has(o));
  }

  private get exemptUrl(): string | undefined {
    return this.egressExemptionActive ? this.input.egressCheckUrl : undefined;
  }

  private async installNetworkGuards(ctx: BrowserContext): Promise<void> {
    await ctx.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      let topLevel = false;
      let page: Page | null = null;
      try {
        const f = req.frame();
        page = f.page();
        topLevel = req.isNavigationRequest() && f.parentFrame() === null;
      } catch {
        // Service worker / no frame. Playwright has no frame for a navigation
        // issued before its frame exists - that is a popup / new window.
        topLevel = req.isNavigationRequest();
      }
      let res;
      try {
        if (topLevel && (!page || !this.managed.has(page))) {
          // Popups / new windows opened by a page never load anything: their first
          // request is refused here, before any connection (the page is then closed).
          res = { ok: false as const, reason: 'popups and new windows are not allowed' };
        } else {
          res = await checkUrl(this.policy, url, { topLevelNavigation: topLevel, allowlistExemptUrl: this.exemptUrl });
        }
      } catch {
        res = { ok: false as const, reason: 'policy check failed' };
      }
      if (!res.ok) {
        if (topLevel && page) this.navBlocks.set(page, { url, reason: res.reason, at: Date.now() });
        this.noteBlocked(url, res.reason);
        log('request_blocked', { url: safeUrlForLog(url), topLevel });
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });
    await ctx.routeWebSocket(/.*/, async (ws) => {
      const r = await checkUrl(this.policy, ws.url(), { topLevelNavigation: false }).catch(() => ({ ok: false as const, reason: 'error' }));
      if (!r.ok) {
        this.noteBlocked(ws.url(), r.reason);
        log('websocket_blocked', { url: safeUrlForLog(ws.url()) });
        await ws.close({ code: 1008, reason: 'blocked by policy' }).catch(() => undefined);
        return;
      }
      ws.connectToServer();
    });
  }

  async newTrackedPage(): Promise<Page> {
    const p = await this.context!.newPage();
    this.managed.add(p);
    // Single dispatcher: dismiss by default; an action-scoped policy may accept.
    p.on('dialog', (d) => void this.onDialog(p, d));
    p.on('request', (r) => {
      if (this.pending.size < 500) this.pending.set(r, { url: safeUrlForLog(r.url()), resourceType: r.resourceType(), method: r.method(), start: Date.now(), page: p });
    });
    const finish = (r: import('playwright').Request, failure?: string) => {
      const e = this.pending.get(r);
      if (!e) return;
      this.pending.delete(r);
      let status: number | null = null;
      void r
        .response()
        .then((resp) => (status = resp?.status() ?? null))
        .catch(() => undefined)
        .finally(() => {
          this.recent.push({ url: e.url, resourceType: e.resourceType, method: e.method, durationMs: Date.now() - e.start, status, ...(failure ? { failure: failure.slice(0, 80) } : {}) });
          if (this.recent.length > 100) this.recent.shift();
        });
    };
    p.on('requestfinished', (r) => finish(r));
    p.on('requestfailed', (r) => finish(r, r.failure()?.errorText ?? 'failed'));
    p.on('close', () => {
      for (const [r, e] of this.pending) {
        if (e.page === p) this.pending.delete(r);
      }
    });
    await this.installDocumentGuard(p);
    let lastDocUrl = 'about:blank';
    p.on('framenavigated', (f) => {
      if (f !== p.mainFrame() || p !== this.page) return;
      const u = f.url().split('#')[0]!;
      if (u !== lastDocUrl) {
        lastDocUrl = u;
        this.refsValid = false;
      }
    });
    p.on('response', (r) => {
      try {
        if (r.request().isNavigationRequest() && r.frame() === p.mainFrame()) {
          this.lastMainStatus.set(p, r.status());
          this.lastMainResponse.set(p, { resp: r, at: Date.now() });
        }
      } catch {
        /* ignore */
      }
    });
    return p;
  }

  /**
   * Per-hop guard for document requests of a page (main frame and same-process
   * frames). Playwright's `context.route` sees only the FIRST request of a
   * redirect chain (it auto-continues redirect hops), but Chromium's Fetch
   * domain pauses EVERY hop at the request stage, before it is sent. Each hop
   * is checked against the full policy here (origin allowlist for the main
   * frame, address policy for all), so a disallowed redirect destination is
   * never contacted. Out-of-process frames and subresources are not seen by
   * this session; the policy proxy still applies the address policy to them.
   */
  private async installDocumentGuard(p: Page): Promise<void> {
    const cdp = await this.context!.newCDPSession(p);
    const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const mainFrameId = tree.frameTree.frame.id;
    cdp.on('Fetch.requestPaused', (e) => void this.onDocumentPaused(cdp, p, mainFrameId, e as unknown as PausedRequest));
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  }

  private async onDocumentPaused(cdp: CDPSession, p: Page, mainFrameId: string, e: PausedRequest): Promise<void> {
    let ok = false;
    try {
      const topLevel = e.frameId === mainFrameId;
      const r = await checkUrl(this.policy, e.request.url, { topLevelNavigation: topLevel, allowlistExemptUrl: this.exemptUrl });
      ok = r.ok;
      if (!r.ok) {
        const reason = e.redirectedRequestId ? `redirect blocked before it was sent: ${r.reason}` : r.reason;
        if (topLevel) this.navBlocks.set(p, { url: e.request.url, reason, at: Date.now() });
        this.noteBlocked(e.request.url, r.reason);
        log('request_blocked', { url: safeUrlForLog(e.request.url), topLevel, redirect: !!e.redirectedRequestId });
      }
    } catch {
      ok = false; // fail closed
    } finally {
      // Always answer the pause; an unanswered pause would hang the navigation.
      if (ok) await cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => undefined);
      else await cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
    }
  }

  private async onDialog(p: Page, d: Dialog): Promise<void> {
    const scope = this.dialogScope.get(p);
    const pol = scope?.policy ?? null;
    const type = d.type();
    const byPolicy =
      !!pol && pol.action === 'accept' && (!pol.types || pol.types.includes(type as never)) && (scope!.used < (pol.maxDialogs ?? 1));
    const handled: DialogRecord['handled'] = byPolicy ? 'accepted' : 'dismissed';
    if (byPolicy) scope!.used++;
    // Bounded: a dialog call that never settles must not hold the action.
    const act = byPolicy ? d.accept(type === 'prompt' ? pol!.promptText ?? '' : undefined) : d.dismiss();
    await Promise.race([act.catch(() => undefined), new Promise((r) => setTimeout(r, 5000).unref())]);
    // Logs: dialog type and outcome only (never the message or prompt text).
    log('dialog', { type, handled });
    scope?.records.push({ type, handled, byPolicy: !!pol, message: d.message().slice(0, 200) });
  }

  /** Run an action with its dialog policy installed; the policy is removed afterwards. */
  async withDialogs<T>(page: Page, policy: DialogPolicy | undefined, fn: () => Promise<T>): Promise<{ result: T; dialogs: DialogRecord[] }> {
    const scope = { policy: policy ?? null, used: 0, records: [] as DialogRecord[] };
    this.dialogScope.set(page, scope);
    try {
      const result = await fn();
      return { result, dialogs: scope.records };
    } finally {
      if (this.dialogScope.get(page) === scope) this.dialogScope.delete(page);
    }
  }

  /**
   * After a blocked navigation Chromium may still commit its error page a moment
   * later; leave the page on about:blank so later commands start clean.
   */
  async resetToBlank(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await page.goto('about:blank', { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(150).catch(() => undefined);
      if (page.url() === 'about:blank') break;
    }
    this.lastMainStatus.set(page, null);
  }

  /**
   * Called when a command overran its deadline while holding the command lock.
   * Closing the page makes any pending Playwright call on it reject (a hung
   * `evaluate`, a stuck click), so the operation stops touching the session.
   * Returns true once the operation has settled and a fresh blank page (same
   * context: cookies and storage kept) replaced the old one; false if it could
   * not be stopped in time (the caller then terminates the worker).
   */
  async recoverFromHang(op: Promise<unknown>, settleMs: number): Promise<boolean> {
    const old = this.page;
    this.refsValid = false;
    for (const h of this.handles.values()) void h.dispose().catch(() => undefined);
    this.handles.clear();
    const settled = op.then(
      () => true,
      () => true,
    );
    const timer = (ms: number) => new Promise<false>((r) => setTimeout(() => r(false), ms).unref());
    if (old) await Promise.race([old.close({ runBeforeUnload: false }).catch(() => undefined), timer(settleMs)]);
    const ok = await Promise.race([settled, timer(settleMs)]);
    if (!ok || !this.context) return false;
    try {
      this.page = await Promise.race([this.newTrackedPage(), timer(settleMs).then(() => null)]);
    } catch {
      this.page = null;
    }
    return this.page !== null;
  }

  private async checkEgress(page: Page): Promise<EgressReport> {
    const mode = this.input.proxy.mode;
    const enforcement = mode === 'direct' ? 'none(direct)' : 'browser_proxy_flag+ip_check';
    const url = this.input.egressCheckUrl;
    const notes: string[] = [];
    let directIp: string | null = null;
    let browserIp: string | null = null;
    let hostBlocked = false;
    // (1) Container's own direct IP (Node fetch, no proxy) - only to the
    // controlled diagnostic endpoint, and only if it passes the address policy.
    try {
      const u = new URL(url);
      const hc = await checkHost(this.policy, u.hostname, u.port ? Number(u.port) : defaultPort(u.protocol));
      if (!hc.ok) {
        hostBlocked = true;
        notes.push('egress check host blocked by policy');
      } else {
        const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
        directIp = parseClientIp(await r.text());
        if (!directIp) notes.push('direct check returned no clientIp');
      }
    } catch {
      notes.push('direct IP check failed');
    }
    // (2) Browser IP: navigate the browser itself to the echo endpoint. Skipped when the
    // endpoint is blocked by policy (the local provider disables the check this way): a
    // blocked navigation plus its about:blank reset could race the session's first goto.
    if (hostBlocked) {
      notes.push('browser check skipped');
    } else {
      try {
        const resp = await page.goto(url, { timeout: 30_000, waitUntil: 'load' });
        if (resp && resp.ok() && resp.headers()['x-rba-blocked'] !== '1') {
          browserIp = parseClientIp(await resp.text());
        }
        if (!browserIp) notes.push('browser check returned no clientIp');
      } catch {
        notes.push('browser could not reach egress check endpoint');
      }
      await page.goto('about:blank').catch(() => undefined);
    }
    let verified: boolean;
    if (mode === 'direct') {
      verified = browserIp !== null;
    } else {
      verified = browserIp !== null && directIp !== null && browserIp !== directIp;
      if (browserIp !== null && directIp !== null && browserIp === directIp) notes.push('browser IP equals direct container IP');
    }
    if (verified) notes.push(mode === 'direct' ? 'direct mode: no egress proxy' : 'browser egress differs from container IP');
    return { mode, browserIp, directIp, status: verified ? 'verified' : 'unverified', enforcement, note: notes.join('; ') };
  }

  // ------------------------------------------------------------------ helpers

  ensureReady(): Page {
    if (!this.initialized || !this.page) throw new WorkerFail('not_ready', 'session not initialised (call /session/init first)');
    return this.page;
  }

  async summary(page: Page): Promise<PageSummary> {
    const status = this.lastMainStatus.get(page) ?? null;
    const url = page.url();
    if (url === 'about:blank') return { url, title: '', status: null, blocked: null };
    const title = await page.title().catch(() => '');
    const { blocked, integrations } = await detectSignals(page, status);
    return { url, title, status, blocked, ...(integrations.length > 0 ? { integrations } : {}) };
  }

  /** Throw navigation_blocked/failed/timeout for a failed navigation. */
  navError(page: Page, e: unknown, t0: number): WorkerFail {
    const nb = this.navBlocks.get(page);
    if (nb && nb.at >= t0) return new WorkerFail('navigation_blocked', nb.reason);
    const msg = cleanMessage(e);
    const pb = this.proxy?.blocksSince(t0) ?? [];
    if (pb.length > 0 && /ERR_TUNNEL_CONNECTION_FAILED|ERR_BLOCKED|ERR_EMPTY_RESPONSE|ERR_CONNECTION/.test(msg)) {
      return new WorkerFail('navigation_blocked', pb[pb.length - 1]!.reason);
    }
    if (/ERR_BLOCKED_BY_CLIENT/.test(msg)) return new WorkerFail('navigation_blocked', 'blocked by network policy');
    if (isTimeout(e)) return new WorkerFail('timeout', msg);
    return new WorkerFail('navigation_failed', msg);
  }

  /** Redirect chain (first request .. final) of a main-frame response. */
  static chainOf(resp: Response | null): string[] {
    if (!resp) return [];
    const chain: string[] = [];
    let r: ReturnType<Response['request']> | null = resp.request();
    while (r) {
      chain.unshift(r.url());
      r = r.redirectedFrom();
    }
    return chain;
  }

  /**
   * Validate where a navigation actually ended up (every redirect hop and the
   * final URL). On violation, leave the page (about:blank) and throw.
   */
  async postNavCheck(page: Page, resp: Response | null, t0: number): Promise<string[]> {
    const chain = BrowserSession.chainOf(resp);
    const finalUrl = page.url();
    const pb = this.proxy?.blocksSince(t0) ?? [];
    let violation: string | null = null;
    if (finalUrl.startsWith('chrome-error:')) {
      violation = pb.length > 0 ? pb[pb.length - 1]!.reason : null;
      if (!violation) throw new WorkerFail('navigation_failed', 'navigation ended on an error page');
    }
    if (!violation && resp && resp.headers()['x-rba-blocked'] === '1') {
      violation = pb.length > 0 ? pb[pb.length - 1]!.reason : 'blocked by network policy';
    }
    if (!violation) {
      const toCheck = [...chain, ...(finalUrl !== 'about:blank' ? [finalUrl] : [])];
      for (const u of toCheck) {
        const r = await checkUrl(this.policy, u, { topLevelNavigation: true, allowlistExemptUrl: this.exemptUrl });
        if (!r.ok) {
          violation = `redirect/final URL violates policy: ${r.reason}`;
          break;
        }
      }
    }
    if (violation) {
      log('navigation_blocked_post', { url: safeUrlForLog(finalUrl) });
      await page.goto('about:blank').catch(() => undefined);
      this.lastMainStatus.set(page, null);
      throw new WorkerFail('navigation_blocked', violation);
    }
    return chain;
  }

  /**
   * Policy-checked navigation usable for any page of this context, in bounded
   * phases (see protocol `Readiness`): document (commit + DOMContentLoaded within
   * timeoutMs; required), then the optional readyWhen condition (required when
   * given) concurrently with a best-effort settle toward load/networkidle
   * (never fatal). Slow optional subresources are reported, not failed on.
   */
  async gotoChecked(
    page: Page,
    url: string,
    opts: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      timeoutMs?: number;
      settleMs?: number;
      readyWhen?: ReadyCondition;
      /** Callers with an overall budget: the settle phase never runs past this time. */
      deadlineAt?: number;
    },
  ): Promise<{ resp: Response | null; chain: string[]; readiness: Readiness }> {
    const pre = await checkUrl(this.policy, url, { topLevelNavigation: true });
    if (!pre.ok) throw new WorkerFail('navigation_blocked', pre.reason);
    const t0 = Date.now();
    this.navBlocks.delete(page);
    const docTimeout = clampTimeout(opts.timeoutMs);
    const settleBudget = settleBudgetMs(opts);
    const cond = opts.readyWhen;
    const times = this.watchLoadEvents(page, t0);
    const respWatch = cond?.response ? watchResponse(page, cond.response) : null;
    try {
      let resp: Response | null;
      try {
        resp = await page.goto(url, { waitUntil: 'commit', timeout: docTimeout });
      } catch (e) {
        const err = this.navError(page, e, t0);
        if (err.code === 'navigation_blocked') await this.resetToBlank(page);
        throw err.withReadiness(await this.readinessOf(page, t0, times, cond ? 'not_met' : 'none', 'timeout'));
      }
      if (resp) this.lastMainStatus.set(page, resp.status());
      const chain = await this.postNavCheck(page, resp, t0);
      let docState: Readiness["document"] = "ready";
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, t0 + docTimeout - Date.now()) });
      } catch {
        docState = "timeout";
      }
      if (docState === "timeout" && !cond) {
        const r = await this.readinessOf(page, t0, times, "none", docState);
        throw new WorkerFail(
          'timeout',
          `the response arrived but the document did not finish parsing (DOMContentLoaded) within ${docTimeout} ms; a parser-blocking script or stylesheet may be hanging (${describePending(r)})`,
        ).withReadiness(r);
      }
      // Settle (best effort) and condition (required) run concurrently.
      const settleMs = opts.deadlineAt !== undefined ? Math.min(settleBudget, Math.max(0, opts.deadlineAt - Date.now())) : settleBudget;
      const settle = settleMs > 0 ? page.waitForLoadState(opts.waitUntil === 'networkidle' ? 'networkidle' : 'load', { timeout: settleMs }).catch(() => undefined) : Promise.resolve();
      if (cond) {
        const missing = await this.waitCondition(page, cond, conditionBudgetMs(cond), respWatch);
        if (missing) {
          const r = await this.readinessOf(page, t0, times, "not_met", docState, missing);
          throw new WorkerFail('condition_not_met', `readiness condition not met: ${missing}. ${describeReadiness(r)}`).withReadiness(r);
        }
      }
      await settle;
      return { resp, chain, readiness: await this.readinessOf(page, t0, times, cond ? "met" : "none", docState) };
    } finally {
      times.dispose();
      respWatch?.dispose();
    }
  }

  /** DOMContentLoaded/load times of the next document of `page`. */
  private watchLoadEvents(page: Page, t0: number): { dcl: number | null; load: number | null; dispose(): void } {
    const t = { dcl: null as number | null, load: null as number | null, dispose: () => undefined as void };
    const onDcl = () => (t.dcl ??= Date.now() - t0);
    const onLoad = () => (t.load ??= Date.now() - t0);
    page.on('domcontentloaded', onDcl);
    page.on('load', onLoad);
    t.dispose = () => {
      page.off('domcontentloaded', onDcl);
      page.off('load', onLoad);
    };
    return t;
  }

  /**
   * Wait for every part of a readiness condition within `budgetMs`. Returns
   * null when met, otherwise a description of what was missing.
   */
  async waitCondition(page: Page, c: ReadyCondition, budgetMs: number, respWatch: ResponseWatch | null): Promise<string | null> {
    const end = Date.now() + budgetMs;
    const left = () => Math.max(1, end - Date.now());
    // Watch for the response from the start, so one arriving during the selector/text waits counts.
    const ownWatch = c.response !== undefined && !respWatch ? watchResponse(page, c.response) : null;
    try {
      return await this.waitConditionParts(page, c, budgetMs, left, respWatch ?? ownWatch);
    } finally {
      ownWatch?.dispose();
    }
  }

  private async waitConditionParts(page: Page, c: ReadyCondition, budgetMs: number, left: () => number, respWatch: ResponseWatch | null): Promise<string | null> {
    const fail = (e: unknown, what: string): never => {
      const m = cleanMessage(e);
      if (/selector|SyntaxError|Unexpected token|not a valid/i.test(m) && !isTimeout(e)) throw new WorkerFail('bad_request', `invalid readyWhen.${what}: ${m}`);
      throw new WorkerFail('action_failed', `readiness wait failed: ${m}`);
    };
    if (c.selector !== undefined) {
      try {
        await page.mainFrame().waitForSelector(c.selector, { state: 'attached', timeout: left() });
      } catch (e) {
        if (isTimeout(e)) return `no element matched selector ${JSON.stringify(c.selector)} within ${budgetMs} ms`;
        fail(e, 'selector');
      }
    }
    if (c.textContains !== undefined) {
      try {
        await page.mainFrame().waitForFunction((t) => (document.body?.innerText ?? '').toLowerCase().includes(t), c.textContains.toLowerCase(), { timeout: left(), polling: 250 });
      } catch (e) {
        if (isTimeout(e)) return `the page text did not contain ${JSON.stringify(c.textContains.slice(0, 80))} within ${budgetMs} ms`;
        fail(e, 'textContains');
      }
    }
    if (c.response !== undefined && respWatch) {
      const ok = await Promise.race([respWatch.promise.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), left()).unref())]);
      if (!ok) return `no response with URL containing ${JSON.stringify(c.response.urlContains.slice(0, 80))}${c.response.status !== undefined ? ` and status ${c.response.status}` : ''} arrived within ${budgetMs} ms`;
    }
    return null;
  }

  /** Requests of `page` still in flight (count and distinct hosts, capped). */
  pendingOf(page: Page): Readiness['pendingRequests'] {
    let count = 0;
    const hosts = new Set<string>();
    for (const e of this.pending.values()) {
      if (e.page !== page) continue;
      count++;
      try {
        if (hosts.size < 10) hosts.add(new URL(e.url).host);
      } catch {
        /* scrubbed / non-URL */
      }
    }
    return { count, hosts: [...hosts] };
  }

  async readinessOf(
    page: Page,
    t0: number,
    times: { dcl: number | null; load: number | null } | null,
    condition: Readiness['condition'],
    docState?: Readiness['document'],
    conditionDetail?: string,
  ): Promise<Readiness> {
    const state = await Promise.race([
      page.evaluate(() => document.readyState).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 1000).unref()),
    ]);
    const load: Readiness['load'] = state === 'complete' ? 'fired' : 'pending';
    return {
      document: docState ?? (state === 'interactive' || state === 'complete' ? 'ready' : 'timeout'),
      load,
      condition,
      ...(conditionDetail ? { conditionDetail } : {}),
      pendingRequests: this.pendingOf(page),
      documentMs: times?.dcl ?? null,
      loadMs: load === 'fired' ? (times?.load ?? null) : null,
      elapsedMs: Date.now() - t0,
    };
  }

  /** Wait for a readyWhen before a non-navigation command (extract, inspect). */
  async ensureCondition(page: Page, c: ReadyCondition | undefined): Promise<void> {
    if (!c) return;
    const t0 = Date.now();
    const missing = await this.waitCondition(page, c, conditionBudgetMs(c), null);
    if (missing) {
      const r = await this.readinessOf(page, t0, null, 'not_met', undefined, missing);
      throw new WorkerFail('condition_not_met', `readiness condition not met: ${missing}. ${describeReadiness(r)}`).withReadiness(r);
    }
  }

  // ------------------------------------------------------------------ commands

  async navigate(req: NavigateRequest): Promise<NavigateResponse> {
    const page = this.ensureReady();
    const { result, dialogs } = await this.withDialogs(page, req.dialog, () => this.gotoChecked(page, req.url, req));
    const rd = result.readiness;
    log('navigated', { url: safeUrlForLog(page.url()), status: this.lastMainStatus.get(page) ?? null, load: rd.load, pending: rd.pendingRequests.count, ms: rd.elapsedMs });
    return { page: await this.summary(page), redirectChain: result.chain, ...(dialogs.length ? { dialogs } : {}), readiness: rd };
  }

  async inspect(req: InspectRequest): Promise<InspectResponse> {
    const page = this.ensureReady();
    await this.ensureCondition(page, req.readyWhen);
    const max = Math.max(1, Math.min(req.maxElements ?? 150, 500));
    const maxText = Math.max(0, Math.min(req.maxTextChars ?? 4000, 100_000));
    for (const h of this.handles.values()) void h.dispose().catch(() => undefined);
    this.handles.clear();
    this.generation += 1;
    this.refsValid = true;
    const gen = this.generation;
    const frame = page.mainFrame();
    const listHandle = await frame.evaluateHandle(collectInteractive, max);
    const infos = await listHandle.evaluate(describeElements);
    const elsHandle = await listHandle.getProperty('els');
    const props = await elsHandle.getProperties();
    const total = (await listHandle.evaluate((o) => o.total)) as number;
    const elements: ElementInfo[] = [];
    for (let i = 0; i < infos.length; i++) {
      const h = props.get(String(i))?.asElement();
      if (!h) continue;
      const ref = `g${gen}:e${i + 1}`;
      this.handles.set(ref, h as ElementHandle);
      elements.push({ ref, ...infos[i]! });
    }
    await elsHandle.dispose().catch(() => undefined);
    await listHandle.dispose().catch(() => undefined);
    let text: string | null = null;
    if (req.includeText !== false) {
      text = await frame.evaluate((n) => (document.body?.innerText ?? '').slice(0, n), maxText).catch(() => null);
    }
    return { page: await this.summary(page), generation: gen, elements, truncated: total > max, text };
  }

  async resolveTarget(t: ElementTarget): Promise<ElementHandle> {
    const page = this.ensureReady();
    const hasRef = typeof t.ref === 'string';
    const hasSel = typeof t.selector === 'string';
    if (hasRef === hasSel) throw new WorkerFail('bad_request', 'exactly one of ref or selector is required');
    if (hasRef) {
      const m = /^g(\d+):e(\d+)$/.exec(t.ref!);
      if (!m) throw new WorkerFail('bad_request', 'malformed ref');
      if (Number(m[1]) !== this.generation || !this.refsValid) {
        throw new WorkerFail('stale_ref', `ref ${t.ref} is stale (page changed or a newer inspect exists); call inspect again and use the new refs`);
      }
      const h = this.handles.get(t.ref!);
      if (!h) throw new WorkerFail('element_not_found', `ref ${t.ref} does not exist in generation ${this.generation}`);
      let connected = false;
      try {
        connected = await h.evaluate((el) => el.isConnected);
      } catch {
        connected = false;
      }
      if (!connected) throw new WorkerFail('stale_ref', `ref ${t.ref} points to an element that is no longer in the page; call inspect again`);
      return h;
    }
    if (!t.selector || t.selector.length > 2000) throw new WorkerFail('bad_request', 'invalid selector');
    const loc = page.mainFrame().locator(t.selector);
    let n: number;
    try {
      n = await loc.count();
    } catch (e) {
      throw new WorkerFail('bad_request', `invalid selector: ${cleanMessage(e)}`);
    }
    if (n === 0) throw new WorkerFail('element_not_found', 'selector matched no element');
    if (n > 1) throw new WorkerFail('ambiguous_selector', `selector matched ${n} elements; use a more specific selector or a ref`);
    const h = await loc.elementHandle({ timeout: 5000 }).catch(() => null);
    if (!h) throw new WorkerFail('element_not_found', 'element disappeared');
    return h;
  }

  /** requireOrigins: both the main-frame origin and the element's frame origin must be listed. */
  private async checkRequiredOrigins(page: Page, h: ElementHandle, required: string[] | undefined): Promise<void> {
    if (required === undefined) return;
    const allowed = new Set(required.map((o) => normalizeOrigin(o)).filter((o): o is string => !!o && o !== '*'));
    const originOf = (u: string): string | null => {
      try {
        const o = new URL(u).origin;
        return o === 'null' ? null : o;
      } catch {
        return null;
      }
    };
    const mainOrigin = originOf(page.url());
    const frame = await h.ownerFrame();
    const frameOrigin = frame ? originOf(frame.url()) : null;
    if (!mainOrigin || !frameOrigin || !allowed.has(mainOrigin) || !allowed.has(frameOrigin)) {
      log('origin_requirement_failed', { mainOrigin: mainOrigin ?? 'none' });
      throw new WorkerFail('navigation_blocked', 'page origin not permitted for this secret');
    }
  }

  /**
   * Click-started navigation: the navigation must start and reach
   * DOMContentLoaded within `timeout`; then a best-effort settle toward load
   * (at most DEFAULT_SETTLE_MS, never fatal). Returns the readiness.
   */
  private async waitForNavOrBlock(page: Page, t0: number, timeout: number): Promise<Readiness> {
    const times = this.watchLoadEvents(page, t0);
    try {
      await this.waitForNavStart(page, t0, timeout);
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1000, t0 + timeout - Date.now()) });
      } catch (e) {
        const err = this.navError(page, e, t0);
        throw err.withReadiness(await this.readinessOf(page, t0, times, 'none', 'timeout'));
      }
      await page.waitForLoadState('load', { timeout: DEFAULT_SETTLE_MS }).catch(() => undefined);
      return await this.readinessOf(page, t0, times, 'none', 'ready');
    } finally {
      times.dispose();
    }
  }

  private async waitForNavStart(page: Page, t0: number, timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    const navP = page
      .waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout })
      .then(() => 'nav' as const)
      .catch(() => 'timeout' as const);
    let blocked = false;
    const poll = (async () => {
      while (Date.now() < deadline) {
        const nb = this.navBlocks.get(page);
        if (nb && nb.at >= t0) {
          blocked = true;
          return 'blocked' as const;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return 'timeout' as const;
    })();
    const which = await Promise.race([navP, poll]);
    if (which === 'blocked' || blocked) throw new WorkerFail('navigation_blocked', this.navBlocks.get(page)!.reason);
    if (which === 'timeout') {
      throw new WorkerFail('timeout', 'click did not start a navigation within the timeout');
    }
  }

  /** After an action that may have navigated: validate final URL/chain. */
  private async afterAction(page: Page, t0: number): Promise<void> {
    const nb = this.navBlocks.get(page);
    if (nb && nb.at >= t0) throw new WorkerFail('navigation_blocked', nb.reason);
    const lm = this.lastMainResponse.get(page);
    const resp = lm && lm.at >= t0 ? lm.resp : null;
    await this.postNavCheck(page, resp, t0);
  }

  async click(req: ClickRequest): Promise<{ page: PageSummary; dialogs?: DialogRecord[]; readiness?: Readiness }> {
    const page = this.ensureReady();
    const { result, dialogs } = await this.withDialogs(page, req.dialog, () => this.clickInner(page, req));
    return { page: result.page, ...(dialogs.length ? { dialogs } : {}), ...(result.readiness ? { readiness: result.readiness } : {}) };
  }

  private async clickInner(page: Page, req: ClickRequest): Promise<{ page: PageSummary; readiness: Readiness | null }> {
    const h = await this.resolveTarget(req);
    const timeout = clampTimeout(req.timeoutMs);
    const t0 = Date.now();
    this.navBlocks.delete(page);
    const navWait = req.waitForNavigation ? this.waitForNavOrBlock(page, t0, timeout) : null;
    navWait?.catch(() => undefined);
    try {
      await h.click({ timeout });
    } catch (e) {
      if (isTimeout(e)) throw new WorkerFail('timeout', cleanMessage(e));
      throw new WorkerFail('action_failed', cleanMessage(e));
    }
    let readiness: Readiness | null = null;
    try {
      if (navWait) readiness = await navWait;
      else await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => undefined);
      await this.afterAction(page, t0);
    } catch (e) {
      if (e instanceof WorkerFail && e.code === 'navigation_blocked') await this.resetToBlank(page);
      throw e;
    }
    return { page: await this.summary(page), readiness };
  }

  async fill(req: FillRequest): Promise<{ page: PageSummary }> {
    const page = this.ensureReady();
    const h = await this.resolveTarget(req);
    await this.checkRequiredOrigins(page, h, req.requireOrigins);
    try {
      await h.fill(req.value, { timeout: clampTimeout(req.timeoutMs) });
    } catch (e) {
      const msg = cleanMessage(e, [req.value]);
      if (isTimeout(e)) throw new WorkerFail('timeout', msg);
      throw new WorkerFail('action_failed', msg);
    }
    return { page: await this.summary(page) };
  }

  async select(req: SelectRequest): Promise<{ page: PageSummary }> {
    const page = this.ensureReady();
    const h = await this.resolveTarget(req);
    try {
      await h.selectOption(req.values, { timeout: DEFAULT_TIMEOUT_MS });
    } catch (e) {
      const msg = cleanMessage(e, req.values);
      if (isTimeout(e)) throw new WorkerFail('timeout', msg);
      throw new WorkerFail('action_failed', msg);
    }
    return { page: await this.summary(page) };
  }

  async upload(req: UploadRequest): Promise<UploadResponse> {
    const page = this.ensureReady();
    const max = this.input.maxUploadBytes;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(req.contentBase64)) throw new WorkerFail('bad_request', 'contentBase64 is not valid base64');
    if (Math.floor((req.contentBase64.length * 3) / 4) - 2 > max) throw new WorkerFail('upload_too_large', `file exceeds maxUploadBytes (${max})`);
    const buf = Buffer.from(req.contentBase64, 'base64');
    if (buf.length > max) throw new WorkerFail('upload_too_large', `file exceeds maxUploadBytes (${max})`);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (!/^[0-9a-fA-F]{64}$/.test(req.sha256) || sha !== req.sha256.toLowerCase()) {
      throw new WorkerFail('bad_request', 'sha256 does not match the decoded content');
    }
    const h = await this.resolveTarget(req);
    const isFile = await h.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file').catch(() => false);
    if (!isFile) throw new WorkerFail('bad_request', 'upload target must be an input[type=file]');
    await this.checkRequiredOrigins(page, h, req.requireOrigins);
    // In-memory payload instead of a temp file: Chromium reads a path-based
    // file lazily at form submission, so deleting a temp file right after
    // setInputFiles breaks the later submit (verified: navigation ends on an
    // error page). The worker's own code writes no copy of the payload to disk;
    // Chromium itself may still page large blobs into its temporary profile
    // directory, which is removed with the browser (not a guarantee after a crash).
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(req.mimeType) ? req.mimeType : 'application/octet-stream';
    try {
      await h.setInputFiles({ name: sanitizeFileName(req.fileName), mimeType, buffer: buf }, { timeout: DEFAULT_TIMEOUT_MS });
    } catch (e) {
      throw new WorkerFail(isTimeout(e) ? 'timeout' : 'action_failed', cleanMessage(e));
    }
    return { page: await this.summary(page), bytes: buf.length, sha256: sha };
  }

  async screenshot(req: ScreenshotRequest): Promise<ScreenshotResponse> {
    const page = this.ensureReady();
    const masks = ['input[type=password]', ...(req.maskSelectors ?? [])].map((s) => page.locator(s));
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (req.fullPage) {
      const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })).catch(() => null);
      if (dims && dims.h > MAX_SCREENSHOT_HEIGHT) clip = { x: 0, y: 0, width: Math.max(1, dims.w), height: MAX_SCREENSHOT_HEIGHT };
    }
    let png: Buffer;
    try {
      png = await page.screenshot({ type: 'png', fullPage: req.fullPage ?? false, mask: masks, clip, timeout: DEFAULT_TIMEOUT_MS });
    } catch (e) {
      throw new WorkerFail(isTimeout(e) ? 'timeout' : 'action_failed', cleanMessage(e));
    }
    return { page: await this.summary(page), pngBase64: png.toString('base64') };
  }

  async extract(req: ExtractRequest): Promise<ExtractResponse> {
    const page = this.ensureReady();
    await this.ensureCondition(page, req.readyWhen);
    try {
      const r = await extract(page, req.spec);
      return { page: await this.summary(page), ...r };
    } catch (e) {
      if (e instanceof ExtractSpecError) throw new WorkerFail('bad_request', e.message);
      throw new WorkerFail('action_failed', cleanMessage(e));
    }
  }

  async exportState(): Promise<{ storageState: StorageState }> {
    this.ensureReady();
    const s = await this.context!.storageState();
    return { storageState: s as unknown as StorageState };
  }

  private noteBlocked(url: string, reason: string): void {
    try {
      this.proxy?.noteBlocked(new URL(url).hostname, reason.replace(/https?:\/\/\S+/g, (m) => safeUrlForLog(m)));
    } catch {
      /* not a URL */
    }
  }

  diagnostics(): { connections: unknown[]; blockedHosts: unknown[]; pendingRequests: unknown[]; recentRequests: unknown[] } {
    const now = Date.now();
    const pendingRequests = [...this.pending.values()].sort((a, b) => a.start - b.start).slice(0, 50).map((e) => ({ url: e.url, resourceType: e.resourceType, method: e.method, ageMs: now - e.start }));
    return { ...(this.proxy?.diagnostics() ?? { connections: [], blockedHosts: [] }), pendingRequests, recentRequests: this.recent.slice(-60) };
  }

  async close(): Promise<void> {
    const b = this.browser;
    const c = this.context;
    this.browser = null;
    this.context = null;
    this.initialized = false;
    // Closing the context first finalizes a recorded video (if any) before the browser exits.
    if (c) await c.close().catch(() => undefined);
    if (b) await b.close().catch(() => undefined);
    const p = this.proxy;
    this.proxy = null;
    if (p) await p.close().catch(() => undefined);
  }
}

export interface ResponseWatch {
  promise: Promise<void>;
  dispose(): void;
}

/** Resolves when `page` receives a response matching the readyWhen.response spec. */
export function watchResponse(page: Page, spec: { urlContains: string; status?: number }): ResponseWatch {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  const on = (r: Response) => {
    if (r.url().includes(spec.urlContains) && (spec.status === undefined || r.status() === spec.status)) resolve();
  };
  page.on('response', on);
  return { promise, dispose: () => page.off('response', on) };
}

export function describePending(r: Readiness): string {
  const p = r.pendingRequests;
  return p.count === 0 ? 'no requests pending' : `${p.count} request(s) still pending${p.hosts.length ? ` on ${p.hosts.join(', ')}` : ''}`;
}

/** One-line summary for error messages. */
export function describeReadiness(r: Readiness): string {
  const doc = r.document === 'ready' ? `document ready${r.documentMs !== null ? ` after ${r.documentMs} ms` : ''}` : 'document not ready (DOMContentLoaded did not fire)';
  return `${doc}; load ${r.load === 'fired' ? 'fired' : 'not fired'}; ${describePending(r)}; ${r.elapsedMs} ms elapsed`;
}

export function parseClientIp(body: string): string | null {
  try {
    const j = JSON.parse(body) as { clientIp?: unknown };
    if (typeof j.clientIp === 'string' && net.isIP(j.clientIp)) return j.clientIp;
  } catch {
    /* not JSON */
  }
  return null;
}

export function sanitizeFileName(name: string): string {
  let n = String(name).replace(/[\\/\0]/g, '_');
  n = n.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!n || n === '.' || n === '..') n = 'upload.bin';
  if (n.startsWith('.')) n = `_${n.slice(1)}`;
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

// ---------------------------------------------------------------- in-page

interface Collected {
  els: Element[];
  total: number;
}

/** Fixed in-page function: interactive elements of the main frame. */
function collectInteractive(max: number): Collected {
  const SEL = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[role=button]',
    '[role=link]',
    '[role=checkbox]',
    '[role=tab]',
    '[role=menuitem]',
    '[role=textbox]',
    '[role=combobox]',
    '[contenteditable=true]',
    '[contenteditable=""]',
  ].join(',');
  const all = Array.from(document.querySelectorAll(SEL)).filter((e) => !(e instanceof HTMLInputElement && e.type === 'hidden'));
  return { els: all.slice(0, max), total: all.length };
}

type Info = Omit<ElementInfo, 'ref'>;

/** Fixed in-page function: describe elements. Never returns field values. */
function describeElements(o: Collected): Info[] {
  const uniq = (s: string): string | null => {
    try {
      return document.querySelectorAll(s).length === 1 ? s : null;
    } catch {
      return null;
    }
  };
  const clip = (s: string | null | undefined, n = 200): string | null => {
    if (s === null || s === undefined) return null;
    const t = s.trim().replace(/\s+/g, ' ');
    return t ? t.slice(0, n) : null;
  };
  return o.els.map((el) => {
    const tag = el.tagName.toLowerCase();
    const attr = (n: string) => el.getAttribute(n);
    const he = el as HTMLElement;
    let label: string | null = clip(attr('aria-label'));
    const labels = (el as HTMLInputElement).labels;
    if (!label && labels && labels.length > 0) label = clip(labels[0]!.innerText);
    if (!label) {
      const lb = attr('aria-labelledby');
      if (lb) label = clip(lb.split(/\s+/).map((i) => document.getElementById(i)?.innerText ?? '').join(' '));
    }
    const rect = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    const disabled = (el as HTMLButtonElement).disabled === true || attr('aria-disabled') === 'true';
    let hasValue: boolean | null = null;
    let text: string | null = null;
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') hasValue = el.checked;
      else if (el.type === 'file') hasValue = (el.files?.length ?? 0) > 0;
      else hasValue = el.value.length > 0;
      if (['submit', 'button', 'reset'].includes(el.type)) text = clip(el.value);
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      hasValue = el.value.length > 0;
    } else if (he.isContentEditable) {
      hasValue = (el.textContent ?? '').length > 0;
    } else {
      text = clip(he.innerText);
    }
    let selector: string | null = null;
    if (el.id) selector = uniq(`#${CSS.escape(el.id)}`);
    const name = attr('name');
    if (!selector && name) selector = uniq(`${tag}[name="${CSS.escape(name)}"]`);
    const tid = attr('data-testid');
    if (!selector && tid) selector = uniq(`[data-testid="${CSS.escape(tid)}"]`);
    return {
      tag,
      role: attr('role'),
      type: attr('type'),
      name,
      id: el.id || null,
      label,
      placeholder: attr('placeholder'),
      text,
      href: el instanceof HTMLAnchorElement ? el.href : null,
      selector,
      visible,
      disabled,
      hasValue,
    };
  });
}
