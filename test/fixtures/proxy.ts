/**
 * Minimal HTTP forward proxy for tests (node built-ins only).
 * - absolute-URI requests (GET/POST/...) are forwarded with the extra header
 *   `x-rba-test-egress-ip: <egressIp>` so the ip-echo fixture reports the
 *   "proxy exit IP";
 * - CONNECT is tunnelled (no header injection possible inside the tunnel);
 * - `fail: true` destroys every incoming connection.
 * `requests` records "METHOD target" for each proxied request/tunnel.
 */
import http from 'node:http';
import net from 'node:net';

export async function startTestProxy(opts: { egressIp?: string; fail?: boolean } = {}): Promise<{
  url: string;
  close(): Promise<void>;
  requests: string[];
}> {
  const egressIp = opts.egressIp ?? '203.0.113.7';
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const headers = { ...req.headers, 'x-rba-test-egress-ip': egressIp };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const up = http.request(
      { host: target.hostname, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(up);
  });
  server.on('connect', (req, client: net.Socket, head) => {
    requests.push(`CONNECT ${req.url}`);
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const up = net.connect(Number(m[2]), m[1]!.replace(/^\[|\]$/g, ''), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  server.on('connection', (s: net.Socket) => {
    if (opts.fail) {
      s.destroy();
      return;
    }
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
