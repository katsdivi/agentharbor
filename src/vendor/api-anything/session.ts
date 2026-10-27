/**
 * DERIVED FILE (not a verbatim copy). The pure cookie helpers of upstream
 * `src/session.ts` at api-anything 4a785e8d9e72a00e2dddc0dc56569a86826df07b,
 * copied unchanged:
 *   - `Session` (upstream lines 19-26)
 *   - `expired` (line 139), `domainMatch` / `pathMatch` / `cookiesFor` (lines 163-184)
 *   - `parseCookieHeader`, `AUTH_COOKIE`, `loggedIn` (lines 260-282)
 *
 * Everything else upstream keeps in that file is deliberately NOT included:
 * the ~/.api-anything file store, file locks, capture pruning, mergeCapture,
 * and `siteOf` / `cookieValue` / `parseSetCookie` (they need `tldts`).
 * This plugin keeps cookies only in the account vault and the worker's
 * browser context; nothing here touches the file system or the network.
 *
 * Copyright (c) 2026 Tianjun Zheng. MIT License, see ./LICENSE.
 */
import type { StoredCookie } from "./types.js";

export interface Session {
  cookies: StoredCookie[];
  /** values of session: refs (auth/anti-bot headers), refreshed by every capture */
  values: Record<string, string>;
  /** where the cookies came from: "<browser>:<profile>" (import), "window", or "file"; drives self-heal re-import */
  source?: string;
  updatedAt?: string;
}

const expired = (c: StoredCookie, now: number) => c.expires > 0 && c.expires * 1000 <= now;

function domainMatch(host: string, domain: string): boolean {
  const d = domain.toLowerCase();
  // Playwright marks domain cookies with a leading dot; without it the cookie is host-only.
  if (d.startsWith(".")) return host === d.slice(1) || host.endsWith(d);
  return host === d;
}

function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/");
}

/** RFC 6265 domain/path/secure/expiry matching, longest path first. */
export function cookiesFor(cookies: StoredCookie[], url: string, now = Date.now()): StoredCookie[] {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const secureOk = u.protocol === "https:" || host === "localhost" || host === "127.0.0.1";
  return cookies
    .filter((c) => domainMatch(host, c.domain) && pathMatch(u.pathname || "/", c.path || "/"))
    .filter((c) => (!c.secure || secureOk) && !expired(c, now))
    .sort((a, b) => (b.path || "/").length - (a.path || "/").length);
}

/** Parse a raw Cookie header ("a=1; b=\"x\"") into a name -> value map. */
export function parseCookieHeader(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

// ponytail: name heuristic for "logged in"; a site's spec can pin exact names via loginCookies.
export const AUTH_COOKIE =
  /^(auth_token|sessionid|session_id|li_at|sid|ssid|__secure-\dpsid|user_session|reddit_session|remember_\w+|\w*_session|\w*_sess)$/i;

export function loggedIn(cookies: StoredCookie[], loginCookies?: string[], now = Date.now()): boolean {
  const live = cookies.filter((c) => !expired(c, now) && c.value);
  if (loginCookies?.length) return loginCookies.every((n) => live.some((c) => c.name === n));
  return live.some(
    (c) => (AUTH_COOKIE.test(c.name) && c.value.length >= 8) || (c.name === "logged_in" && c.value === "yes"),
  );
}
