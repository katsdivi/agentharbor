/**
 * HTTPS front for the fake Apify API (test-only).
 *
 * The real MCP server process builds its ApifyProvider from configuration, and
 * that provider refuses non-HTTPS container URLs (as it must). To drive the
 * BUILT server over stdio against the fake Apify, this fixture:
 *  - generates a throwaway self-signed certificate for 127.0.0.1 (openssl);
 *  - serves HTTPS on 127.0.0.1 and forwards `/v2/...` to the fake Apify API,
 *    rewriting each run's `containerUrl` (http://127.0.0.1:P) to
 *    https://127.0.0.1:<front>/__run/P;
 *  - forwards `/__run/P/...` to the local worker on port P, but only for ports
 *    the fake API actually reported for a run.
 * The server process trusts the certificate through NODE_EXTRA_CA_CERTS
 * (`caFile`). No product code is changed or bypassed.
 *
 * This is still the fake Apify: it proves orchestrator plumbing, not
 * compatibility with the live platform.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TlsFront {
  url: string;
  caFile: string;
  /** Requests seen, as "METHOD path" (paths only; no headers or bodies). */
  requests: string[];
  close(): Promise<void>;
}

export async function startTlsFront(upstream: string): Promise<TlsFront> {
  const dir = mkdtempSync(join(tmpdir(), 'rba-tls-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'ignore' },
  );
  const knownPorts = new Set<number>();
  const requests: string[] = [];
  let self = '';

  const forward = (req: http.IncomingMessage, res: http.ServerResponse, target: URL, rewrite: boolean) => {
    const headers = { ...req.headers, host: target.host };
    delete headers['accept-encoding'];
    const up = http.request(target, { method: req.method, headers }, (ur) => {
      if (!rewrite) {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf8');
        text = text.replace(/"containerUrl":"http:\/\/127\.0\.0\.1:(\d+)"/g, (_m, p: string) => {
          knownPorts.add(Number(p));
          return `"containerUrl":"${self}/__run/${p}"`;
        });
        const h = { ...ur.headers };
        delete h['content-length'];
        res.writeHead(ur.statusCode ?? 502, h);
        res.end(text);
      });
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  };

  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const u = new URL(req.url ?? '/', 'https://x');
    requests.push(`${req.method} ${u.pathname}`);
    const m = /^\/__run\/(\d+)(\/.*)?$/.exec(u.pathname);
    if (m) {
      const port = Number(m[1]);
      if (!knownPorts.has(port)) {
        res.writeHead(404).end();
        return;
      }
      return forward(req, res, new URL(`http://127.0.0.1:${port}${m[2] ?? '/'}${u.search}`), false);
    }
    if (u.pathname.startsWith('/v2/')) return forward(req, res, new URL(`${upstream}${u.pathname}${u.search}`), true);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  self = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: self,
    caFile: cert,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          r();
        });
      }),
  };
}
