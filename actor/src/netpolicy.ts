/**
 * Network policy for the remote browser worker.
 *
 * Two layers use these functions:
 *   1. The Playwright `context.route` / `routeWebSocket` handlers (browser.ts):
 *      scheme check, hostname/IP-literal block, DNS-resolved block, and the
 *      main-frame origin allowlist. They give precise error reasons but are
 *      only invoked for the FIRST request of a redirect chain (empirically
 *      verified with Playwright 1.64 / Chromium: later redirect hops are
 *      followed natively without calling the route handler).
 *   2. The in-process policy forward proxy (policyproxy.ts) through which
 *      Chromium sends ALL traffic (including every redirect hop, subresource,
 *      WebSocket and worker request). It applies the private-address block at
 *      connection time.
 *
 * DNS rebinding: in direct mode the policy proxy connects to the exact IP
 * address it just validated, so a hostname cannot re-resolve to a private
 * address between check and connect for traffic that goes through the proxy.
 * The route-handler-level DNS check is advisory only (resolve-then-connect
 * TOCTOU applies to it). In proxy modes (datacenter/residential) the upstream
 * proxy resolves DNS itself; we still resolve locally and block private
 * results (defense in depth), but a hostname that resolves differently at the
 * upstream proxy is outside our control - that is a residual risk. The
 * upstream proxy cannot reach the worker container's private network though.
 */
import dns from 'node:dns';
import net from 'node:net';

export interface NetworkPolicy {
  /** Normalized origins; contains '*' for any public origin. */
  allowedNavigationOrigins: string[];
  /**
   * Origins any request may go to (frames, subresources, fetch/XHR, WebSockets,
   * workers and every redirect hop): navigation origins + configured resource
   * origins (+ the egress-check origin). Entries: exact origins,
   * `scheme://*.host` wildcards, or '*' (any public origin; only when
   * explicitly configured, or when navigation itself is '*').
   */
  allowedResourceOrigins: string[];
  /** Lowercased exact host or host:port entries. */
  allowPrivateHosts: string[];
}

export type PolicyResult = { ok: true } | { ok: false; reason: string };

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Hostname suffix/exact blocks (after lowercasing and trailing-dot strip). */
export function blockedHostnameReason(hostname: string): string | null {
  const h = normalizeHostname(hostname);
  if (h === 'localhost' || h.endsWith('.localhost')) return `hostname ${h} is loopback`;
  if (h === 'metadata' || h === 'metadata.google.internal') return `hostname ${h} is a cloud metadata service`;
  if (h.endsWith('.internal')) return `hostname ${h} is an internal name`;
  return null;
}

export function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

// ---------------------------------------------------------------- IPv4 / IPv6

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map((x) => Number(x));
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}

const V4_BLOCKS: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified/this-network'],
  ['10.0.0.0', 8, 'private (RFC1918)'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private (RFC1918)'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.88.99.0', 24, '6to4 relay anycast (deprecated)'],
  ['192.168.0.0', 16, 'private (RFC1918)'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved/broadcast'],
];

export function privateIpv4Reason(ip: string): string | null {
  if (net.isIPv4(ip) === false) return null;
  const v = ipv4ToInt(ip);
  for (const [base, bits, label] of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((v & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)) return `${ip} is ${label}`;
  }
  return null;
}

