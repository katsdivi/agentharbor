/**
 * Saved READ operations: learn from the page's own traffic, review, call, validate, repair.
 *
 * Invariant: this process never sends a request to a target site. Every
 * request of an operation (replay, browser fallback, repair captures, redirect
 * hops) is made by the session's worker (`/fetch`, `/capture`), in the
 * session's execution mode, through its network policy and proxy. A session
 * is started with `ctx.sessions.start` (route resolution, account lease,
 * encrypted account state) or an existing one is used; there is no second
 * account or cookie store. An operation is scoped to one account (or public)
 * and runs only in a session of that same account (or an account-less one).
 */
import type {
  CaptureRequest,
  CaptureResponse,
  FetchRequest,
  FetchResponse,
  HealthResponse,
  StateExportResponse,
  StorageState,
  WorkerRoute,
} from '../../actor/src/protocol.js';
import type { Ctx } from '../core/context.js';
import { RbaError } from '../core/errors.js';
import { resolveRoute, type ExecutionMode, type ProxyKind } from '../core/modes.js';
import { registerSecret } from '../core/redact.js';
import { WorkerClient } from '../providers/worker-client.js';
import { resolveToolRoute } from '../mcp/tools/shared.js';
import { judge, type Judged } from '../vendor/api-anything/classify.js';
import { asText, fillTemplate } from '../vendor/api-anything/codec.js';
import { capOutput, inferShape } from '../vendor/api-anything/extract.js';
import { learnOperation, matches } from '../vendor/api-anything/learn.js';
import { scanSecrets } from '../vendor/api-anything/secrets.js';
import { OperationSchema, ResponseSchema, type Match, type Operation, type Trigger } from '../vendor/api-anything/spec.js';
import type { Exchange, StoredCookie } from '../vendor/api-anything/types.js';
import { InputError, MissingRefError, buildRequest, carriesArgs, checkArgs, refsOf, sensitiveHeaders } from './request.js';
import {
  ACCOUNT_REF,
  KnownValues,
  findPrivate,
  registerSecrets,
  constantRefs,
  describeFindings,
  knownPrivateValues,
  privatizeAccountOperation,
  redactPrivate,
  redactPrivateDeep,
  sanitizeShape,
  scanStored,
} from './privacy.js';
import { refusal, reviewSummary } from './review.js';
import {
  LIMITS,
  OperationStore,
  exampleLeaks,
  stripExamples,
  type Args,
  type BoundRoute,
  type OperationPrivate,
  type OperationRow,
  type SpecEnvelope,
} from './store.js';

export interface RouteArgs {
  mode?: ExecutionMode;
  proxy?: { kind: ProxyKind; country?: string };
  proxyMode?: 'direct' | 'datacenter' | 'residential';
  country?: string;
}

const stores = new WeakMap<Ctx, OperationStore>();

export function opStore(ctx: Ctx): OperationStore {
  let s = stores.get(ctx);
  if (!s) {
    s = new OperationStore(ctx.db, ctx.vault);
    stores.set(ctx, s);
  }
  return s;
}

export function requireEnabled(ctx: Ctx): void {
  if (!ctx.cfg.operations.enabled) {
    throw new RbaError('config_missing', 'saved operations are disabled. Set RBA_OPERATIONS_ENABLED=true in .env to enable them (all other tools work without it).');
  }
  if (!ctx.vault.available) throw new RbaError('config_missing', 'RBA_ENCRYPTION_KEY missing; saved operations store private data encrypted');
}

// ------------------------------------------------------------------ sessions

const CAPS = new Map<string, Set<string>>();

async function requireCapabilities(ctx: Ctx, sessionId: string): Promise<void> {
  if (CAPS.get(sessionId)?.has('fetch')) return;
  const h = await ctx.sessions.get(sessionId).client.call<HealthResponse>('/health', undefined, { timeoutMs: 15_000 });
  const caps = new Set(h.capabilities ?? []);
  CAPS.set(sessionId, caps);
  if (!caps.has('fetch') || !caps.has('capture')) {
    throw new RbaError('config_missing', 'this browser worker build has no /fetch and /capture routes (saved operations). Redeploy the worker (npm run deploy-actor) and start a new session.');
  }
}

async function workerCall<T>(ctx: Ctx, sessionId: string, route: WorkerRoute, body: unknown): Promise<T> {
  return ctx.sessions.call<T & { page?: never }>(sessionId, route, body, { timeoutMs: WorkerClient.clientTimeoutMs(route, body) });
}

interface SessionUse {
  sessionId: string;
  mode: ExecutionMode;
  temporary: boolean;
}

/**
 * Run `fn` in a session of the operation's scope: the given session (checked),
 * or a temporary one started with the resolved route and closed afterwards.
 * Account state is saved back to the vault only when `fn` reports success.
 */
