/**
 * Wire protocol between the local orchestrator (MCP server) and the remote
 * browser worker running inside an Apify Actor run.
 *
 * Mostly types; the only runtime values are the command-deadline constants and
 * `commandDeadlineMs`, shared so both sides agree on timeouts.
 *
 * Transport: HTTPS to the Actor run's container URL. Every request except
 * GET /health must carry `Authorization: Bearer <sessionToken>`. The worker
 * only knows sha256(sessionToken) (passed in the Actor input), so the token
 * itself is never stored on the provider.
 *
 * All request and response bodies are JSON. Errors are returned as
 * `{ ok: false, error: WorkerError }` with a non-2xx status.
 */

export type ProxyMode = 'direct' | 'datacenter' | 'residential';

/** Actor input. Stored by Apify in the run's key-value store: no secrets here. */
export interface WorkerInput {
  protocolVersion: 1;
  /** hex sha256 of the bearer token the orchestrator will use. */
  tokenHash: string;
  proxy: WorkerProxyInput;
  /** Shut down when no authenticated request arrives for this long. */
  idleTimeoutSecs: number;
  /** Hard cap on worker lifetime (also enforced by the Apify run timeout). */
  maxLifetimeSecs: number;
  network: WorkerNetworkPolicy;
  /** URL of an IP echo endpoint returning JSON with a `clientIp` field. */
  egressCheckUrl: string;
  /** Max bytes accepted for a single upload. */
  maxUploadBytes: number;
}

export interface WorkerProxyInput {
  mode: ProxyMode;
  /** ISO country code for proxy exit (Apify `countryCode`). */
  country?: string;
  /**
   * Sticky proxy session key (Apify proxy `session`). Providers try to keep the
   * same exit IP for a session key but do not guarantee it.
   */
  sessionKey?: string;
}

export interface WorkerNetworkPolicy {
  /**
   * Origins allowed for top-level (main frame) navigations. `["*"]` means any
   * public origin (only when explicitly configured).
   */
  allowedNavigationOrigins: string[];
  /**
   * Additional origins the page may load resources from: iframes, scripts,
   * images, fetch/XHR, WebSockets, workers, beacons, and every redirect hop of
   * those. Navigation origins are always allowed as resource origins too.
   * Entries: exact origins, `https://*.example.com` (that host's subdomains,
   * same scheme), or `*` (any public origin; only when explicitly configured).
   * Missing = [] (strict: page resources only from navigation origins).
   */
  allowedSubresourceOrigins?: string[];
  /**
   * Explicitly authorised private hosts (host or host:port), e.g. a private
   * test environment. Empty in normal operation.
   */
  allowPrivateHosts: string[];
}

export type WorkerErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'not_ready'
  | 'navigation_blocked'
  | 'navigation_failed'
  | 'stale_ref'
  | 'element_not_found'
  | 'ambiguous_selector'
  | 'action_failed'
  | 'timeout'
  | 'upload_too_large'
  | 'proxy_unavailable'
  | 'egress_unverified'
  | 'condition_not_met'
  | 'busy'
  | 'shutting_down'
  | 'internal';

export interface WorkerError {
  code: WorkerErrorCode;
  message: string;
  /**
   * Set on `timeout` errors from the command deadline: what the worker did about
   * the operation that overran. `page_reset`: the page was closed (cancelling the
   * operation) and replaced with a blank page in the same context (cookies kept);
   * `terminated`: the operation could not be stopped, so the worker is shutting
   * down. In both cases the operation has stopped mutating the session.
   */
  recovery?: 'page_reset' | 'terminated';
  /** Set on navigation/condition failures: how far the page got (see Readiness). */
  readiness?: Readiness;
}

export type WorkerResponse<T> = ({ ok: true } & T) | { ok: false; error: WorkerError };

/**
 * The page asks for human verification or blocks access: stop and report.
 * category `challenge_required`: a visible CAPTCHA/challenge or verification
 * page (kinds captcha, human_verification, interactive_login_challenge);
 * `access_denied`: the site refused the request (access_denied = HTTP 403,
 * rate_limited = HTTP 429). A 403 says nothing about WHY it was refused.
 */
export interface BlockSignal {
  kind: 'captcha' | 'human_verification' | 'access_denied' | 'rate_limited' | 'interactive_login_challenge';
  category: 'challenge_required' | 'access_denied';
  detail: string;
}