/** Expand an IPv6 address (no brackets, no zone) into 8 16-bit groups. */
export function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  // Embedded dotted IPv4 tail: rewrite it as two hex groups.
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    if (!net.isIPv4(last)) return null;
    const v = ipv4ToInt(last);
    s = `${s.slice(0, lastColon + 1)}${((v >>> 16) & 0xffff).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const tail: number[] = [];
  const want = 8;
  let groups: number[];
  if (s.includes('::')) {
    const [a, b] = s.split('::');
    const left = a ? a.split(':').filter((x) => x !== '') : [];
    const right = b ? b.split(':').filter((x) => x !== '') : [];
    const fill = want - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill('0'), ...right].map((x) => parseInt(x, 16));
  } else {
    groups = s.split(':').filter((x) => x !== '').map((x) => parseInt(x, 16));
  }
  groups = [...groups, ...tail];
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
}

export function privateIpv6Reason(ip: string): string | null {
  const g = expandIpv6(ip);
  if (!g) return null;
  const allZeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (g.every((x) => x === 0)) return `${ip} is unspecified`;
  if (allZeroPrefix(7) && g[7] === 1) return `${ip} is loopback`;
  // IPv4-mapped ::ffff:a.b.c.d
  if (allZeroPrefix(5) && g[5] === 0xffff) {
    const r = privateIpv4Reason(v4FromGroups(g[6]!, g[7]!));
    return r ? `${ip} is IPv4-mapped: ${r}` : null;
  }
  // IPv4-translated ::ffff:0:a.b.c.d and IPv4-compatible ::a.b.c.d (deprecated)
  if ((allZeroPrefix(4) && g[4] === 0xffff && g[5] === 0) || allZeroPrefix(6)) {
    const r = privateIpv4Reason(v4FromGroups(g[6]!, g[7]!));
    return `${ip} embeds IPv4${r ? `: ${r}` : ' (deprecated form)'}`;
  }
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    const r = privateIpv4Reason(v4FromGroups(g[6]!, g[7]!));
    if (r) return `${ip} is NAT64: ${r}`;
  }
  // 6to4 2002::/16 embeds IPv4 in groups 1-2
  if (g[0] === 0x2002) {
    const r = privateIpv4Reason(v4FromGroups(g[1]!, g[2]!));
    if (r) return `${ip} is 6to4: ${r}`;
  }
  // Teredo 2001:0::/32 tunnels to an IPv4 server/client pair (one obfuscated); the
  // embedded addresses cannot be trusted, so the whole prefix is refused.
  if (g[0] === 0x2001 && g[1] === 0) return `${ip} is a Teredo tunnel address (2001::/32)`;
  if ((g[0]! & 0xfe00) === 0xfc00) return `${ip} is unique-local (fc00::/7)`;
  if ((g[0]! & 0xffc0) === 0xfe80) return `${ip} is link-local (fe80::/10)`;
  if ((g[0]! & 0xffc0) === 0xfec0) return `${ip} is site-local (fec0::/10)`;
  if ((g[0]! & 0xff00) === 0xff00) return `${ip} is multicast`;
  return null;
}

/** Reason string if the IP literal is non-public, else null. */
export function privateIpReason(ip: string): string | null {
  const h = normalizeHostname(ip);
  if (net.isIPv4(h)) return privateIpv4Reason(h);
  if (net.isIPv6(h.split('%')[0]!)) return privateIpv6Reason(h);
  return null;
}

// ---------------------------------------------------------------- policy

export function normalizeOrigin(o: string): string | null {
  if (o === '*') return '*';
  try {
    const u = new URL(o);
    if (!ALLOWED_SCHEMES.has(u.protocol)) return null;
    if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Normalize a resource-origin entry: exact origin, `scheme://*.host[:port]`, or '*'. */
export function normalizeResourceOrigin(o: string): string | null {
  if (o === '*') return '*';
  const m = /^(https?):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/i.exec(o.trim());
  if (m) return `${m[1]!.toLowerCase()}://*.${m[2]!.toLowerCase()}${m[3] ?? ''}`;
  return normalizeOrigin(o);
}

export function makePolicy(
  input: { allowedNavigationOrigins: string[]; allowedSubresourceOrigins?: string[]; allowPrivateHosts: string[] },
  extraResourceOrigins: string[] = [],
): NetworkPolicy {
  const nav = input.allowedNavigationOrigins.map((o) => normalizeOrigin(o) ?? o);
  const res = new Set<string>();
  for (const o of [...nav, ...(input.allowedSubresourceOrigins ?? []), ...extraResourceOrigins]) {
    const n = normalizeResourceOrigin(o);
    if (n) res.add(n);
  }
  return {
    allowedNavigationOrigins: nav,
    allowedResourceOrigins: [...res],
    allowPrivateHosts: input.allowPrivateHosts.map((h) => h.trim().toLowerCase()),
  };
}

