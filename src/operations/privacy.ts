/**
 * Saved operations are private by default.
 *
 * A learned request can carry account-specific literals that are not
 * credentials: a user id or workspace id in the path, the account's email in a
 * query, header or body, an id the page embedded. The vendored learner only
 * turns live cookie/storage values and credential-shaped fields into
 * references, so these would otherwise be stored in the spec as constants.
 *
 *  - Account operations: every such literal in the request becomes an
 *    "account constant", a `session:rba-account/<n>` reference whose value is
 *    kept in the vault-encrypted private record (bound to the operation id and
 *    its account), never in the spec. A literal that cannot be turned into a
 *    reference (in the trigger URL, a description, a JSON key, a non-string
 *    JSON value) refuses the save.
 *  - Public operations (learned in a session without an account): any
 *    private-looking literal refuses the save. Private-looking: a value known
 *    to be private (account emails and inbox ids in this registry, cookie and
 *    storage values of the learning session), or one shaped like an email,
 *    UUID, JWT or long random token. Places a param fills are blank in the
 *    stored spec and do not count.
 *
 * There is no export: operation_list returns the review summary with
 * private-looking literals redacted, never the request template. Messages
 * that could quote captured URLs (learner warnings, errors, repair reasons)
 * go through redactPrivate first.
 */
import type { Ctx } from '../core/context.js';
import { escapeTemplate, escapeValue, setAt, templateRefs, walk, type Step } from '../vendor/api-anything/codec.js';
import { registerSecret } from '../core/redact.js';
import { highEntropy, opaqueToken } from '../vendor/api-anything/secrets.js';
import type { Operation, Request, Slot } from '../vendor/api-anything/spec.js';

/** Rules version stored with each operation (operations.privacy_version). */
export const PRIVACY_VERSION = 1;
/** Ref names of account constants: `session:rba-account/<n>`, values in the private record. */
export const ACCOUNT_REF = 'rba-account/';

export type PrivateKind = 'known private value' | 'email address' | 'UUID' | 'JWT' | 'long token' | 'numeric id' | 'id';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const RUN = /[A-Za-z0-9_-]{16,}/g;

const tokenLike = (s: string) => opaqueToken(s) || /^[0-9a-f]{24,}$/i.test(s);

function decodeForms(text: string): string[] {
  const out = new Set([text]);
  for (const t of [text, text.replace(/\+/g, ' ')]) {
    try {
      out.add(decodeURIComponent(t));
    } catch {
      /* not encoded */
    }
  }
  return [...out];
}

/** Values known to be private (normalised, 4+ chars), longest first. */
export class KnownValues {
  private readonly values: string[];
  constructor(values: Iterable<string | null | undefined>) {
    const set = new Set<string>();
    for (const v of values) if (typeof v === 'string' && v.trim().length >= 4) set.add(v.trim());
    this.values = [...set].sort((a, b) => b.length - a.length);
  }
  with(more: Iterable<string | null | undefined>): KnownValues {
    return new KnownValues([...this.values, ...more]);
  }
  list(): readonly string[] {
    return this.values;
  }
}

/**
 * Private values this install knows: every account's email and inbox id, plus
 * (when given) the learning session's cookie and storage values.
 */
export function knownPrivateValues(ctx: Ctx, extra: Iterable<string | null | undefined> = []): KnownValues {
  const rows = ctx.db.all<{ email: string | null; inbox_id: string | null }>('SELECT email, inbox_id FROM accounts');
  return new KnownValues([...rows.flatMap((r) => [r.email, r.inbox_id]), ...extra]);
}

export interface Hit {
  kind: PrivateKind;
  /** The literal as it appears in `text` (or a decoded form of it). */
  value: string;
}

/**
 * Private-looking literals in `text`. `strict` (public operations, and any
 * place that cannot become a reference): known values, emails, UUIDs, JWTs,
 * long random tokens. Otherwise (account requests, converted to constants)
 * also numeric ids (6+ digits) and mixed ids (6+ chars with 2+ digits and a
 * letter), judged per token.
 */
