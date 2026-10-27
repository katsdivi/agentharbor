/**
 * Filling an operation's request template for one call.
 *
 * `buildRequest` and `coerce` follow upstream api-anything `src/http.ts`
 * (rev 4a785e8, MIT, Copyright (c) 2026 Tianjun Zheng), adapted:
 *  - nothing is sent from here; the filled request goes to the worker's /fetch;
 *  - no Cookie header is built: the worker's browser context sends its own cookies;
 *  - cookie: refs elsewhere in the request (a CSRF cookie copied into a header)
 *    resolve only from cookies the browser would send to that URL
 *    (domain/path-scoped), never from another site's cookies;
 *  - a missing ref value is an error for that call (no blank credential is sent).
 */
import { asText, fillSlotTemplate, getAt, setAt, templateRefs, walk } from '../vendor/api-anything/codec.js';
import { cookiesFor } from '../vendor/api-anything/session.js';
import type { Operation, Param, Request } from '../vendor/api-anything/spec.js';
import type { StoredCookie } from '../vendor/api-anything/types.js';

export interface RefSource {
  cookies: StoredCookie[];
  /** session: ref values (slot ref after "session:"). */
  values: Record<string, string>;
}

/** A call's args failed the operation's params: nothing is sent. */
export class InputError extends Error {}

/** The session has no value for a cookie:/session: reference: nothing is sent at tier 1. */
export class MissingRefError extends Error {}

function coerce(p: Param, v: unknown): unknown {
  const bad = () => new InputError(`param "${p.name}" must be ${p.type}, got ${JSON.stringify(v)}`);
  switch (p.type) {
    case 'number':
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) {
        const n = Number(v);
        if (!Number.isSafeInteger(Math.trunc(n))) throw new InputError(`param "${p.name}" would lose precision`);
        return n;
      }
      throw bad();
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      throw bad();
    case 'object':
    case 'array':
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v);
      } catch {
        throw bad();
      }
    default:
      return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

function transform(v: string, t: 'strip-quotes' | 'url-decode' | undefined): string {
  if (t === 'strip-quotes') return v.replace(/^"|"$/g, '');
  if (t === 'url-decode') {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return v;
}

export function resolveRef(ref: string, src: RefSource, url: string): string | undefined {
  const name = ref.slice(ref.indexOf(':') + 1);
  if (ref.startsWith('cookie:')) return cookiesFor(src.cookies, url).find((c) => c.name === name)?.value;
  return src.values[name];
}

/** Every cookie:/session: ref an operation uses. */
export function refsOf(op: Operation): string[] {
  const out = new Set<string>();
  for (const s of op.slots) {
    if (s.ref) out.add(s.ref);
    for (const r of templateRefs(s.template ?? '')) if (/^(cookie|session):/.test(r)) out.add(r);
  }
  return [...out];
}

/** Header names that carry a ref's value (dropped on a cross-origin redirect). */
export function sensitiveHeaders(op: Operation): string[] {
  const out = new Set<string>(['authorization']);
  for (const s of op.slots) {
    const holds = !!s.ref || templateRefs(s.template ?? '').some((r) => /^(cookie|session):/.test(r));
    if (holds && s.at[0]!.startsWith('header:')) out.add(s.at[0]!.slice(7).toLowerCase());
  }
  return [...out];
}

/** Validate and coerce args against the operation's params. Unknown args are refused. */
export function checkArgs(op: Operation, args: Record<string, unknown>): Record<string, unknown> {
  const known = new Set(op.params.map((p) => p.name));
  for (const k of Object.keys(args)) if (!known.has(k)) throw new InputError(`unknown param "${k}"; this operation takes: ${[...known].join(', ') || 'none'}`);
  const vals: Record<string, unknown> = {};
  for (const p of op.params) {
    const v = args[p.name] ?? p.default;
    if (v === undefined) {
      if (p.required) throw new InputError(`missing required param "${p.name}"`);
      continue;
    }
    vals[p.name] = coerce(p, v);
    if (p.pattern !== undefined && !new RegExp(`^(?:${p.pattern})$`).test(asText(vals[p.name]))) {
      throw new InputError(`param "${p.name}" must be ${p.hint ?? `a value matching /${p.pattern}/`}`);
    }
  }
  return vals;
}

export function buildRequest(op: Operation, vals: Record<string, unknown>, src: RefSource): Request {
  let req: Request = { ...op.request, method: op.request.method.toUpperCase(), headers: { ...op.request.headers } };
  let leafTypes: Map<string, string> | undefined;
  const stringLeaf = (at: string[]) => {
    leafTypes ??= new Map(walk(op.request).map((l) => [JSON.stringify(l.at), l.type]));
    return leafTypes.get(JSON.stringify(at)) === 'string';
  };
  delete req.headers.cookie;
  for (const slot of op.slots) {
    const name = slot.param ?? slot.ref!;
    let v: unknown = slot.param !== undefined ? vals[slot.param] : resolveRef(slot.ref!, src, op.request.url);
    if (v === undefined) {
      if (slot.param !== undefined) continue; // optional param left out
      throw new MissingRefError(`the session has no value for the ${slot.ref!.split(':')[0]} reference "${slot.ref!.slice(slot.ref!.indexOf(':') + 1)}" (logged out, or the value changed); nothing was sent`);
    }
    if (slot.ref) v = transform(v as string, slot.transform);
    if (slot.template !== undefined) {
      const escape = slot.escape ?? (slot.param && /^header:(referer|origin)$/i.test(slot.at[0]!) ? 'url' : undefined);
      const refs = Object.fromEntries(templateRefs(slot.template).map((r) => [r, resolveRef(r, src, op.request.url) ?? '']));
      v = fillSlotTemplate(slot.template, { ...refs, ...vals, [name]: v }, escape);
    } else if (typeof v !== 'string' && typeof v !== 'object' && slot.at.at(-1)!.startsWith('json:') && stringLeaf(slot.at)) {
      v = asText(v);
    }
    req = setAt(req, slot.at, v);
  }
  for (const [k, h] of Object.entries(req.headers)) if (/[^\x00-\x7f]/.test(h)) req.headers[k] = h.replace(/[^\x00-\x7f]+/g, encodeURIComponent);
  for (const [k, h] of Object.entries(req.headers)) if (/[\r\n\0]/.test(h)) throw new InputError(`header ${k} would contain a line break`);
  return req;
}

/**
 * Whether a captured request carries the call's args at the operation's param
 * places (tier 3 accepts a page's own answer only then; otherwise it could be
 * another query's data).
 */
export function carriesArgs(op: Operation, req: Request, vals: Record<string, unknown>): boolean {
  const norm = (s: string) => {
    let t = s;
    for (let i = 0; i < 3; i++) {
      try {
        const d = decodeURIComponent(t.replace(/\+/g, ' '));
        if (d === t) break;
        t = d;
      } catch {
        break;
      }
    }
    return t.toLowerCase();
  };
  for (const slot of op.slots) {
    if (slot.param === undefined || vals[slot.param] === undefined) continue;
    let leaf: unknown;
    try {
      leaf = getAt(req, slot.at);
    } catch {
      return false;
    }
    if (leaf === undefined) return false;
    if (!norm(asText(leaf)).includes(norm(asText(vals[slot.param])))) return false;
  }
  return true;
}