/** http(s) origin equivalent of a URL (ws -> http, wss -> https). */
function httpOrigin(u: URL): { scheme: string; host: string; port: number } {
  const scheme = u.protocol === 'wss:' ? 'https' : u.protocol === 'ws:' ? 'http' : u.protocol.replace(':', '');
  const port = u.port ? Number(u.port) : scheme === 'https' ? 443 : 80;
  return { scheme, host: normalizeHostname(u.hostname), port };
}

function entryMatches(entry: string, scheme: string | null, host: string, port: number): boolean {
  if (entry === '*') return true;
  const m = /^(https?):\/\/(\*\.)?([^:/]+)(?::(\d+))?$/.exec(entry);
  if (!m) return false;
  const eScheme = m[1]!;
  const ePort = m[4] ? Number(m[4]) : eScheme === 'https' ? 443 : 80;
  if (scheme !== null && scheme !== eScheme) return false;
  if (port !== ePort) return false;
  const eHost = normalizeHostname(m[3]!);
  return m[2] ? host.endsWith(`.${eHost}`) : host === eHost;
}

/** Is a request URL (http/https/ws/wss) allowed by the resource policy? */
export function resourceAllowed(policy: NetworkPolicy, u: URL): boolean {
  const o = httpOrigin(u);
  return policy.allowedResourceOrigins.some((e) => entryMatches(e, o.scheme, o.host, o.port));
}

/**
 * Host-level form of the resource policy, for the proxy's CONNECT tunnels where
 * the scheme is not visible: allowed if any allowed origin has this host and port.
 */
export function resourceHostAllowed(policy: NetworkPolicy, hostname: string, port: number): boolean {
  const h = normalizeHostname(hostname);
  return policy.allowedResourceOrigins.some((e) => entryMatches(e, null, h, port));
}

export function defaultPort(protocol: string): number {
  return protocol === 'https:' || protocol === 'wss:' ? 443 : 80;
}

/** Exact match of host or host:port against allowPrivateHosts. */
export function isPrivateHostAllowed(policy: NetworkPolicy, hostname: string, port: number): boolean {
  if (policy.allowPrivateHosts.length === 0) return false;
  const raw = hostname.toLowerCase();
  const h = normalizeHostname(hostname);
  const bracketed = net.isIPv6(h) ? `[${h}]` : h;
  const candidates = new Set([raw, h, bracketed, `${bracketed}:${port}`, `${h}:${port}`]);
  return policy.allowPrivateHosts.some((e) => candidates.has(e));
}

export type Lookup = (host: string) => Promise<string[]>;

interface CacheEntry {
  at: number;
  addrs: string[] | null;
  err?: string;
}
const lookupCache = new Map<string, CacheEntry>();
const LOOKUP_TTL_MS = 30_000;

export const defaultLookup: Lookup = async (host) => {
  const now = Date.now();
  const c = lookupCache.get(host);
  if (c && now - c.at < LOOKUP_TTL_MS) {
    if (c.addrs) return c.addrs;
    throw new Error(c.err ?? 'lookup failed');
  }
  try {
    const res = await dns.promises.lookup(host, { all: true, verbatim: true });
    const addrs = res.map((r) => r.address);
    lookupCache.set(host, { at: now, addrs });
    if (lookupCache.size > 2000) lookupCache.delete(lookupCache.keys().next().value!);
    return addrs;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'ERR';
    lookupCache.set(host, { at: now, addrs: null, err: code });
    throw e;
  }
};

export interface HostCheck {
  ok: boolean;
  reason?: string;
  /** Validated addresses (only when resolution happened and passed). */
  addrs?: string[];
  /** Host is an IP literal. */
  literal?: boolean;
  /** Explicitly allowed by allowPrivateHosts. */
  allowedPrivate?: boolean;
  /** DNS lookup failed (not a policy violation by itself). */
  unresolved?: boolean;
}

/**
 * Private-address check for a destination host. Resolves hostnames and blocks
 * if ANY resolved address is non-public.
 */