export function findPrivate(text: string, known: KnownValues, strict: boolean): Hit[] {
  const hits: Hit[] = [];
  const forms = decodeForms(text);
  for (const k of known.list()) {
    const lk = k.toLowerCase();
    if (forms.some((f) => f.toLowerCase().includes(lk))) hits.push({ kind: 'known private value', value: k });
  }
  for (const f of forms) {
    for (const m of f.matchAll(EMAIL)) hits.push({ kind: 'email address', value: m[0] });
    for (const m of f.matchAll(UUID)) hits.push({ kind: 'UUID', value: m[0] });
    for (const m of f.matchAll(JWT)) hits.push({ kind: 'JWT', value: m[0] });
    for (const m of f.matchAll(RUN)) if (tokenLike(m[0])) hits.push({ kind: 'long token', value: m[0] });
    if (!strict) {
      for (const t of f.split(/[^A-Za-z0-9_-]+/)) {
        if (/^\d{6,}$/.test(t)) hits.push({ kind: 'numeric id', value: t });
        else if (t.length >= 6 && /[A-Za-z]/.test(t) && (t.match(/\d/g)?.length ?? 0) >= 2) hits.push({ kind: 'id', value: t });
      }
    }
  }
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.value) ? false : (seen.add(h.value), true)));
}

/**
 * Whether a stored value is a true secret (a token, JWT, random-looking
 * credential) as opposed to a plain account identifier (email, UUID, numeric
 * or word-like id). Only secrets go to the process-wide redactor; identifiers
 * are redacted locally in operation outputs, so the account's email still
 * shows in account tools and in returned page data.
 */
export function secretLike(v: string): boolean {
  const t = v.trim();
  if (t.length < 8) return false;
  if (new RegExp(`^${EMAIL.source}$`).test(t) || new RegExp(`^${UUID.source}$`).test(t) || /^\d+$/.test(t)) return false;
  return new RegExp(JWT.source).test(t) || /^Bearer\s+\S{16,}/i.test(t) || tokenLike(t) || highEntropy(t);
}

/** Register only the secret-like values with the process-wide redactor (see secretLike). */
export function registerSecrets(values: Iterable<string>): void {
  for (const v of values) if (secretLike(v)) registerSecret(v);
}

/** Replace private-looking literals (known values, emails, UUIDs, JWTs, tokens) in free text. */
export function redactPrivate(text: string, known: KnownValues, loose = false): string {
  let out = text;
  if (loose) {
    // Account scope: numeric ids (6+ digits) and mixed ids (6+ chars, 2+ digits and a letter) too.
    out = out.replace(/[A-Za-z0-9_-]{6,}/g, (t) => (/^\d+$/.test(t) || (/[A-Za-z]/.test(t) && (t.match(/\d/g)?.length ?? 0) >= 2) ? '[private]' : t));
  }
  for (const k of known.list()) {
    for (const form of new Set([k, encodeURIComponent(k), JSON.stringify(k).slice(1, -1)])) {
      out = out.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[private]');
    }
  }
  out = out.replace(EMAIL, '[private]').replace(UUID, '[private]').replace(JWT, '[private]');
  out = out.replace(/[A-Za-z0-9_-]+(?:%40|@)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[private]');
  return out.replace(RUN, (m) => (tokenLike(m) ? '[private]' : m));
}

/** Deep redactPrivate over strings and object keys of a JSON-like value. Returns the count of changed strings. */
export function redactPrivateDeep<T>(v: T, known: KnownValues): { value: T; redacted: number } {
  let n = 0;
  const r = (s: string) => {
    const x = redactPrivate(s, known);
    if (x !== s) n++;
    return x;
  };
  const visit = (x: unknown): unknown => {
    if (typeof x === 'string') return r(x);
    if (Array.isArray(x)) return x.map(visit);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, c]) => [r(k), visit(c)]));
    return x;
  };
  const value = visit(v) as T;
  return { value, redacted: n };
}

// ------------------------------------------------------------------ the request

