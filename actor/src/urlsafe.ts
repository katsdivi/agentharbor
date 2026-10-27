/**
 * URL scrubbing for logs and error messages. One-time tokens appear in query
 * strings and also in path segments (e.g. /confirm/<token>), so both are hidden.
 */
const TOKENISH = /^(?=.*[0-9])[A-Za-z0-9_\-.~%=+]{16,}$|^[A-Za-z0-9_\-.~%=+]{32,}$/;

export function scrubPath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (TOKENISH.test(seg) ? '[redacted]' : seg))
    .join('/');
}

export function safeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return `${u.protocol}…`;
    return `${u.protocol}//${u.host}${scrubPath(u.pathname)}${u.search ? '?[query]' : ''}`;
  } catch {
    return '<invalid-url>';
  }
}

/** Replace every URL inside free text (e.g. Playwright error messages). */
export function scrubUrlsInText(text: string): string {
  return text.replace(/\b(?:https?|wss?|file|ftp):\/\/[^\s"'<>)]+/gi, (m) => safeUrlForLog(m));
}