async function withSession<T>(
  ctx: Ctx,
  accountId: string | null,
  a: RouteArgs & { sessionId?: string },
  fn: (use: SessionUse) => Promise<{ value: T; ok: boolean }>,
  bound: BoundRoute | null = null,
): Promise<{ value: T; use: SessionUse }> {
  const checkBound = (what: string, mode: ExecutionMode, proxyKind: string | null) => {
    if (!bound) return;
    if (mode !== bound.mode || (bound.mode === 'remote_proxy' && bound.proxyKind && proxyKind !== bound.proxyKind)) {
      throw new RbaError(
        'forbidden',
        `${what} runs in ${mode}${proxyKind ? ` (${proxyKind} proxy)` : ''}, but this account operation is bound to ${bound.mode}${bound.proxyKind ? ` (${bound.proxyKind} proxy)` : ''}, the route it was learned in. Refusing to run it in another route.`,
      );
    }
  };
  if (a.sessionId) {
    const row = ctx.sessions.row(a.sessionId);
    if ((row.account_id ?? null) !== accountId) {
      throw new RbaError(
        'forbidden',
        accountId
          ? `this operation belongs to account ${accountId}; session ${row.id} is ${row.account_id ? `bound to account ${row.account_id}` : 'not bound to an account'}. Refusing to use another account's session.`
          : `this is a public operation; session ${row.id} is bound to account ${row.account_id}. Public operations run only in sessions without an account.`,
      );
    }
    const mode = ctx.sessions.modeOf(row);
    if (a.mode || a.proxy || a.proxyMode) {
      const want = resolveRoute({ mode: a.mode, proxy: a.proxy, proxyMode: a.proxyMode, country: a.country }, ctx.cfg);
      if (want.mode !== mode) throw new RbaError('invalid_input', `session ${row.id} runs in mode ${mode}; refusing to switch routes (requested ${want.mode})`);
    }
    checkBound(`session ${row.id}`, mode, ctx.sessions.routeOf(row).proxy?.kind ?? null);
    await requireCapabilities(ctx, row.id);
    const use = { sessionId: row.id, mode, temporary: false };
    return { value: (await fn(use)).value, use };
  }
  const route = resolveToolRoute(ctx, a, accountId);
  checkBound('the requested route', route.mode, route.proxy?.kind ?? null);
  const s = await ctx.sessions.start({ accountId: accountId ?? undefined, mode: route.mode, proxy: route.proxy ?? undefined, purpose: 'operation', maxMinutes: 5 });
  const use = { sessionId: s.sessionId, mode: route.mode, temporary: true };
  let ok = false;
  try {
    await requireCapabilities(ctx, s.sessionId);
    const r = await fn(use);
    ok = r.ok;
    return { value: r.value, use };
  } finally {
    CAPS.delete(s.sessionId);
    await ctx.sessions.close(s.sessionId, { saveState: !!accountId && ok }).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ captures

const CAPTURE_LIMITS = { maxExchanges: 100, maxBodyBytes: 256 * 1024, timeoutMs: 60_000 };

const enc = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).map(([k, v]) => [k, encodeURIComponent(asText(v))]));

function captureBody(trigger: Trigger, args: Record<string, unknown>, waitMs: number | undefined): CaptureRequest {
  const raw = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, asText(v)]));
  return {
    url: fillTemplate(trigger.url, enc(args)),
    steps: (trigger.steps ?? []).map((s) => ({
      action: s.action,
      ...(s.selector !== undefined ? { selector: fillTemplate(s.selector, raw) } : {}),
      ...(s.value !== undefined ? { value: s.action === 'goto' ? fillTemplate(s.value, enc(args)) : fillTemplate(s.value, raw) } : {}),
      ...(s.ms !== undefined ? { ms: s.ms } : {}),
    })),
    waitMs: waitMs ?? 1500,
    ...CAPTURE_LIMITS,
  };
}

function toExchanges(c: CaptureResponse): Exchange[] {
  return c.exchanges.map((e) => ({
    id: e.id,
    resourceType: e.resourceType,
    request: { method: e.request.method, url: e.request.url, headers: lower(e.request.headers), ...(e.request.body !== undefined ? { body: e.request.body } : {}) },
    ...(e.response ? { response: { status: e.response.status, headers: lower(e.response.headers), contentType: e.response.contentType, ...(e.response.body !== undefined ? { body: e.response.body } : {}) } } : {}),
  }));
}

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

function toCookies(s: StorageState): StoredCookie[] {
  return s.cookies.map((c) => ({
    name: String(c.name),
    value: String(c.value),
    domain: String(c.domain),
    path: String(c.path ?? '/'),
    expires: typeof c.expires === 'number' ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    ...(c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None' ? { sameSite: c.sameSite } : {}),
  }));
}

function storageValues(s: StorageState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of s.origins) for (const kv of o.localStorage) out[`${o.origin} ${kv.name}`] = kv.value;
  return out;
}

// ------------------------------------------------------------------ privacy and binding

/** Private values known for one learning (or repair) session: registry emails/inboxes, its cookie and storage values. */
function sessionKnown(ctx: Ctx, cookies: StoredCookie[], storage: Record<string, string>): KnownValues {
  return knownPrivateValues(ctx, [...cookies.map((c) => c.value), ...Object.values(storage)].filter((v) => v.length >= 6));
}

/** The account's current route as an operation binding (mode, proxy kind). */
function accountRoute(ctx: Ctx, accountId: string): BoundRoute {
  // No provider check here: a binding check must not depend on which providers are configured.
  const r = resolveRoute({ account: ctx.accounts.row(accountId) }, ctx.cfg);
  return { mode: r.mode, proxyKind: r.mode === 'remote_proxy' ? (r.proxy?.kind ?? null) : null };
}