/**
 * Informational only: the page includes a CAPTCHA/anti-bot vendor (script,
 * hidden badge, invisible widget) but shows no challenge. Never a block, never
 * a reason to quarantine an account.
 */
export interface IntegrationSignal {
  vendor: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'cloudflare';
  evidence: string;
}

export interface PageSummary {
  url: string;
  title: string;
  status: number | null;
  blocked: BlockSignal | null;
  integrations?: IntegrationSignal[];
}

/** Upper bound for a browser command's Playwright timeout (ms). */
export const MAX_COMMAND_TIMEOUT_MS = 300_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Extra time over the command's own timeout before the worker cancels it. */
export const COMMAND_DEADLINE_MARGIN_MS = 20_000;
/** Time the worker may spend recovering after a deadline (page close + settle). */
export const COMMAND_RECOVERY_MS = 15_000;

/**
 * Navigation readiness (POST /navigate, and click with waitForNavigation).
 *
 * A navigation has up to three bounded phases, and only the first two can fail:
 *  1. document: the main-frame response commits and DOMContentLoaded fires within
 *     `timeoutMs` (default 30 s). Commit not reached = navigation error/timeout.
 *     DOMContentLoaded not reached = `timeout`, unless a `readyWhen` condition is
 *     given and is met anyway (then `document: 'timeout'` is reported, not fatal).
 *  2. condition (`readyWhen`, optional): the task's own readiness signal, checked
 *     after the document phase within `readyWhen.timeoutMs` (default 15 s). Not met
 *     = `condition_not_met` (a clear failure naming what was missing).
 *  3. settle (best effort, never fails): wait toward the `load` event (or
 *     network idle) for at most `settleMs`, concurrently with phase 2. Slow or
 *     hanging optional subresources (images, async scripts, trackers) only show up
 *     as `load: 'pending'` and `pendingRequests`.
 *
 * `waitUntil` keeps its name but now selects the settle target, not a failure
 * condition: 'load' (default) and 'networkidle' settle toward that state for up
 * to `settleMs` (default 10 s; 0 when only `readyWhen` is given without an
 * explicit waitUntil); 'domcontentloaded' does not settle.
 */
export interface ReadyCondition {
  /** CSS selector of an element that must be attached to the DOM (main frame; it may be hidden). */
  selector?: string;
  /** Text that must appear in the page's visible text (document.body.innerText), case-insensitive. */
  textContains?: string;
  /** A response of this page (document or subresource) whose URL contains this (and, if given, has this status) must arrive. */
  response?: { urlContains: string; status?: number };
  /** Condition deadline, from the end of the document phase. Default 15 s, max 120 s. */
  timeoutMs?: number;
}

export interface Readiness {
  /** DOMContentLoaded fired within the document deadline. */
  document: 'ready' | 'timeout';
  /** The load event had fired when the command returned. */
  load: 'fired' | 'pending';
  /** The readyWhen condition (none if no condition was given). */
  condition: 'met' | 'not_met' | 'none';
  /** What was missing, when condition = not_met. */
  conditionDetail?: string;
  /** Requests of this page still in flight when the command returned (typically slow optional resources). */
  pendingRequests: { count: number; hosts: string[] };
  /** Time from navigation start to DOMContentLoaded (null if it did not fire). */
  documentMs: number | null;
  /** Time from navigation start to the load event (null if it had not fired). */
  loadMs: number | null;
  elapsedMs: number;
}

export const DEFAULT_SETTLE_MS = 10_000;
export const MAX_SETTLE_MS = 60_000;
export const DEFAULT_CONDITION_TIMEOUT_MS = 15_000;
export const MAX_CONDITION_TIMEOUT_MS = 120_000;

function clampMs(t: unknown, dflt: number, max: number, min = 0): number {
  return typeof t === 'number' && Number.isFinite(t) ? Math.max(min, Math.min(max, t)) : dflt;
}

/** Condition deadline of a readyWhen (0 when there is none). */
export function conditionBudgetMs(readyWhen: unknown): number {
  if (readyWhen === undefined || readyWhen === null || typeof readyWhen !== 'object') return 0;
  return clampMs((readyWhen as { timeoutMs?: unknown }).timeoutMs, DEFAULT_CONDITION_TIMEOUT_MS, MAX_CONDITION_TIMEOUT_MS, 100);
}

