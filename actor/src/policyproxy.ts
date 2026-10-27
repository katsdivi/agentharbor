/**
 * In-process policy forward proxy.
 *
 * Chromium is launched with `proxy: { server: <this proxy>, bypass: '<-loopback>' }`
 * so EVERY network request it makes (navigations, every redirect hop,
 * subresources, WebSockets, workers) arrives here first. `<-loopback>` removes
 * Chromium's implicit loopback bypass, i.e. it makes the policy stricter; no
 * bypass entries are added.
 *
 * Why: Playwright's `context.route` is not invoked for redirect hops (verified
 * empirically with Playwright 1.64/Chromium: `/r1 -> /r2 -> http://169.254.169.254/`
 * only invoked the handler for `/r1`, and Chromium then connected to the
 * metadata address). This proxy closes that gap by checking every destination
 * at connection time.
 *
 * - Resource policy first: the destination host:port must belong to an allowed
 *   resource origin (navigation origins + configured resource origins). This is
 *   the enforcement point for paths Playwright cannot intercept: redirect hops
 *   of subresources, out-of-process frames, workers, beacons, preconnects and
 *   WebSocket tunnels. CONNECT tunnels hide the scheme, so the check there is
 *   host+port; plain-HTTP requests are checked by exact origin.
 * - direct mode: resolves the host, rejects if ANY address is non-public, then
 *   connects to the validated IP (no resolve-then-connect TOCTOU for traffic
 *   through this proxy).
 * - upstream mode (Apify datacenter/residential proxy): same local check
 *   (defense in depth; an unresolvable name is passed on because the upstream
 *   resolves DNS itself), then forwards via the upstream proxy. If the
 *   upstream fails, the request fails - there is never a direct fallback.
 *
 * Logs contain host names only (never paths, query strings, or headers).
 */
import http from 'node:http';
import net from 'node:net';
import { checkHost, defaultPort, normalizeHostname, resourceAllowed, resourceHostAllowed, type NetworkPolicy } from './netpolicy.js';
import type { ConnectionRecord } from './protocol.js';
import { log } from './log.js';

export interface BlockRecord {
  host: string;
  reason: string;
  at: number;
}

export interface UpstreamProxy {
  host: string;
  port: number;
  /** `Basic ...` value, or null. */
  auth: string | null;
}