const stepKey = (at: Step[]) => JSON.stringify(at);
const isPrefix = (p: Step[], at: Step[]) => p.length <= at.length && p.every((s, i) => at[i] === s);
/** Template text without its `{param}`/`{session:x}` holes. */
const outsideHoles = (t: string) => t.replace(/\{\{|\}\}/g, '').replace(/\{[^{}]+\}/g, ' ');

/** The names inside a step path (query keys, header names, JSON keys), not values. */
function stepNames(at: Step[]): string[] {
  return at.flatMap((s) => {
    if (s.startsWith('json:')) return s.slice(5).split('/').filter(Boolean).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
    const i = s.indexOf(':');
    return i < 0 || s.startsWith('path:') ? [] : [s.slice(i + 1)];
  });
}

export interface Finding {
  /** Where the literal is (names and positions only, never the value). */
  where: string;
  kind: PrivateKind;
}

export interface Privatized {
  operation: Operation;
  /** Account constants: ref name (after "session:") -> value, for the encrypted private record. */
  constants: Record<string, string>;
  /** Literals that could not be turned into references: the save is refused. */
  findings: Finding[];
}

/**
 * Turn every private-looking literal in an account operation's request into
 * an account constant. `op` must already have its param places blanked
 * (stripExamples). Leaves a param or ref fills, and volatile anchors (site
 * constants the learner found in the site's own scripts), are left alone.
 */
export function privatizeAccountOperation(op: Operation, known: KnownValues): Privatized {
  const constants: Record<string, string> = {};
  const findings: Finding[] = [];
  const byValue = new Map<string, string>();
  const refFor = (value: string) => {
    let name = byValue.get(value);
    if (!name) {
      name = `${ACCOUNT_REF}${byValue.size + 1}`;
      byValue.set(value, name);
      constants[name] = value;
    }
    return name;
  };
  const taken = op.slots.map((s) => s.at);
  const volatile = op.volatile.map((v) => v.at);
  let request: Request = op.request;
  const slots: Slot[] = [];

  // 1. Templated slots (a param or ref inside a longer leaf, e.g. a Referer): private text outside the holes becomes a hole.
  for (const s of op.slots) {
    if (s.template === undefined) {
      slots.push(s);
      continue;
    }
    let template = s.template;
    for (const h of findPrivate(outsideHoles(template), known, false)) {
      const form = s.escape ? escapeValue(h.value, s.escape) : h.value;
      const lit = escapeTemplate(form);
      if (form !== h.value || !template.includes(lit)) {
        findings.push({ where: `request ${s.at.join(' > ')} (text around the ${s.param ? `param "${s.param}"` : 'reference'})`, kind: h.kind });
        continue;
      }
      template = template.split(lit).join(`{session:${refFor(h.value)}}`);
    }
    slots.push({ ...s, template });
  }

  // 2. Literal leaves: a leaf holding a private-looking literal becomes one account constant (its whole text).
  for (const leaf of walk(op.request)) {
    if (taken.some((t) => isPrefix(t, leaf.at) || isPrefix(leaf.at, t)) || volatile.some((v) => isPrefix(v, leaf.at))) continue;
    for (const n of stepNames(leaf.at)) {
      for (const h of findPrivate(n, known, true)) findings.push({ where: `request ${leaf.at[0]!.split(':')[0]} key name`, kind: h.kind });
    }
    if (leaf.container) continue;
    const hits = findPrivate(leaf.value, known, false);
    if (!hits.length) continue;
    if (leaf.type !== 'string') {
      findings.push({ where: `request ${leaf.at.join(' > ')} (a ${leaf.type} JSON value)`, kind: hits[0]!.kind });
      continue;
    }
    const name = refFor(leaf.value);
    slots.push({ ref: `session:${name}`, at: leaf.at });
    taken.push(leaf.at);
    request = setAt(request, leaf.at, '');
  }

  // 3. The match: a path segment that became a constant, or looks private, is a wildcard.
  const pathSlots = new Set(slots.filter((s) => s.ref?.startsWith(`session:${ACCOUNT_REF}`) && s.at.length === 1 && s.at[0]!.startsWith('path:')).map((s) => Number(s.at[0]!.slice(5))));
  let match = op.match;
  if (match.path) {
    match = {
      ...match,
      path: match.path
        .split('/')
        .map((seg, i) => (i > 0 && (pathSlots.has(i - 1) || findPrivate(seg, known, false).length) ? '*' : seg))
        .join('/'),
    };
  }
  return { operation: { ...op, request, slots, match }, constants, findings };
}

