/**
 * What a person reviews before a learned operation may be called, and the
 * cases refused outright.
 *
 * Read-only is NEVER inferred from the HTTP method. It is established by:
 *  1. the learner's explicit `readOnly: true` declaration (there is no write learning), and
 *  2. a human review of exactly this spec (operation_review with its sha256),
 *     after seeing this summary and its warnings.
 * Signals that something may change state are warnings for that review; a
 * GraphQL mutation, or a method the worker does not send, is refused.
 */
import { walk } from '../vendor/api-anything/codec.js';
import type { Operation } from '../vendor/api-anything/spec.js';

const SENDABLE = new Set(['GET', 'HEAD', 'POST']);
const MUTATING_WORD = /(^|[^a-z])(delete|remove|destroy|create|insert|update|edit|save|submit|send|post|publish|buy|purchase|order|checkout|pay|cancel|unsubscribe|subscribe|logout|signout|sign-out|log-out|transfer|approve|confirm|reset|vote|like|follow|upload)([^a-z]|$)/i;

export interface ReviewSummary {
  method: string;
  host: string;
  path: string;
  queryKeys: string[];
  bodyPresent: boolean;
  /** Where the request body carries data (step paths), no values. */
  bodyFields: string[];
  headerNames: string[];
  /** Each param with every place in the request it fills. */
  params: Array<{ name: string; type: string; places: string[][] }>;
  /** References filled from the account's browser session at call time (names only). */
  references: Array<{ ref: string; at: string[] }>;
  trigger: { url: string; steps: Array<{ action: string; selector?: string }> };
  minTier: number;
  warnings: string[];
}

export function reviewSummary(op: Operation): ReviewSummary {
  const u = new URL(op.request.url);
  const leaves = walk(op.request);
  const bodyFields = leaves.filter((l) => !l.container && /^(json|form|body|b64)/.test(l.at[0] ?? '')).map((l) => l.at.join(' > ')).slice(0, 50);
  const warnings: string[] = [];
  const method = op.request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') warnings.push(`method ${method}: confirm this request only reads data (many search APIs use POST; some POSTs change state)`);
  if (op.request.body !== undefined && op.request.body !== '') warnings.push('the request has a body: check below which fields it carries');
  if (MUTATING_WORD.test(u.pathname) || MUTATING_WORD.test(op.request.body ?? '')) warnings.push('the path or body contains a word that often names a state-changing action');
  const steps = op.trigger.steps ?? [];
  if (steps.some((s) => s.action === 'click' || s.action === 'press')) {
    warnings.push('the trigger clicks or presses keys in the page; it runs again at learning, browser fallback and repair. Make sure it only reads.');
  }
  if (op.minTier === 3) warnings.push('the request carries a per-request value (nonce or signature): every call runs the page in the browser (tier 3)');
  return {
    method,
    host: u.host,
    path: u.pathname,
    queryKeys: [...u.searchParams.keys()],
    bodyPresent: op.request.body !== undefined && op.request.body !== '',
    bodyFields,
    headerNames: Object.keys(op.request.headers),
    params: op.params.map((p) => ({ name: p.name, type: p.type, places: op.slots.filter((s) => s.param === p.name).map((s) => s.at) })),
    references: op.slots.filter((s) => s.ref).map((s) => ({ ref: s.ref!, at: s.at })),
    trigger: { url: op.trigger.url, steps: steps.map((s) => ({ action: s.action, ...(s.selector ? { selector: s.selector } : {}) })) },
    minTier: op.minTier,
    warnings,
  };
}

/** Refusals that no review can override. Returns the reason, or null. */
export function refusal(op: Operation): string | null {
  const method = op.request.method.toUpperCase();
  if (!SENDABLE.has(method)) return `method ${method} is not supported for saved read operations (only GET, HEAD and POST are sent); keep it in a reviewed workflow`;
  if (!op.readOnly) return 'only read operations can be saved';
  const body = op.request.body ?? '';
  if (/(^|["'{\s,:])mutation(\s|\{|\()/.test(body) || /[?&]query=mutation\b/i.test(op.request.url)) {
    return 'the request is a GraphQL mutation; mutations stay in reviewed workflows';
  }
  return null;
}