export function parseUpstream(proxyUrl: string): UpstreamProxy {
  const u = new URL(proxyUrl);
  if (u.protocol !== 'http:') throw new Error('upstream proxy must be http://');
  const auth =
    u.username || u.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`
      : null;
  return { host: u.hostname, port: u.port ? Number(u.port) : 80, auth };
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const SOCKET_TIMEOUT_MS = 120_000;

const MAX_RECORDS = 200;

export class PolicyProxy {
  private server: http.Server;
  private sockets = new Set<net.Socket>();
  readonly blocks: BlockRecord[] = [];
  /** Recent connections (host/port, outcome, timings, byte counts only). */
  readonly connections: ConnectionRecord[] = [];
  private blockedHostCounts = new Map<string, { count: number; reason: string }>();
  port = 0;

  constructor(
    private policy: NetworkPolicy,
    private upstream: UpstreamProxy | null,
  ) {
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server.on('connect', (req, sock: net.Socket, head) => void this.onConnect(req, sock, head));
    // Upgrade requests over plain proxying are not supported (Chromium tunnels
    // WebSockets with CONNECT when proxied): fail closed.
    this.server.on('upgrade', (_req, sock: net.Socket) => sock.destroy());
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server.on('clientError', (_e, s) => s.destroy());
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Block records since a timestamp. */
  blocksSince(t: number): BlockRecord[] {
    return this.blocks.filter((b) => b.at >= t);
  }

  /** Refusals by the in-browser layers (route handler, document guard, WebSocket guard). */
  noteBlocked(host: string, reason: string): void {
    const k = normalizeHostname(host);
    const c = this.blockedHostCounts.get(k);
    if (c) c.count++;
    else if (this.blockedHostCounts.size < 200) this.blockedHostCounts.set(k, { count: 1, reason });
  }

  private recordBlock(host: string, reason: string): void {
    this.blocks.push({ host, reason, at: Date.now() });
    if (this.blocks.length > 50) this.blocks.shift();
    const k = normalizeHostname(host);
    const c = this.blockedHostCounts.get(k);
    if (c) c.count++;
    else if (this.blockedHostCounts.size < 200) this.blockedHostCounts.set(k, { count: 1, reason });
    log('proxy_block', { host });
  }

  private newRecord(host: string, port: number, kind: ConnectionRecord['kind']): ConnectionRecord {
    const r: ConnectionRecord = { host: normalizeHostname(host), port, kind, outcome: 'open', bytesUp: 0, bytesDown: 0, at: new Date().toISOString() };
    this.connections.push(r);
    if (this.connections.length > MAX_RECORDS) this.connections.shift();
    return r;
  }

  diagnostics(): { connections: ConnectionRecord[]; blockedHosts: Array<{ host: string; count: number; reason: string }> } {
    return {
      connections: [...this.connections],
      blockedHosts: [...this.blockedHostCounts.entries()].map(([host, v]) => ({ host, ...v })).sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Validate a destination. Returns the IP to connect to in direct mode.
   * Order: resource-origin allowlist (host:port; with `url`, the exact origin
   * for plain-HTTP requests), then the private-address policy.
   */
  private async validate(host: string, port: number, url?: URL): Promise<{ ok: true; ip: string | null } | { ok: false; reason: string; status: number }> {
    const allowed = url ? resourceAllowed(this.policy, url) : resourceHostAllowed(this.policy, host, port);
    if (!allowed) return { ok: false, reason: `${normalizeHostname(host)}:${port} is not in the allowed resource origins`, status: 403 };
    const hc = await checkHost(this.policy, host, port);
    if (!hc.ok) return { ok: false, reason: hc.reason ?? 'blocked', status: 403 };
    if (this.upstream) return { ok: true, ip: null };
    if (hc.unresolved || !hc.addrs || hc.addrs.length === 0) {
      if (hc.allowedPrivate) return { ok: true, ip: null };
      return { ok: false, reason: `could not resolve ${host}`, status: 502 };
    }
    return { ok: true, ip: hc.addrs[0]! };
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if (target.protocol !== 'http:') throw new Error('scheme');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = target.port ? Number(target.port) : defaultPort(target.protocol);
    const rec = this.newRecord(target.hostname, port, 'http');
    const t0 = Date.now();
    const v = await this.validate(target.hostname, port, target);
    rec.policyMs = Date.now() - t0;
    if (!v.ok) {
      rec.outcome = 'blocked';
      rec.reason = v.reason;
      if (v.status === 403) this.recordBlock(target.hostname, v.reason);
      res.writeHead(v.status, { 'content-type': 'text/plain', 'x-rba-blocked': v.status === 403 ? '1' : '0' });
      res.end(v.status === 403 ? 'Blocked by remote browser worker network policy.' : 'Bad gateway');
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, val] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && val !== undefined) headers[k] = val;
    }
    let opts: http.RequestOptions;
    if (this.upstream) {
      if (this.upstream.auth) headers['proxy-authorization'] = this.upstream.auth;
      opts = { host: this.upstream.host, port: this.upstream.port, method: req.method, path: target.href, headers };
    } else {
      const hostForConnect = v.ip ?? target.hostname.replace(/^\[|\]$/g, '');
      opts = { host: hostForConnect, port, method: req.method, path: target.pathname + target.search, headers, setHost: false };
    }
    const out = http.request(opts, (up) => {
      rec.firstByteMs = Date.now() - t0;
      up.on('data', (d: Buffer) => (rec.bytesDown += d.length));
      up.on('end', () => {
        rec.outcome = 'closed';
        rec.durationMs = Date.now() - t0;
      });
      const rh: http.OutgoingHttpHeaders = {};
      for (const [k, val] of Object.entries(up.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase()) && val !== undefined) rh[k] = val;
      }
      res.writeHead(up.statusCode ?? 502, rh);
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    out.on('socket', (s: net.Socket) => s.once('connect', () => (rec.connectMs = Date.now() - t0)));
    out.setTimeout(SOCKET_TIMEOUT_MS, () => out.destroy(new Error('socket timeout')));
    out.on('error', (e: NodeJS.ErrnoException) => {
      rec.outcome = 'error';
      rec.error = e.code ?? e.message.slice(0, 80);
      rec.durationMs = Date.now() - t0;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad gateway');
      else res.destroy();
    });
    req.on('data', (d: Buffer) => (rec.bytesUp += d.length));
    // Browser gave up (page closed, navigation cancelled): tear down the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) out.destroy();
    });
    req.pipe(out);
  }

  private async onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    client.on('error', () => undefined);
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const host = m[1]!.replace(/^\[|\]$/g, '');
    const port = Number(m[2]);
    const rec = this.newRecord(host, port, 'connect');
    const t0 = Date.now();
    const v = await this.validate(m[1]!, port);
    rec.policyMs = Date.now() - t0;
    const track = (up: net.Socket) => {
      up.on('data', (d: Buffer) => {
        if (rec.firstByteMs === undefined) rec.firstByteMs = Date.now() - t0;
        rec.bytesDown += d.length;
      });
      client.on('data', (d: Buffer) => (rec.bytesUp += d.length));
      const done = () => {
        if (rec.outcome === 'open') rec.outcome = 'closed';
        rec.durationMs = Date.now() - t0;
      };
      up.on('close', done);
      client.on('close', done);
    };
    const fail = (e: unknown) => {
      rec.outcome = 'error';
      rec.error = ((e as NodeJS.ErrnoException)?.code ?? String((e as Error)?.message ?? e)).slice(0, 80);
      rec.durationMs = Date.now() - t0;
    };
    if (!v.ok) {
      rec.outcome = 'blocked';
      rec.reason = v.reason;
      if (v.status === 403) this.recordBlock(host, v.reason);
      client.end(`HTTP/1.1 ${v.status} ${v.status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nx-rba-blocked: 1\r\n\r\n`);
      return;
    }
    if (this.upstream) {
      const headers: http.OutgoingHttpHeaders = { host: `${m[1]}:${port}` };
      if (this.upstream.auth) headers['proxy-authorization'] = this.upstream.auth;
      const up = http.request({ host: this.upstream.host, port: this.upstream.port, method: 'CONNECT', path: `${m[1]}:${port}`, headers });
      up.setTimeout(SOCKET_TIMEOUT_MS, () => up.destroy());
      up.on('connect', (ures, usock, uhead) => {
        if (ures.statusCode !== 200) {
          fail(new Error(`upstream CONNECT ${ures.statusCode}`));
          usock.destroy();
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          return;
        }
        rec.connectMs = Date.now() - t0;
        track(usock);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (uhead.length) client.write(uhead);
        if (head.length) usock.write(head);
        usock.on('error', () => client.destroy());
        client.on('error', () => usock.destroy());
        usock.pipe(client);
        client.pipe(usock);
      });
      up.on('error', (e) => {
        fail(e);
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
      up.end();
      return;
    }
    const upSock = net.connect(port, v.ip ?? host);
    upSock.setTimeout(SOCKET_TIMEOUT_MS, () => upSock.destroy(new Error('connect timeout')));
    upSock.on('connect', () => {
      rec.connectMs = Date.now() - t0;
      track(upSock);
      upSock.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upSock.write(head);
      upSock.pipe(client);
      client.pipe(upSock);
    });
    upSock.on('error', (e) => {
      fail(e);
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    client.on('close', () => upSock.destroy());
  }
}
