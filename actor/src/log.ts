/**
 * Minimal structured logger. By design it only accepts primitive fields and
 * callers only pass route names, durations, status/error codes, host names and
 * URLs passed through `safeUrlForLog` (query string/fragment/credentials
 * stripped). Never pass request bodies, fill values, cookies, storage state,
 * headers or tokens here.
 */
type Field = string | number | boolean | null | undefined;

const MAX_FIELD = 300;

function fmt(v: Field): string {
  if (v === undefined) return '';
  let s = String(v);
  if (s.length > MAX_FIELD) s = `${s.slice(0, MAX_FIELD)}…`;
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

export function log(event: string, fields: Record<string, Field> = {}): void {
  const parts = [`[rba-worker] ${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) parts.push(`${k}=${fmt(v)}`);
  }
  process.stdout.write(`${parts.join(' ')}\n`);
}

/** Raw line (used for the RBA_WORKER_LISTENING marker). */
export function line(s: string): void {
  process.stdout.write(`${s}\n`);
}