function boundRouteOf(row: OperationRow): BoundRoute | null {
  try {
    return row.bound_route_json ? (JSON.parse(row.bound_route_json) as BoundRoute) : null;
  } catch {
    return null;
  }
}

/**
 * An operation saved before the privacy rules is never run. An account
 * operation runs only while its account still has the origin and route it was
 * learned with. Returns the route a session must have (account operations).
 */
function checkBinding(ctx: Ctx, row: OperationRow): BoundRoute | null {
  if (row.privacy_version === null || row.privacy_version === undefined) {
    throw new RbaError('conflict', `operation ${row.id} was saved before saved operations were bound to their account and checked for private data; delete it (operation_delete) and learn it again`);
  }
  if (!row.account_id) return null;
  const acct = ctx.accounts.row(row.account_id);
  if (!row.bound_origin || acct.target_origin !== row.bound_origin) {
    throw new RbaError('forbidden', `account ${row.account_id}'s target origin changed since operation ${row.id} was learned; refusing to run it against another origin. Delete the operation and learn it again.`);
  }
  const bound = boundRouteOf(row);
  if (!bound) throw new RbaError('internal', `operation ${row.id} has no route binding`);
  const now = accountRoute(ctx, row.account_id);
  if (now.mode !== bound.mode || (bound.mode === 'remote_proxy' && bound.proxyKind && now.proxyKind !== bound.proxyKind)) {
    throw new RbaError(
      'forbidden',
      `account ${row.account_id}'s execution route changed since operation ${row.id} was learned (${bound.mode}${bound.proxyKind ? `/${bound.proxyKind}` : ''} then, ${now.mode}${now.proxyKind ? `/${now.proxyKind}` : ''} now); refusing to run it. Delete the operation and learn it again in the account's current route.`,
    );
  }
  return bound;
}

/**
 * What may be stored: account literals become account constants (an account
 * operation) or refuse the save (anything left, and every private-looking
 * literal of a public operation). `op` has its param places blanked.
 */
function privacyGate(
  op: Operation,
  data: unknown,
  accountId: string | null,
  known: KnownValues,
  sessionValues: Record<string, string>,
  /** Registry-known private values (account emails, inboxes) for values a public operation would replay. */
  replayKnown: KnownValues,
): { envelope: SpecEnvelope; constants: Record<string, string> } | { refused: string } {
  let operation = op;
  let constants: Record<string, string> = {};
  if (accountId) {
    const p = privatizeAccountOperation(op, known);
    if (p.findings.length) {
      return {
        refused: `refusing to save: the request holds account-specific literals where they cannot become encrypted account references (${describeFindings(p.findings, known)}). Nothing was stored.`,
      };
    }
    operation = p.operation;
    constants = p.constants;
  }
  if (operation.response.shape) operation = { ...operation, response: { ...operation.response, shape: sanitizeShape(operation.response.shape, known) } };
  operation = OperationSchema.parse(operation);
  const resultShape = sanitizeShape(inferShape(data), known);
  const findings = scanStored(operation, resultShape, known.with(Object.values(constants)));
  if (!accountId) {
    // A public operation may not replay account data from its private record either: a session: value
    // the learner kept (a fixed value the page sent) that is an email, UUID or known private value refuses the save.
    for (const s of operation.slots) {
      const v = s.ref?.startsWith('session:') ? sessionValues[s.ref.slice(8)] : undefined;
      if (!v) continue;
      const hit = findPrivate(v, replayKnown, true).find((h) => h.kind !== 'long token' && h.kind !== 'JWT');
      if (hit) findings.push({ where: `request ${s.at.join(' > ')} (a fixed value replayed from the private record)`, kind: hit.kind });
    }
  }
  if (findings.length) {
    return {
      refused: accountId
        ? `refusing to save: private-looking literals would stay in the stored spec (${describeFindings(findings, known)}). Remove them from the trigger URL, steps, description or response recipe; nothing was stored.`
        : `refusing to save a public operation: it would hold private-looking literals (${describeFindings(findings, known)}). A public operation may not carry account data (emails, ids, tokens, this registry's account emails or inboxes, the session's cookie or storage values). Learn it in the account it belongs to (accountId), or choose examples so those places become params. Nothing was stored.`,
    };
  }
  return { envelope: { v: 1, operation, resultShape }, constants };
}

function privacyNote(row: OperationRow, constants: number) {
  return {
    version: row.privacy_version,
    exportable: false,
    ...(row.account_id ? { boundTo: { accountId: row.account_id, origin: row.bound_origin, route: boundRouteOf(row) }, accountConstants: constants } : {}),
    note: row.account_id
      ? 'Runs only in this account, while its origin and route are unchanged. Account-specific literals are encrypted account constants, not part of the spec. There is no export or cross-account reuse.'
      : 'Public: runs only in sessions without an account. It holds no private-looking literal. There is no export.',
  };
}

// ------------------------------------------------------------------ learning

export interface LearnArgs extends RouteArgs {
  name: string;
  description?: string;
  accountId?: string;
  public?: boolean;
  trigger: { url: string; steps?: Trigger['steps'] };
  examples: [Args, Args];
  match?: Match;
  response?: { format?: 'json' | 'html' | 'embedded'; extract?: string; pick?: string[]; html?: { items: string; fields: Record<string, string> }; embedded?: { regex: string } };
  readOnly: true;
  waitMs?: number;
  sessionId?: string;
}