export async function checkHost(
  policy: NetworkPolicy,
  hostname: string,
  port: number,
  lookup: Lookup = defaultLookup,
): Promise<HostCheck> {
  const h = normalizeHostname(hostname);
  if (!h) return { ok: false, reason: 'empty host' };
  if (isPrivateHostAllowed(policy, hostname, port)) {
    if (net.isIP(h)) return { ok: true, addrs: [h], literal: true, allowedPrivate: true };
    return { ok: true, allowedPrivate: true };
  }
  const nameReason = blockedHostnameReason(h);
  if (nameReason) return { ok: false, reason: nameReason };
  if (net.isIP(h.split('%')[0]!)) {
    const r = privateIpReason(h);
    return r ? { ok: false, reason: r, literal: true } : { ok: true, addrs: [h], literal: true };
  }
  let addrs: string[];
  try {
    addrs = await lookup(h);
  } catch {
    return { ok: true, unresolved: true };
  }
  for (const a of addrs) {
    const r = privateIpReason(a);
    if (r) return { ok: false, reason: `${h} resolves to ${r}` };
  }
  if (addrs.length === 0) return { ok: true, unresolved: true };
  return { ok: true, addrs };
}

export interface UrlCheckOptions {
  /**
   * true: apply the main-frame navigation allowlist. false: apply the resource
   * allowlist (frames, subresources, fetch/XHR, WebSockets).
   */
  topLevelNavigation: boolean;
  /** Exact URL exempt from the origin allowlist (egress check URL). */
  allowlistExemptUrl?: string;
  /** Skip DNS resolution (literal/hostname checks only). */
  noResolve?: boolean;
  lookup?: Lookup;
}

export function schemeReason(u: URL): string | null {
  if (!ALLOWED_SCHEMES.has(u.protocol) && u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    return `scheme ${u.protocol} is not allowed`;
  }
  return null;
}

export function originAllowed(policy: NetworkPolicy, u: URL): boolean {
  if (policy.allowedNavigationOrigins.includes('*')) return true;
  return policy.allowedNavigationOrigins.includes(u.origin);
}

/** Synchronous part of the URL check (scheme, hostname, IP literal, allowlist). */
export function checkUrlSync(policy: NetworkPolicy, rawUrl: string, opts: UrlCheckOptions): PolicyResult & { url?: URL } {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  const s = schemeReason(u);
  if (s) return { ok: false, reason: s };
  if (opts.topLevelNavigation && u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${u.protocol} is not allowed for navigation` };
  }
  const port = u.port ? Number(u.port) : defaultPort(u.protocol);
  if (!isPrivateHostAllowed(policy, u.hostname, port)) {
    const nameReason = blockedHostnameReason(u.hostname);
    if (nameReason) return { ok: false, reason: nameReason };
    const ipReason = privateIpReason(u.hostname);
    if (ipReason) return { ok: false, reason: ipReason };
  }
  const exempt = opts.allowlistExemptUrl !== undefined && sameUrl(rawUrl, opts.allowlistExemptUrl);
  if (opts.topLevelNavigation) {
    if (!exempt && !originAllowed(policy, u)) {
      return { ok: false, reason: `origin ${u.origin} is not in allowedNavigationOrigins` };
    }
  } else if (!exempt && !resourceAllowed(policy, u)) {
    return { ok: false, reason: `origin ${u.origin} is not in the allowed resource origins` };
  }
  return { ok: true, url: u };
}

export async function checkUrl(policy: NetworkPolicy, rawUrl: string, opts: UrlCheckOptions): Promise<PolicyResult> {
  const sync = checkUrlSync(policy, rawUrl, opts);
  if (!sync.ok) return sync;
  if (opts.noResolve) return { ok: true };
  const u = sync.url!;
  const port = u.port ? Number(u.port) : defaultPort(u.protocol);
  const hc = await checkHost(policy, u.hostname, port, opts.lookup);
  return hc.ok ? { ok: true } : { ok: false, reason: hc.reason ?? 'blocked' };
}

export function sameUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    ua.hash = '';
    ub.hash = '';
    return ua.href === ub.href;
  } catch {
    return false;
  }
}

/** `*` wildcard glob matched against the full URL. */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`);
}

/** Strip query string, fragment and credentials, for logs. */
export { safeUrlForLog } from './urlsafe.js';
