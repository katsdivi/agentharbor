/**
 * IP echo fixture: responds `{"clientIp": "..."}` where clientIp is the
 * `x-rba-test-egress-ip` request header if present (set by the test proxy),
 * else the socket remote address. Binds 127.0.0.1 on a random port.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startIpEcho(): Promise<{ url: string; close(): Promise<void>; requests: number }> {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    const h = req.headers['x-rba-test-egress-ip'];
    let ip = typeof h === 'string' && h ? h : (req.socket.remoteAddress ?? '');
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ clientIp: ip }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/ip`,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