function checkExamplesArg(examples: [Args, Args]): void {
  const [a, b] = examples;
  const ka = Object.keys(a).sort().join();
  if (!ka) throw new RbaError('invalid_input', 'examples need at least one param');
  if (Object.keys(b).sort().join() !== ka) throw new RbaError('invalid_input', 'both example sets must name the same params');
  if (Object.keys(a).every((k) => asText(a[k]).toLowerCase() === asText(b[k]).toLowerCase())) {
    throw new RbaError('invalid_input', 'the two example sets must differ (the second run separates params from nonces)');
  }
}

export async function learn(ctx: Ctx, a: LearnArgs) {
  requireEnabled(ctx);
  if (a.readOnly !== true) throw new RbaError('invalid_input', 'only read operations can be learned: pass readOnly: true after checking the request only reads');
  if (!!a.accountId === !!a.public) throw new RbaError('invalid_input', 'pass exactly one of accountId (operation scoped to that account) or public: true (no account)');
  checkExamplesArg(a.examples);
  const accountId = a.accountId ?? null;
  const store = opStore(ctx);
  const trigger: Trigger = { url: a.trigger.url, ...(a.trigger.steps?.length ? { steps: a.trigger.steps } : {}) };
  let target: URL;
  try {
    target = new URL(fillTemplate(trigger.url, enc(a.examples[0])));
  } catch {
    throw new RbaError('invalid_input', 'trigger.url must be an absolute http(s) URL template');
  }
  if (accountId) {
    const acct = ctx.accounts.row(accountId);
    const allowed = [acct.target_origin, ...(ctx.cfg.targets.find((t) => t.origin === acct.target_origin)?.authOrigins ?? [])];
    if (!allowed.includes(target.origin)) throw new RbaError('invalid_input', `trigger origin ${target.origin} is not account ${accountId}'s target (${acct.target_origin})`);
  }

  // An account operation is learned (and bound) in the account's own route only.
  const bound = accountId ? accountRoute(ctx, accountId) : null;
  const { value, use } = await withSession(
    ctx,
    accountId,
    a,
    async (use) => {
      const c1 = await workerCall<CaptureResponse>(ctx, use.sessionId, '/capture', captureBody(trigger, a.examples[0], a.waitMs));
      const c2 = await workerCall<CaptureResponse>(ctx, use.sessionId, '/capture', captureBody(trigger, a.examples[1], a.waitMs));
      const st = await workerCall<StateExportResponse>(ctx, use.sessionId, '/state/export', {});
      return { value: { c1, c2, state: st.storageState }, ok: true };
    },
    bound,
  );
  const cookies = toCookies(value.state);
  for (const c of cookies) registerSecret(c.value);
  const sessionStorage = { ...value.c1.storage, ...storageValues(value.state) };
  const baseKnown = sessionKnown(ctx, cookies, sessionStorage);
  let known = baseKnown;

  let learned;
  try {
    learned = learnOperation({
      exchanges: toExchanges(value.c1),
      exchanges2: toExchanges(value.c2),
      examples: [a.examples[0], a.examples[1]],
      cookies,
      ...(a.match ? { match: a.match } : {}),
      name: a.name,
      trigger,
      readOnly: true,
      storage: value.c1.storage,
      pages: [...value.c1.locations, value.c1.finalUrl],
    });
  } catch (e) {
    throw new RbaError('invalid_input', redactPrivate(`could not learn an operation from the captured traffic: ${(e as Error).message}`, known, !!accountId).slice(0, 1500));
  }
  known = known.with(Object.values(learned.sessionValues));
  let op: Operation = learned.operation;
  if (a.description) op = { ...op, description: a.description };
  if (a.response) op = { ...op, response: ResponseSchema.parse({ ...op.response, ...a.response }) };
  const why = refusal(op);
  if (why) throw new RbaError('forbidden', why);

  const resp = learned.exchange.response;
  const judged: Judged = resp ? judge(op, { status: resp.status, headers: resp.headers, body: resp.body ?? '', url: learned.exchange.request.url }) : { class: 'error', reason: 'the chosen request has no response' };
  if (judged.class !== 'ok') throw new RbaError('invalid_input', redactPrivate(`the learned operation does not read the captured answer (${judged.class}: ${judged.reason}); adjust match or response`, known, !!accountId));

  // Private by default: account literals become encrypted account constants; a public operation holds none.
  const gate = privacyGate(stripExamples(op), judged.data, accountId, baseKnown, learned.sessionValues, knownPrivateValues(ctx));
  if ('refused' in gate) throw new RbaError('forbidden', gate.refused);
  const { envelope, constants } = gate;
  known = known.with(Object.values(constants));
  const leaks = exampleLeaks(envelope.operation, a.examples);
  if (leaks.length) {
    throw new RbaError('invalid_input', `the learned request still carries the example value of ${leaks.join(', ')} outside the param's places (the site repeats it somewhere the learner did not map); not stored. Try examples that do not occur elsewhere, or pass match.`);
  }

  // No credential may be stored in the spec: live cookie values, storage values and learned session values.
  const scan = scanSecrets(envelope, { cookies, values: { ...learned.sessionValues, ...storageValues(value.state), ...constants } });
  if (scan.secrets.length) throw new RbaError('forbidden', redactPrivate(`refusing to store the operation: ${scan.secrets.slice(0, 5).join('; ')}`, known, !!accountId));
  const priv: OperationPrivate = { examples: [a.examples[0], a.examples[1]], sessionValues: { ...learned.sessionValues, ...constants } };
  registerSecrets(Object.values(priv.sessionValues));
  const learnedRoute = ctx.sessions.routeOf(ctx.sessions.row(use.sessionId));
  const row = store.insert({
    name: a.name,
    accountId,
    targetOrigin: target.origin,
    envelope,
    learnedMode: use.mode,
    learnedProxy: learnedRoute.proxy,
    boundOrigin: accountId ? ctx.accounts.row(accountId).target_origin : null,
    priv,
  });
  const preview = capOutput(judged.data, LIMITS.previewChars);
  return {
    operationId: row.id,
    name: row.name,
    status: row.status,
    scope: accountId ? { accountId } : 'public',
    learnedIn: { mode: use.mode, sessionId: use.temporary ? null : use.sessionId },
    specSha256: row.spec_sha256,
    // Built from the stored (privatized) spec, never from the captured request.
    review: reviewSummary(envelope.operation),
    privacy: privacyNote(row, Object.keys(constants).length),
    next: 'Check the review (method, destination, body fields, trigger steps). If it only reads, call operation_review with this specSha256 and confirmReadOnly: true.',
    // Learner warnings quote captured URLs (private literals redacted); the preview is page data.
    untrusted: {
      warnings: [...learned.warnings, ...scan.warnings].slice(0, 20).map((w) => redactPrivate(w, known, !!accountId)),
      preview: preview.data,
      ...(preview.truncated ? { previewTruncated: preview.truncated } : {}),
    },
  };
}

