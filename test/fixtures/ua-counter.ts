/**
 * Request-recording target site (test-only). Every request is recorded with its
 * method, path and user-agent class, so a test can assert WHO talked to the
 * target: the worker's browser (Chromium UA) versus a non-browser client such as
 * the orchestrator's Node fetch (`node` / `undici` UA, or none).
 *
 * In the local harness the worker and the MCP server share 127.0.0.1, so the
 * source address cannot tell them apart; the user-agent class can.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type UaClass = 'browser' | 'non_browser';

export interface RecordedRequest {
  method: string;
  path: string;
  ua: string;
  uaClass: UaClass;
}

export interface Recorder {
  origin: string;
  host: string;
  hits: RecordedRequest[];
  /** Requests whose user-agent is not a Chromium browser. */
  nonBrowserHits(): RecordedRequest[];
  url(p: string): string;
  close(): Promise<void>;
}

export function classifyUa(ua: string | undefined): UaClass {
  return ua && /Chrome\/\d+/.test(ua) && /Mozilla\/5\.0/.test(ua) ? 'browser' : 'non_browser';
}

export type Handler = (req: http.IncomingMessage, url: URL, res: http.ServerResponse) => boolean | void;

export async function startRecorder(handler?: Handler): Promise<Recorder> {
  const hits: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const ua = String(req.headers['user-agent'] ?? '');
    hits.push({ method: req.method ?? 'GET', path: u.pathname + u.search, ua, uaClass: classifyUa(ua) });
    if (handler && handler(req, u, res) !== false && res.writableEnded) return;
    if (!res.writableEnded) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Recorder</title><h1 id="ok">recorder</h1>');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    host: `127.0.0.1:${port}`,
    hits,
    nonBrowserHits: () => hits.filter((h) => h.uaClass !== 'browser'),
    url: (p) => origin + p,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