/** Settle budget of a navigation request (see Readiness). */
export function settleBudgetMs(body: { waitUntil?: unknown; settleMs?: unknown; readyWhen?: unknown } | null | undefined): number {
  const wu = body?.waitUntil;
  if (wu === 'domcontentloaded') return 0;
  const dflt = wu === undefined && body?.readyWhen ? 0 : DEFAULT_SETTLE_MS;
  return clampMs(body?.settleMs, dflt, MAX_SETTLE_MS);
}

/**
 * Worker-side deadline for one command: the command's own (clamped) timeout
 * plus a margin. Clients should wait at least `commandDeadlineMs + COMMAND_RECOVERY_MS`
 * plus network slack so they receive the worker's structured `timeout` error.
 * /navigate also gets max(condition, settle) budget (they run concurrently);
 * any other command with a `readyWhen` gets its condition budget; a click that
 * waits for navigation gets the default settle budget.
 */
export function commandDeadlineMs(route: string, body: unknown): number {
  if (route === '/session/init') return 150_000;
  const b = (body ?? null) as { timeoutMs?: unknown; readyWhen?: unknown; waitForNavigation?: unknown; waitUntil?: unknown; settleMs?: unknown } | null;
  const own = clampMs(b?.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, 100);
  let extra = conditionBudgetMs(b?.readyWhen);
  if (route === '/navigate') extra = Math.max(extra, settleBudgetMs(b));
  if (route === '/click' && b?.waitForNavigation === true) extra = Math.max(extra, DEFAULT_SETTLE_MS);
  return own + extra + COMMAND_DEADLINE_MARGIN_MS;
}

/** POST /session/init — must be called once before any other browser command. */
export interface InitRequest {
  /** Playwright storageState JSON (cookies + localStorage), sent over TLS only. */
  storageState?: StorageState;
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
}

export interface EgressReport {
  mode: ProxyMode;
  /** IP observed by the echo endpoint for traffic from the browser. */
  browserIp: string | null;
  /** IP observed for the worker container's own direct traffic. */
  directIp: string | null;
  /**
   * verified: echo endpoint saw a browser IP and (for proxy modes) it differs
   *   from the container's direct IP.
   * unverified: the check could not be completed (session refuses to run in
   *   proxy modes).
   */
  status: 'verified' | 'unverified';
  enforcement: 'browser_proxy_flag+ip_check' | 'none(direct)';
  note: string;
}

export interface InitResponse {
  egress: EgressReport;
  browserVersion: string;
}

/**
 * Action-scoped dialog policy (alert/confirm/prompt/beforeunload). Installed
 * just before the action, removed right after it. Without one, every dialog
 * is dismissed. Never applies to dialogs outside the action's window.
 */
export interface DialogPolicy {
  action: 'accept' | 'dismiss';
  /** Only handle these dialog types with `action`; others are dismissed. Default: all. */
  types?: Array<'alert' | 'confirm' | 'prompt' | 'beforeunload'>;
  /** Text typed into a prompt when accepting. Never logged or echoed back. */
  promptText?: string;
  /** Max dialogs handled with `action` (default 1); later ones are dismissed. */
  maxDialogs?: number;
}

/** What happened to a dialog during an action. `message` is page content (untrusted), clipped. */
export interface DialogRecord {
  type: string;
  handled: 'accepted' | 'dismissed';
  byPolicy: boolean;
  message: string;
}

export interface NavigateRequest {
  url: string;
  /** Settle target after the document is ready (see Readiness); never a failure condition. */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** Document deadline (commit + DOMContentLoaded), default 30 s. */
  timeoutMs?: number;
  /** Max best-effort wait toward waitUntil after the document is ready (capability 'readiness'). */
  settleMs?: number;
  /** Task-specific readiness condition; not met = condition_not_met (capability 'readiness'). */
  readyWhen?: ReadyCondition;
  dialog?: DialogPolicy;
}
export interface NavigateResponse {
  page: PageSummary;
  /** Every hop of the main-frame redirect chain, in order. */
  redirectChain: string[];
  dialogs?: DialogRecord[];
  /** Absent on worker builds without capability 'readiness'. */
  readiness?: Readiness;
}

export interface InspectRequest {
  /** Wait for this condition before inspecting; not met = condition_not_met (capability 'readiness'). */
  readyWhen?: ReadyCondition;
  maxElements?: number;
  includeText?: boolean;
  maxTextChars?: number;
  /** Only sets the command deadline (timeoutMs + margin); default 30 s. */
  timeoutMs?: number;
}