// ------------------------------------------------------------------ review / list / delete

export function review(ctx: Ctx, a: { operationId: string; specSha256: string; confirmReadOnly: true }) {
  requireEnabled(ctx);
  if (a.confirmReadOnly !== true) throw new RbaError('invalid_input', 'confirmReadOnly: true is required');
  const store = opStore(ctx);
  const row0 = store.row(a.operationId);
  if (row0.privacy_version === null || row0.privacy_version === undefined) {
    throw new RbaError('conflict', `operation ${row0.id} was saved before the privacy rules; delete it and learn it again`);
  }
  const env = store.envelope(row0);
  const why = refusal(env.operation);
  if (why) throw new RbaError('forbidden', why);
  const r = store.markReviewed(a.operationId, a.specSha256);
  return { operationId: r.id, status: r.status, reviewedAt: r.reviewed_at };
}

/** Spec export is disabled: there is no proof yet that a spec carries nothing of the account it was learned in. */
export const EXPORT_DISABLED =
  'Spec export is disabled: saved operations stay in this install and are not shared or reused across accounts. includeSpec shows the review summary (method, host, path, field and header names, params, references) with private-looking literals redacted, never the request template.';

export function view(ctx: Ctx, r: OperationRow, includeSpec = false, known?: KnownValues) {
  const store = opStore(ctx);
  const env = store.envelope(r);
  const op = env.operation;
  const k = known ?? knownPrivateValues(ctx);
  const legacy = r.privacy_version === null || r.privacy_version === undefined;
  let spec: Record<string, unknown> | undefined;
  if (includeSpec) {
    const summary = reviewSummary(op);
    // Path segments are judged like account literals (numeric and mixed ids too), not only strictly.
    const segs = summary.path.split('/').map((s) => (findPrivate(s, k, false).length ? '[private]' : s));
    const pathRedacted = segs.join('/') !== summary.path ? 1 : 0;
    const red = redactPrivateDeep({ ...summary, path: segs.join('/') }, k);
    red.redacted += pathRedacted;
    spec = {
      exportable: false,
      note: EXPORT_DISABLED,
      review: red.value,
      privateLiteralsRedacted: red.redacted,
      resultShapePaths: Object.keys(env.resultShape).length,
      upstreamRevision: r.upstream_rev,
    };
  }
  return {
    operationId: r.id,
    name: r.name,
    scope: r.account_id ? { accountId: r.account_id } : 'public',
    status: r.status,
    callable: !legacy && r.status === 'reviewed' && r.reviewed_sha256 === r.spec_sha256,
    targetOrigin: r.target_origin,
    learnedMode: r.learned_mode,
    minTier: r.min_tier,
    params: op.params.map((p) => ({ name: p.name, type: p.type, required: p.required })),
    specSha256: r.spec_sha256,
    reviewedAt: r.reviewed_at,
    lastOkAt: r.last_ok_at,
    privacy: legacy
      ? { version: null, exportable: false, note: 'Saved before the privacy rules: not callable. Delete it and learn it again.' }
      : privacyNote(r, constantRefs(op.slots).length),
    recentCalls: store.recentCalls(r.id),
    // Descriptions come from whoever learned the operation and may quote page text.
    untrusted: { description: op.description ? redactPrivate(op.description, k) : null },
    ...(spec ? { spec } : {}),
  };
}