/** Replace private-looking segments of shape key paths (a.b.c) with "*". */
export function sanitizeShape(shape: Record<string, string>, known: KnownValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(shape)) {
    const key = k
      .split('.')
      .map((seg) => {
        const bare = seg.replace(/\[\]$/, '');
        return findPrivate(bare, known, false).length ? `*${seg.endsWith('[]') ? '[]' : ''}` : seg;
      })
      .join('.');
    out[key] = t;
  }
  return out;
}

/**
 * Every private-looking literal left in what would be stored (strict rules):
 * request leaves and key names, slot templates (outside holes), trigger,
 * match, response recipe, params, description, result shape. Positions a
 * param or ref fills are blank; volatile anchors are site constants.
 */
export function scanStored(op: Operation, resultShape: Record<string, string>, known: KnownValues): Finding[] {
  const out: Finding[] = [];
  const add = (where: string, text: string | undefined) => {
    if (!text) return;
    for (const h of findPrivate(text, known, true)) out.push({ where, kind: h.kind });
  };
  const volatile = op.volatile.map((v) => v.at);
  const filled = op.slots.map((s) => s.at);
  for (const leaf of walk(op.request)) {
    for (const n of stepNames(leaf.at)) add(`request ${leaf.at[0]!.split(':')[0]} key name`, n);
    if (leaf.container || volatile.some((v) => isPrefix(v, leaf.at)) || filled.some((f) => stepKey(f) === stepKey(leaf.at))) continue;
    add(`request ${leaf.at.join(' > ')}`, leaf.value);
  }
  try {
    add('request host', new URL(op.request.url).host);
  } catch {
    /* schema-checked elsewhere */
  }
  for (const s of op.slots) if (s.template) add(`request ${s.at.join(' > ')} (template)`, outsideHoles(s.template));
  add('trigger.url', outsideHoles(op.trigger.url));
  add('trigger.softFrom', op.trigger.softFrom && outsideHoles(op.trigger.softFrom));
  for (const [i, st] of (op.trigger.steps ?? []).entries()) {
    add(`trigger.steps[${i}].selector`, st.selector && outsideHoles(st.selector));
    add(`trigger.steps[${i}].value`, st.value && outsideHoles(st.value));
  }
  for (const [k, v] of Object.entries(op.match)) add(`match.${k}`, typeof v === 'string' ? v : undefined);
  add('response recipe', JSON.stringify({ ...op.response, shape: undefined }));
  add('response shape', Object.keys(op.response.shape ?? {}).join('\n'));
  add('result shape', Object.keys(resultShape).join('\n'));
  add('description', op.description);
  for (const p of op.params) add(`param "${p.name}"`, JSON.stringify({ n: p.name, d: p.description, def: p.default, pat: p.pattern, h: p.hint }));
  add('public names', (op.public ?? []).join('\n'));
  for (const s of op.slots) if (s.ref && !s.ref.startsWith(`session:${ACCOUNT_REF}`)) add('reference name', s.ref.slice(s.ref.indexOf(':') + 1));
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.where + f.kind) ? false : (seen.add(f.where + f.kind), true)));
}

export function describeFindings(findings: Finding[], known: KnownValues): string {
  return findings
    .slice(0, 8)
    .map((f) => `${redactPrivate(f.where, known)}: ${f.kind}`)
    .join('; ');
}

/** Every template ref a slot set uses (for checks that constants are all filled). */
export function constantRefs(slots: Slot[]): string[] {
  const out = new Set<string>();
  for (const s of slots) {
    if (s.ref?.startsWith(`session:${ACCOUNT_REF}`)) out.add(s.ref.slice(8));
    for (const r of templateRefs(s.template ?? '')) if (r.startsWith(`session:${ACCOUNT_REF}`)) out.add(r.slice(8));
  }
  return [...out];
}