export interface ElementInfo {
  /** Opaque reference, valid until the next inspect or navigation: `g<gen>:e<n>`. */
  ref: string;
  tag: string;
  role: string | null;
  type: string | null;
  name: string | null;
  id: string | null;
  label: string | null;
  placeholder: string | null;
  text: string | null;
  href: string | null;
  /** A best-effort CSS selector that matched exactly one element at inspect time. */
  selector: string | null;
  visible: boolean;
  disabled: boolean;
  /** Whether a form field currently holds a value (values are never returned). */
  hasValue: boolean | null;
}

export interface InspectResponse {
  page: PageSummary;
  generation: number;
  elements: ElementInfo[];
  truncated: boolean;
  /** Visible page text (untrusted content). */
  text: string | null;
}

/** Target an element by a ref from the latest inspect, or a CSS selector. */
export interface ElementTarget {
  ref?: string;
  selector?: string;
}

export interface ClickRequest extends ElementTarget {
  timeoutMs?: number;
  /** Wait for a main-frame navigation started by the click. */
  waitForNavigation?: boolean;
  dialog?: DialogPolicy;
}
export interface ClickResponse {
  page: PageSummary;
  dialogs?: DialogRecord[];
  /** With waitForNavigation, on builds with capability 'readiness': how far the new page got. */
  readiness?: Readiness;
}

export interface FillRequest extends ElementTarget {
  /** Plaintext value. The orchestrator resolves secret refs before sending. */
  value: string;
  timeoutMs?: number;
  /**
   * If set, the worker fills only when both the page's main-frame origin and
   * the element's frame origin are in this list (checked atomically inside
   * the command); otherwise `navigation_blocked`. Used for secrets.
   */
  requireOrigins?: string[];
}
export interface FillResponse {
  page: PageSummary;
}

export interface SelectRequest extends ElementTarget {
  values: string[];
}

export interface UploadRequest extends ElementTarget {
  fileName: string;
  mimeType: string;
  /** base64 file content. */
  contentBase64: string;
  /** hex sha256 of the decoded bytes, checked by the worker. */
  sha256: string;
  /** Same semantics as FillRequest.requireOrigins. */
  requireOrigins?: string[];
}
export interface UploadResponse {
  page: PageSummary;
  bytes: number;
  sha256: string;
}

export interface ScreenshotRequest {
  fullPage?: boolean;
  /** Extra selectors to mask; password fields are always masked. */
  maskSelectors?: string[];
}
export interface ScreenshotResponse {
  page: PageSummary;
  pngBase64: string;
}

/** Declarative extraction: no arbitrary code. */
export interface FieldSpec {
  selector: string;
  /** 'text' (default), 'html', or an attribute name such as 'href'. */
  attr?: string;
  all?: boolean;
}
export interface ExtractSpec {
  /** If set, each match is one item and field selectors are relative to it. */
  itemSelector?: string;
  fields: Record<string, FieldSpec>;
  maxItems?: number;
}
export interface ExtractRequest {
  spec: ExtractSpec;
  /** Wait for this condition before extracting; not met = condition_not_met (capability 'readiness'). */
  readyWhen?: ReadyCondition;
  /** Only sets the command deadline (timeoutMs + margin); default 30 s. */
  timeoutMs?: number;
}
export interface ExtractResponse {
  page: PageSummary;
  items: Array<Record<string, string | string[] | null>>;
  truncated: boolean;
}

export interface CrawlRequest {
  startUrls: string[];
  /** Only enqueue links whose origin is in this list (subset of navigation policy). */
  sameOriginOnly: boolean;
  /** Simple glob patterns (`*` wildcard) matched against full URLs. Empty = all. */
  includeGlobs: string[];
  excludeGlobs: string[];
  maxPages: number;
  maxDepth: number;
  /** Delay between page loads, politeness. */
  delayMs: number;
  pageTimeoutMs: number;
  maxRetriesPerPage: number;
  extract?: ExtractSpec;
  /**
   * Whole-crawl deadline (ms from start). When reached, in-flight work is
   * cancelled (crawl page closed) and the crawl ends in state `deadline`.
   * Each page also has a deadline of (maxRetriesPerPage + 1) x pageTimeoutMs + 20 s
   * covering navigation, extraction and link collection.
   */
  maxDurationMs?: number;
}