export function list(ctx: Ctx, a: { accountId?: string; includePublic?: boolean; includeSpec?: boolean }) {
  requireEnabled(ctx);
  if (a.accountId) ctx.accounts.row(a.accountId);
  const known = knownPrivateValues(ctx);
  return opStore(ctx)
    .list({ accountId: a.accountId, includePublic: a.includePublic ?? true })
    .map((r) => view(ctx, r, a.includeSpec, known));
}

export function remove(ctx: Ctx, a: { operationId: string }) {
  requireEnabled(ctx);
  opStore(ctx).delete(a.operationId);
  return { operationId: a.operationId, deleted: true, note: 'The stored operation, its encrypted examples and session values, and its call log were deleted.' };
}

// ------------------------------------------------------------------ calling

export interface CallArgs extends RouteArgs {
  operationId: string;
  args: Record<string, unknown>;
  sessionId?: string;
  allowBrowserFallback?: boolean;
  allowRepair?: boolean;
}

interface Attempt {
  tier: 1 | 3;
  class: Judged['class'] | 'not_found';
  reason: string;
  data?: unknown;
  status?: number;
  /** classify's `missing`: a bare refusal or missing data, not a bot wall. */
  missing?: boolean;
}

/**
 * Tier-1 outcomes that may be retried in the browser (same session, same mode).
 * A bare 403 without challenge or login markers (classify's `missing`) is
 * retried too: a per-request token the replay could not reproduce answers that
 * way. A detected bot wall, a 429/rate limit, or bad input is reported, never retried.
 */
function mayFallBack(a: Attempt): boolean {
  if (a.class === 'auth' || a.class === 'drift' || a.class === 'not_found') return true;
  if (a.class === 'error') return true;
  return a.class === 'blocked' && a.missing === true;
}

function callable(r: OperationRow): void {
  if (r.status === 'disabled') throw new RbaError('conflict', `operation ${r.id} is disabled`);
  if (r.status !== 'reviewed' || r.reviewed_sha256 !== r.spec_sha256) {
    throw new RbaError('conflict', `operation ${r.id} is ${r.status === 'reviewed' ? 'changed since its review' : r.status}: it must be reviewed (operation_review) before it can be called`);
  }
}

async function tier1(ctx: Ctx, sessionId: string, op: Operation, vals: Record<string, unknown>, priv: OperationPrivate): Promise<Attempt> {
  const refs = refsOf(op);
  const needCookies = refs.some((r) => r.startsWith('cookie:'));
  const cookies = needCookies ? toCookies((await workerCall<StateExportResponse>(ctx, sessionId, '/state/export', {})).storageState) : [];
  for (const c of cookies) registerSecret(c.value);
  let req;
  try {
    req = buildRequest(op, vals, { cookies, values: priv.sessionValues });
  } catch (e) {
    if (e instanceof MissingRefError) return { tier: 1, class: 'auth', reason: e.message };
    throw e;
  }
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') throw new RbaError('forbidden', `method ${method} is not sent for saved read operations`);
  const body: FetchRequest = {
    method: method as FetchRequest['method'],
    url: req.url,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(cookie|host|content-length|connection|transfer-encoding|upgrade|te|trailer|keep-alive|expect|proxy-.*)$/i.test(k))),
    ...(req.body !== undefined && method === 'POST' ? { body: req.body } : {}),
    allowCrossOriginRedirects: refs.length === 0,
    sensitiveHeaders: sensitiveHeaders(op),
    timeoutMs: 30_000,
  };
  const r = await workerCall<FetchResponse>(ctx, sessionId, '/fetch', body);
  if (r.truncated) return { tier: 1, class: 'error', reason: `response larger than ${r.bytes} bytes cap; not judged`, status: r.status };
  const j = judge(op, { status: r.status, headers: r.headers, body: r.body, url: r.url });
  return { tier: 1, class: j.class, reason: j.reason, data: j.data, status: r.status, ...(j.missing ? { missing: true } : {}) };
}

async function tier3(ctx: Ctx, sessionId: string, op: Operation, vals: Record<string, unknown>): Promise<Attempt> {
  const c = await workerCall<CaptureResponse>(ctx, sessionId, '/capture', captureBody(op.trigger, vals, undefined));
  const own = Object.keys(op.match).length ? op.match : { method: op.request.method, host: new URL(op.request.url).hostname, path: new URL(op.request.url).pathname };
  const candidates = toExchanges(c).filter((e) => e.response && matches(own, e.request));
  const hit = candidates.find((e) => carriesArgs(op, e.request, vals));
  if (!hit) {
    return {
      tier: 3,
      class: 'not_found',
      reason: candidates.length
        ? "the page made the operation's request, but not with these args at the operation's places; not returning another query's data"
        : "the page did not make the operation's request",
    };
  }
  const resp = hit.response!;
  const j = judge(op, { status: resp.status, headers: resp.headers, body: resp.body ?? '', url: hit.request.url });
  return { tier: 3, class: j.class, reason: j.reason, data: j.data, status: resp.status };
}

