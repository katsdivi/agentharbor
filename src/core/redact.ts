/**
 * Redaction for logs and every MCP response. Two layers:
 *  1. exact known secret values registered at runtime (passwords, tokens, keys);
 *  2. patterns for credential-shaped strings.
 */
const known = new Set<string>();

const TOKENISH = /^(?=.*[0-9])[A-Za-z0-9_\-.~%=+]{16,}$|^[A-Za-z0-9_\-.~%=+]{32,}$/;
/** Hide token-like path segments (/confirm/<token>), not just query strings. */
export function scrubPath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (TOKENISH.test(seg) ? '[redacted]' : seg))
    .join('/');
}

/**
 * Register an exact value for redaction. Default minimum length 6 (shorter
 * values would over-redact ordinary text); verification codes pass 4 since
 * 4-5 digit codes are common. A registered short code may also hide an
 * identical number elsewhere in later output of this process - the safe side.
 */
export function registerSecret(value: string | null | undefined, minLength = 6): void {
  if (value && value.length >= minLength) known.add(value);
}

export function forgetSecret(value: string | null | undefined): void {
  if (value) known.delete(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/apify_api_[A-Za-z0-9]{20,}/g, '[REDACTED:apify_token]'],
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s"',]+/gi, '$1[REDACTED]'],
  [/(x-api-key\s*[:=]\s*)[^\s"',]+/gi, '$1[REDACTED]'],
  // Query/fragment parameters whose name is or ends in a credential word: token, access_token,
  // id_token, refresh_token, client_secret, X-Amz-Signature, session_id, ... (OAuth implicit
  // flows put tokens in the #fragment, so '#' starts a parameter too).
  [/([?&#;](?:[\w.-]*[_-])?(?:token|api[_-]?key|apikey|password|passwd|pass|secret|sig|signature|code|session(?:[_-]?id)?|auth)=)[^&#;\s"']+/gi, '$1[REDACTED]'],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[REDACTED]@'],
];

export function redact(text: string): string {
  let out = text;
  for (const s of known) if (out.includes(s)) out = out.split(s).join('[REDACTED]');
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep-redact any JSON-like value (strings only; structure preserved). */
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === 'object' && !(v instanceof Buffer)) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      o[k] = /^(password|token|apiKey|secret|cookie|cookies|storageState|authorization)$/i.test(k) ? '[REDACTED]' : redactDeep(val);
    }
    return o as T;
  }
  return v;
}

/** Strip query and fragment: URLs of verification links often carry one-time tokens. */
export function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${scrubPath(x.pathname)}${x.search ? '?[query]' : ''}`;
  } catch {
    return '[invalid-url]';
  }
}