export interface CrawlPageResult {
  url: string;
  depth: number;
  status: number | null;
  title: string;
  items: Array<Record<string, string | string[] | null>>;
  error: string | null;
}

export interface CrawlStatusResponse {
  state: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed' | 'blocked' | 'deadline';
  pagesDone: number;
  pagesFailed: number;
  queued: number;
  blocked: BlockSignal | null;
  error: string | null;
  /** Number of results available via GET /crawl/results. */
  resultsAvailable: number;
}

export interface CrawlResultsResponse {
  results: CrawlPageResult[];
  nextOffset: number;
}

export interface StorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface StateExportResponse {
  storageState: StorageState;
}

export interface HealthResponse {
  ready: boolean;
  initialized: boolean;
  protocolVersion: 1;
  /**
   * Optional routes this build supports (absent on builds before they were
   * added). The orchestrator refuses a feature whose capability is missing
   * instead of calling an unknown route.
   */
  capabilities?: WorkerCapability[];
}

export type WorkerCapability = 'fetch' | 'capture' | 'readiness';
export const WORKER_CAPABILITIES: WorkerCapability[] = ['fetch', 'capture', 'readiness'];

/** Limits of POST /fetch and POST /capture (both sides use them). */
export const FETCH_MAX_REDIRECTS = 5;
export const FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_REQUEST_BODY_BYTES = 256 * 1024;
export const CAPTURE_MAX_STEPS = 10;
export const CAPTURE_MAX_WAIT_MS = 10_000;
export const CAPTURE_MAX_EXCHANGES = 200;
export const CAPTURE_MAX_BODY_BYTES = 512 * 1024;

/**
 * POST /fetch: one HTTP request made by the worker from the session's browser
 * context (Playwright `context.request`): the context's cookies are sent and
 * Set-Cookie updates them, and the connection goes through the same policy
 * proxy (and upstream proxy, if any) as the browser. Every redirect hop is
 * checked against the resource policy BEFORE it is requested; redirects are
 * followed by the worker, at most `maxRedirects`.
 * The caller never sends a Cookie header (refused): cookies come from the
 * context only.
 */
export interface FetchRequest {
  method: 'GET' | 'HEAD' | 'POST';
  url: string;
  /** Lower-case names. cookie, host, content-length, connection, proxy-*, transfer-encoding, upgrade, te, trailer, keep-alive, expect are refused. */
  headers?: Record<string, string>;
  /** UTF-8 request body (POST only), at most FETCH_MAX_REQUEST_BODY_BYTES. */
  body?: string;
  /** 0..FETCH_MAX_REDIRECTS, default FETCH_MAX_REDIRECTS. */
  maxRedirects?: number;
  /** Response bytes kept (default and max FETCH_MAX_RESPONSE_BYTES); the rest is dropped and `truncated` set. */
  maxResponseBytes?: number;
  /**
   * Follow a redirect to another origin (default false: such a hop is refused,
   * `navigation_blocked`, and nothing is sent there). When true, `authorization`
   * and every header in `sensitiveHeaders` are dropped before the cross-origin hop.
   */
  allowCrossOriginRedirects?: boolean;
  /** Lower-case names of headers that carry session values (dropped on a cross-origin hop). */
  sensitiveHeaders?: string[];
  timeoutMs?: number;
}

export interface FetchResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  /** Every requested URL in order (first .. final). */
  redirectChain: string[];
  contentType: string;
  /** Only: content-type, content-length, retry-after, location, www-authenticate. */
  headers: Record<string, string>;
  /** Response body as UTF-8 text (untrusted). */
  body: string;
  bytes: number;
  truncated: boolean;
  /** 403 -> access_denied, 429 -> rate_limited; never solved. */
  blocked: BlockSignal | null;
}

/** One step that makes the page fire its own request (no arbitrary code). */
export interface CaptureStep {
  action: 'goto' | 'click' | 'fill' | 'press' | 'wait';
  selector?: string;
  /** goto: URL; fill: text; press: key name (e.g. "Enter"). */
  value?: string;
  /** wait: milliseconds (<= CAPTURE_MAX_WAIT_MS). */
  ms?: number;
}

/**
 * POST /capture: navigate the interactive page to `url` (policy-checked like
 * /navigate), run `steps`, wait `waitMs`, and return the document/xhr/fetch
 * exchanges the page made meanwhile, with bounded bodies. Request headers are
 * returned as the browser sent them (including Cookie): the orchestrator turns
 * them into references and never stores them in an operation.
 */