async function runTiers(ctx: Ctx, sessionId: string, op: Operation, vals: Record<string, unknown>, priv: OperationPrivate, allowFallback: boolean): Promise<{ final: Attempt; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  if (op.minTier < 3) {
    const a1 = await tier1(ctx, sessionId, op, vals, priv);
    attempts.push(a1);
    if (a1.class === 'ok' || !allowFallback || !mayFallBack(a1)) return { final: a1, attempts };
  } else if (!allowFallback) {
    return { final: { tier: 3, class: 'error', reason: 'this operation needs the browser on every call (per-request nonce or signature) and allowBrowserFallback is false' }, attempts };
  }
  const a3 = await tier3(ctx, sessionId, op, vals);
  attempts.push(a3);
  return { final: a3, attempts };
}

function sameTemplate(a: Operation, b: Operation): boolean {
  const key = (o: Operation) => JSON.stringify({ r: o.request, s: o.slots, m: o.match, resp: { ...o.response, shape: undefined }, t: o.minTier });
  return key(a) === key(b);
}

async function repair(ctx: Ctx, row: OperationRow, env: SpecEnvelope, priv: OperationPrivate, sessionId: string) {
  const store = opStore(ctx);
  try {
    store.takeRepair(row.id);
  } catch (e) {
    return { attempted: false, reason: (e as Error).message };
  }
  const old = env.operation;
  const c1 = await workerCall<CaptureResponse>(ctx, sessionId, '/capture', captureBody(old.trigger, priv.examples[0], undefined));
  const c2 = await workerCall<CaptureResponse>(ctx, sessionId, '/capture', captureBody(old.trigger, priv.examples[1], undefined));
  const st = await workerCall<StateExportResponse>(ctx, sessionId, '/state/export', {});
  const cookies = toCookies(st.storageState);
  for (const c of cookies) registerSecret(c.value);
  const baseKnown = sessionKnown(ctx, cookies, { ...c1.storage, ...storageValues(st.storageState) }).with(Object.entries(priv.sessionValues).filter(([k]) => k.startsWith(ACCOUNT_REF)).map(([, v]) => v));
  let known = baseKnown.with(Object.values(priv.sessionValues));
  const no = (reason: string) => ({ attempted: true, changed: false, reason: redactPrivate(reason, known, !!row.account_id).slice(0, 600) });
  let learned;
  try {
    learned = learnOperation({
      exchanges: toExchanges(c1),
      exchanges2: toExchanges(c2),
      examples: priv.examples,
      cookies,
      match: old.match,
      name: old.name,
      trigger: old.trigger,
      readOnly: true,
      storage: c1.storage,
      pages: [...c1.locations, c1.finalUrl],
    });
  } catch (e) {
    return no(`re-learning failed: ${(e as Error).message}`);
  }
  known = known.with(Object.values(learned.sessionValues));
  let op = { ...learned.operation, ...(old.description ? { description: old.description } : {}) };
  // Scope: a repair never changes the destination origin or the method.
  const origin = (o: Operation) => new URL(o.request.url).origin;
  if (origin(op) !== origin(old) || op.request.method.toUpperCase() !== old.request.method.toUpperCase()) {
    return no('the re-learned request goes to another origin or uses another method; a repair keeps the operation\'s destination and method. Not stored.');
  }
  const resp = learned.exchange.response;
  // Keep the operation's own recipe when it still reads the new answer.
  const observed = resp ? { status: resp.status, headers: resp.headers, body: resp.body ?? '', url: learned.exchange.request.url } : null;
  if (observed && judge({ ...op, response: old.response }, observed).class === 'ok') op = { ...op, response: { ...old.response, shape: op.response.shape } };
  const j = observed ? judge(op, observed) : { class: 'error' as const, reason: 'no response' };
  if (j.class !== 'ok') return no(`re-learned request does not read its answer (${j.class}: ${j.reason})`);
  if (refusal(op)) return no(`re-learned request refused: ${refusal(op)}`);
  // The same privacy rules as learning: account literals become constants; nothing private stays in the spec.
  const gate = privacyGate(stripExamples(op), j.data, row.account_id, baseKnown, learned.sessionValues, knownPrivateValues(ctx));
  if ('refused' in gate) return no(`re-learned spec not stored: ${gate.refused}`);
  const next = gate.envelope;
  if (sameTemplate(next.operation, old)) return no('the re-learned operation is identical; not drift in the template (the site may be failing)');
  if (exampleLeaks(next.operation, priv.examples).length) return no('the re-learned request carries an example value outside its param places; not stored');
  const scan = scanSecrets(next, { cookies, values: { ...learned.sessionValues, ...storageValues(st.storageState), ...gate.constants } });
  if (scan.secrets.length) return no('the re-learned spec would hold a credential; not stored');
  const sessionValues = { ...learned.sessionValues, ...gate.constants };
  registerSecrets(Object.values(sessionValues));
  const updated = store.replaceSpec(row.id, next, { examples: priv.examples, sessionValues });
  return {
    attempted: true,
    changed: true,
    status: updated.status,
    specSha256: updated.spec_sha256,
    review: reviewSummary(next.operation),
    next: 'The operation was re-learned and needs a new review (operation_review) before it can be called again.',
  };
}

/** A public operation runs, unless told otherwise, in the mode it was learned in. */
function defaultRoute(row: OperationRow, a: RouteArgs): RouteArgs {
  if (row.account_id || a.mode || a.proxy || a.proxyMode) return a;
  let proxy: RouteArgs['proxy'];
  try {
    proxy = row.learned_proxy_json ? (JSON.parse(row.learned_proxy_json) as RouteArgs['proxy']) : undefined;
  } catch {
    proxy = undefined;
  }
  return { ...a, mode: row.learned_mode, ...(row.learned_mode === 'remote_proxy' && proxy ? { proxy } : {}) };
}

