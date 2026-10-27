/**
 * Strict validation of the Actor input and of request bodies. Unknown keys
 * are rejected; there are no silent fallbacks for malformed values.
 */
import type { WorkerInput } from './protocol.js';
import { normalizeOrigin, normalizeResourceOrigin } from './netpolicy.js';

export class ValidationError extends Error {}

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function onlyKeys(o: Obj, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new ValidationError(`unknown key "${k}" in ${where}`);
  }
}

function int(o: Obj, k: string, min: number, max: number, where: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`${where}.${k} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

function strArray(v: unknown, where: string, maxLen = 1000): string[] {
  if (!Array.isArray(v) || v.length > maxLen || v.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 2000)) {
    throw new ValidationError(`${where} must be an array of non-empty strings`);
  }
  return v as string[];
}

const HOST_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

export function validateWorkerInput(raw: unknown): WorkerInput {
  if (!isObj(raw)) throw new ValidationError('input must be an object');
  onlyKeys(raw, ['protocolVersion', 'tokenHash', 'proxy', 'idleTimeoutSecs', 'maxLifetimeSecs', 'network', 'egressCheckUrl', 'maxUploadBytes'], 'input');
  if (raw.protocolVersion !== 1) throw new ValidationError('input.protocolVersion must be 1');
  if (typeof raw.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.tokenHash)) {
    throw new ValidationError('input.tokenHash must be 64 lowercase hex chars');
  }
  const proxy = raw.proxy;
  if (!isObj(proxy)) throw new ValidationError('input.proxy must be an object');
  onlyKeys(proxy, ['mode', 'country', 'sessionKey'], 'input.proxy');
  if (proxy.mode !== 'direct' && proxy.mode !== 'datacenter' && proxy.mode !== 'residential') {
    throw new ValidationError('input.proxy.mode must be direct|datacenter|residential');
  }
  if (proxy.country !== undefined && (typeof proxy.country !== 'string' || !/^[A-Z]{2}$/.test(proxy.country))) {
    throw new ValidationError('input.proxy.country must be a 2-letter uppercase ISO code');
  }
  if (proxy.sessionKey !== undefined && (typeof proxy.sessionKey !== 'string' || !/^[\w.~]{1,50}$/.test(proxy.sessionKey))) {
    throw new ValidationError('input.proxy.sessionKey must match [A-Za-z0-9_.~]{1,50}');
  }
  const idle = int(raw, 'idleTimeoutSecs', 1, 7 * 24 * 3600, 'input');
  const life = int(raw, 'maxLifetimeSecs', 1, 7 * 24 * 3600, 'input');
  const network = raw.network;
  if (!isObj(network)) throw new ValidationError('input.network must be an object');
  onlyKeys(network, ['allowedNavigationOrigins', 'allowedSubresourceOrigins', 'allowPrivateHosts'], 'input.network');
  const origins = strArray(network.allowedNavigationOrigins, 'input.network.allowedNavigationOrigins');
  if (origins.length === 0) throw new ValidationError('input.network.allowedNavigationOrigins must not be empty');
  for (const o of origins) {
    if (normalizeOrigin(o) === null) throw new ValidationError(`invalid origin in allowedNavigationOrigins: ${o}`);
  }
  const subres = network.allowedSubresourceOrigins === undefined ? [] : strArray(network.allowedSubresourceOrigins, 'input.network.allowedSubresourceOrigins');
  for (const o of subres) {
    if (normalizeResourceOrigin(o) === null) throw new ValidationError(`invalid entry in allowedSubresourceOrigins: ${o}`);
  }
  const priv = strArray(network.allowPrivateHosts, 'input.network.allowPrivateHosts');
  for (const h of priv) {
    if (!HOST_RE.test(h)) throw new ValidationError(`invalid host in allowPrivateHosts: ${h}`);
  }
  if (typeof raw.egressCheckUrl !== 'string') throw new ValidationError('input.egressCheckUrl must be a string');
  let eu: URL;
  try {
    eu = new URL(raw.egressCheckUrl);
  } catch {
    throw new ValidationError('input.egressCheckUrl must be a URL');
  }
  if (eu.protocol !== 'http:' && eu.protocol !== 'https:') throw new ValidationError('input.egressCheckUrl must be http(s)');
  if (eu.username || eu.password) throw new ValidationError('input.egressCheckUrl must not contain credentials');
  const maxUpload = int(raw, 'maxUploadBytes', 1, 200 * 1024 * 1024, 'input');
  return {
    protocolVersion: 1,
    tokenHash: raw.tokenHash,
    proxy: { mode: proxy.mode, country: proxy.country as string | undefined, sessionKey: proxy.sessionKey as string | undefined },
    idleTimeoutSecs: idle,
    maxLifetimeSecs: life,
    network: { allowedNavigationOrigins: origins, allowedSubresourceOrigins: subres, allowPrivateHosts: priv },
    egressCheckUrl: raw.egressCheckUrl,
    maxUploadBytes: maxUpload,
  };
}

// ---------------------------------------------------------------- request schemas

type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'string[]' | 'any';
type Schema = Record<string, { t: FieldType; req?: boolean; enum?: string[] }>;

function checkType(v: unknown, t: FieldType): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return isObj(v);
    case 'string[]':
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'any':
      return true;
  }
}

export function validateBody<T>(body: unknown, schema: Schema, where: string): T {
  if (!isObj(body)) throw new ValidationError(`${where}: body must be a JSON object`);
  onlyKeys(body, Object.keys(schema), where);
  for (const [k, s] of Object.entries(schema)) {
    const v = body[k];
    if (v === undefined) {
      if (s.req) throw new ValidationError(`${where}: ${k} is required`);
      continue;
    }
    if (!checkType(v, s.t)) throw new ValidationError(`${where}: ${k} must be ${s.t}`);
    if (s.enum && !s.enum.includes(v as string)) throw new ValidationError(`${where}: ${k} must be one of ${s.enum.join('|')}`);
  }
  return body as T;
}

const TARGET: Schema = { ref: { t: 'string' }, selector: { t: 'string' } };

export const SCHEMAS: Record<string, Schema> = {
  '/session/init': {
    storageState: { t: 'object' },
    viewport: { t: 'object' },
    userAgent: { t: 'string' },
    locale: { t: 'string' },
  },
  '/navigate': {
    url: { t: 'string', req: true },
    waitUntil: { t: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
    timeoutMs: { t: 'number' },
    settleMs: { t: 'number' },
    readyWhen: { t: 'object' },
    dialog: { t: 'object' },
  },
  '/inspect': { readyWhen: { t: 'object' }, maxElements: { t: 'number' }, includeText: { t: 'boolean' }, maxTextChars: { t: 'number' }, timeoutMs: { t: 'number' } },
  '/click': { ...TARGET, timeoutMs: { t: 'number' }, waitForNavigation: { t: 'boolean' }, dialog: { t: 'object' } },
  '/fill': { ...TARGET, value: { t: 'string', req: true }, timeoutMs: { t: 'number' }, requireOrigins: { t: 'string[]' } },
  '/select': { ...TARGET, values: { t: 'string[]', req: true } },
  '/upload': {
    ...TARGET,
    fileName: { t: 'string', req: true },
    mimeType: { t: 'string', req: true },
    contentBase64: { t: 'string', req: true },
    sha256: { t: 'string', req: true },
    requireOrigins: { t: 'string[]' },
  },
  '/screenshot': { fullPage: { t: 'boolean' }, maskSelectors: { t: 'string[]' } },
  '/extract': { spec: { t: 'object', req: true }, readyWhen: { t: 'object' }, timeoutMs: { t: 'number' } },
  '/state/export': {},
  '/fetch': {
    method: { t: 'string', req: true, enum: ['GET', 'HEAD', 'POST'] },
    url: { t: 'string', req: true },
    headers: { t: 'object' },
    body: { t: 'string' },
    maxRedirects: { t: 'number' },
    maxResponseBytes: { t: 'number' },
    allowCrossOriginRedirects: { t: 'boolean' },
    sensitiveHeaders: { t: 'string[]' },
    timeoutMs: { t: 'number' },
  },
  '/capture': {
    url: { t: 'string', req: true },
    steps: { t: 'any' },
    waitMs: { t: 'number' },
    maxExchanges: { t: 'number' },
    maxBodyBytes: { t: 'number' },
    timeoutMs: { t: 'number' },
  },
  '/crawl/start': {
    startUrls: { t: 'string[]', req: true },
    sameOriginOnly: { t: 'boolean', req: true },
    includeGlobs: { t: 'string[]', req: true },
    excludeGlobs: { t: 'string[]', req: true },
    maxPages: { t: 'number', req: true },
    maxDepth: { t: 'number', req: true },
    delayMs: { t: 'number', req: true },
    pageTimeoutMs: { t: 'number', req: true },
    maxRetriesPerPage: { t: 'number', req: true },
    extract: { t: 'object' },
    maxDurationMs: { t: 'number' },
  },
  '/crawl/cancel': {},
  '/shutdown': {},
};

export function validateInitExtras(body: Obj): void {
  if (body.viewport !== undefined) {
    const v = body.viewport as Obj;
    onlyKeys(v, ['width', 'height'], 'viewport');
    int(v, 'width', 200, 4000, 'viewport');
    int(v, 'height', 200, 4000, 'viewport');
  }
  if (body.storageState !== undefined) {
    const s = body.storageState as Obj;
    onlyKeys(s, ['cookies', 'origins'], 'storageState');
    if (!Array.isArray(s.cookies) || !s.cookies.every(isObj)) throw new ValidationError('storageState.cookies must be an array of objects');
    if (!Array.isArray(s.origins) || !s.origins.every(isObj)) throw new ValidationError('storageState.origins must be an array of objects');
  }
  if (typeof body.userAgent === 'string' && body.userAgent.length > 1000) throw new ValidationError('userAgent too long');
  if (typeof body.locale === 'string' && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(body.locale)) throw new ValidationError('invalid locale');
}

const DIALOG_TYPES = new Set(['alert', 'confirm', 'prompt', 'beforeunload']);

/** Action-scoped dialog policy (see protocol DialogPolicy). */
export function validateDialogPolicy(v: unknown): void {
  if (v === undefined) return;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ValidationError('dialog must be an object');
  const d = v as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!['action', 'types', 'promptText', 'maxDialogs'].includes(k)) throw new ValidationError(`dialog.${k} is not allowed`);
  if (d.action !== 'accept' && d.action !== 'dismiss') throw new ValidationError('dialog.action must be accept or dismiss');
  if (d.types !== undefined && (!Array.isArray(d.types) || d.types.length === 0 || d.types.some((t) => !DIALOG_TYPES.has(t as string)))) {
    throw new ValidationError('dialog.types must be a non-empty subset of alert, confirm, prompt, beforeunload');
  }
  if (d.promptText !== undefined && (typeof d.promptText !== 'string' || d.promptText.length > 1000)) throw new ValidationError('dialog.promptText must be a string of at most 1000 chars');
  if (d.maxDialogs !== undefined && (!Number.isInteger(d.maxDialogs) || (d.maxDialogs as number) < 1 || (d.maxDialogs as number) > 10)) {
    throw new ValidationError('dialog.maxDialogs must be an integer 1-10');
  }
}

/** readyWhen on /navigate, /extract, /inspect (see protocol ReadyCondition). */
export function validateReadyWhen(v: unknown): void {
  if (v === undefined) return;
  if (!isObj(v)) throw new ValidationError('readyWhen must be an object');
  onlyKeys(v, ['selector', 'textContains', 'response', 'timeoutMs'], 'readyWhen');
  if (v.selector === undefined && v.textContains === undefined && v.response === undefined) {
    throw new ValidationError('readyWhen needs at least one of selector, textContains, response');
  }
  if (v.selector !== undefined && (typeof v.selector !== 'string' || v.selector.length === 0 || v.selector.length > 2000)) {
    throw new ValidationError('readyWhen.selector must be a non-empty string of at most 2000 chars');
  }
  if (v.textContains !== undefined && (typeof v.textContains !== 'string' || v.textContains.length === 0 || v.textContains.length > 500)) {
    throw new ValidationError('readyWhen.textContains must be a non-empty string of at most 500 chars');
  }
  if (v.response !== undefined) {
    const r = v.response;
    if (!isObj(r)) throw new ValidationError('readyWhen.response must be an object');
    onlyKeys(r, ['urlContains', 'status'], 'readyWhen.response');
    if (typeof r.urlContains !== 'string' || r.urlContains.length === 0 || r.urlContains.length > 2000) {
      throw new ValidationError('readyWhen.response.urlContains must be a non-empty string of at most 2000 chars');
    }
    if (r.status !== undefined) int(r, 'status', 100, 599, 'readyWhen.response');
  }
  if (v.timeoutMs !== undefined && (typeof v.timeoutMs !== 'number' || !Number.isFinite(v.timeoutMs) || v.timeoutMs < 0)) {
    throw new ValidationError('readyWhen.timeoutMs must be a non-negative number');
  }
}

export function validateRequireOrigins(v: string[] | undefined): void {
  if (v === undefined) return;
  if (v.length === 0) throw new ValidationError('requireOrigins must not be empty when present');
  for (const o of v) {
    if (o === '*' || normalizeOrigin(o) === null) throw new ValidationError(`requireOrigins entry is not a valid origin: ${o}`);
  }
}