export interface CaptureRequest {
  url: string;
  steps?: CaptureStep[];
  /** Settle time after the last step, default 1500, max CAPTURE_MAX_WAIT_MS. */
  waitMs?: number;
  maxExchanges?: number;
  maxBodyBytes?: number;
  timeoutMs?: number;
}

export interface CapturedExchange {
  id: number;
  resourceType: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  response?: { status: number; headers: Record<string, string>; body?: string; contentType: string };
  /** Body was cut at maxBodyBytes. */
  truncated?: boolean;
}

export interface CaptureResponse {
  page: PageSummary;
  finalUrl: string;
  /** Main-frame URLs the page had during the capture, in order. */
  locations: string[];
  exchanges: CapturedExchange[];
  /** localStorage + sessionStorage of the final page's origin (untrusted, bounded). */
  storage: Record<string, string>;
  /** More exchanges happened than maxExchanges. */
  truncated: boolean;
}

export interface StatusResponse {
  page: PageSummary | null;
  uptimeSecs: number;
  idleSecs: number;
  egress: EgressReport | null;
}

/**
 * Routes (all POST unless noted):
 *   GET  /health                 (no auth)
 *   GET  /status
 *   POST /session/init           InitRequest            -> InitResponse
 *   POST /navigate               NavigateRequest        -> NavigateResponse
 *   POST /inspect                InspectRequest         -> InspectResponse
 *   POST /click                  ClickRequest           -> ClickResponse
 *   POST /fill                   FillRequest            -> FillResponse
 *   POST /select                 SelectRequest          -> FillResponse
 *   POST /upload                 UploadRequest          -> UploadResponse
 *   POST /screenshot             ScreenshotRequest      -> ScreenshotResponse
 *   POST /extract                ExtractRequest         -> ExtractResponse
 *   POST /state/export           {}                     -> StateExportResponse
 *   POST /fetch                  FetchRequest           -> FetchResponse      (capability 'fetch')
 *   POST /capture                CaptureRequest         -> CaptureResponse    (capability 'capture')
 *   POST /crawl/start            CrawlRequest           -> CrawlStatusResponse
 *   GET  /crawl/status                                  -> CrawlStatusResponse
 *   GET  /crawl/results?offset=N&limit=M                -> CrawlResultsResponse
 *   POST /crawl/cancel           {}                     -> CrawlStatusResponse
 *   POST /shutdown               {}                     -> {}
 */
export type WorkerRoute =
  | '/health'
  | '/status'
  | '/session/init'
  | '/navigate'
  | '/inspect'
  | '/click'
  | '/fill'
  | '/select'
  | '/upload'
  | '/screenshot'
  | '/extract'
  | '/fetch'
  | '/capture'
  | '/state/export'
  | '/crawl/start'
  | '/crawl/status'
  | '/crawl/results'
  | '/crawl/cancel'
  | '/diagnostics'
  | '/shutdown';

/**
 * GET /diagnostics: recent connections through the worker's policy proxy.
 * Host/port, outcome and timings only: no paths, query strings, headers or bodies.
 */
export interface ConnectionRecord {
  host: string;
  port: number;
  kind: 'connect' | 'http';
  outcome: 'open' | 'closed' | 'blocked' | 'error';
  reason?: string;
  /** Time from proxy receiving the request to the policy decision. */
  policyMs?: number;
  /** Time until the upstream TCP connection (or upstream proxy tunnel) was established. */
  connectMs?: number;
  /** Time until the first byte came back from the destination. */
  firstByteMs?: number;
  durationMs?: number;
  bytesUp: number;
  bytesDown: number;
  error?: string;
  at: string;
}
/** A browser request of the interactive page (URL without query/fragment, token-like path segments scrubbed). */
export interface RequestRecord {
  url: string;
  resourceType: string;
  method: string;
  ageMs?: number;
  durationMs?: number;
  status?: number | null;
  failure?: string;
}
export interface DiagnosticsResponse {
  connections: ConnectionRecord[];
  /** Requests of the interactive page still in flight, oldest first. */
  pendingRequests?: RequestRecord[];
  /** Most recent finished or failed requests of the interactive page. */
  recentRequests?: RequestRecord[];
  /** Hosts refused by the resource policy, with counts (to decide what a site needs). */
  blockedHosts: Array<{ host: string; count: number; reason: string }>;
}