export async function call(ctx: Ctx, a: CallArgs) {
  return (await callInternal(ctx, a, {})).result;
}

async function callInternal(ctx: Ctx, a: CallArgs, o: { forValidation?: boolean }) {
  requireEnabled(ctx);
  const store = opStore(ctx);
  const row = store.row(a.operationId);
  callable(row);
  const bound = checkBinding(ctx, row);
  const env = store.envelope(row);
  const op = env.operation;
  let vals: Record<string, unknown>;
  try {
    vals = checkArgs(op, a.args ?? {});
  } catch (e) {
    if (e instanceof InputError) return { result: { operationId: row.id, name: row.name, ok: false, class: 'input' as const, sent: false, untrusted: { reason: e.message } }, data: undefined };
    throw e;
  }
  const priv = store.private(row.id);
  const known = knownPrivateValues(ctx, Object.values(priv.sessionValues));
  const t0 = Date.now();
  let res: { final: Attempt; attempts: Attempt[]; repaired?: unknown };
  let use: SessionUse;
  try {
    const out = await withSession(
      ctx,
      row.account_id,
      { ...a, ...defaultRoute(row, a) },
      async (u) => {
        const r = await runTiers(ctx, u.sessionId, op, vals, priv, a.allowBrowserFallback !== false);
        let repaired: unknown;
        if (r.final.class !== 'ok' && a.allowRepair && !o.forValidation && (r.final.class === 'drift' || r.final.class === 'not_found')) {
          repaired = await repair(ctx, row, env, priv, u.sessionId);
        }
        return { value: { ...r, repaired }, ok: r.final.class === 'ok' };
      },
      bound,
    );
    res = out.value;
    use = out.use;
  } catch (e) {
    store.logCall({ operationId: row.id, mode: row.learned_mode, tier: null, cls: 'error', ms: Date.now() - t0, errorCode: (e as RbaError).code ?? 'internal' });
    throw e;
  }
  const f = res.final;
  store.logCall({ operationId: row.id, mode: use.mode, tier: f.tier, cls: f.class, ms: Date.now() - t0 });
  if (f.class === 'ok') store.noteOk(row.id);
  const cap = f.class === 'ok' ? capOutput(f.data, LIMITS.outputChars) : null;
  const result = {
    operationId: row.id,
    name: row.name,
    ok: f.class === 'ok',
    class: f.class,
    tier: f.tier,
    mode: use.mode,
    sessionId: use.temporary ? null : use.sessionId,
    ms: Date.now() - t0,
    attempts: res.attempts.map((x) => ({ tier: x.tier, class: x.class, ...(x.status !== undefined ? { status: x.status } : {}) })),
    ...(res.repaired !== undefined ? { repair: res.repaired } : {}),
    ...(cap?.truncated ? { truncated: cap.truncated } : {}),
    // Reasons quote response bodies and URLs: page content, with private-looking literals and account constants redacted.
    untrusted: { reason: redactPrivate(f.reason, known, !!row.account_id), attemptReasons: res.attempts.map((x) => redactPrivate(x.reason, known, !!row.account_id)), ...(cap ? { data: cap.data } : {}) },
  };
  return { result, data: f.class === 'ok' ? f.data : undefined };
}

// ------------------------------------------------------------------ validation

export async function validate(ctx: Ctx, a: CallArgs) {
  requireEnabled(ctx);
  const store = opStore(ctx);
  const row = store.row(a.operationId);
  callable(row);
  checkBinding(ctx, row);
  const env = store.envelope(row);
  const priv = store.private(row.id);
  const norm = (v: unknown) => asText(v).trim().toLowerCase();
  for (const [i, ex] of priv.examples.entries()) {
    const same = env.operation.params.every((p) => a.args?.[p.name] === undefined || norm(a.args[p.name]) === norm(ex[p.name]));
    if (same) throw new RbaError('invalid_input', `validation args must differ from the learning example ${i + 1}; use inputs the operation was not learned from`);
  }
  const { result: out, data: data$ } = await callInternal(ctx, { ...a, allowRepair: false }, { forValidation: true });
  if (!out.ok) return { ...out, valid: false, verdict: `call failed (${out.class})` };
  const expected = env.resultShape;
  const now = inferShape(data$, 2000);
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [p, t] of Object.entries(expected)) {
    if (now[p] === undefined) missing.push(p);
    else if (now[p] !== t && now[p] !== 'null' && t !== 'null') changed.push(`${p}: ${t} -> ${now[p]}`);
  }
  const empty = Array.isArray(data$) ? data$.length === 0 : data$ === null || data$ === undefined;
  const valid = !empty && missing.length === 0 && changed.length === 0;
  return {
    ...out,
    valid,
    verdict: empty ? 'inconclusive: the result is empty, so its shape cannot be checked; try other inputs' : valid ? 'result shape matches what the operation returned when it was learned' : 'result shape differs from the learned one',
    shape: { expectedPaths: Object.keys(expected).length, missing: missing.slice(0, 30), typeChanged: changed.slice(0, 30) },
  };
}

