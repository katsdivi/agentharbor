/**
 * Fixture website for saved read operations (W1). Binds 127.0.0.1 on a random
 * port; node built-ins only.
 *
 *  - /search?q=     page whose script calls GET /api/search?q=&lang=en (JSON)
 *  - /orders?status= account page whose script calls GET /api/orders?status=
 *                    (needs the `sid` cookie; 401 JSON without it)
 *  - /me/orders?status= account page that embeds the user's numeric id and
 *                    email and calls POST /api/users/<id>/orders?owner=<email>
 *                    with them in a header and the JSON body too (privacy tests)
 *  - /newsletter?topic= public page whose API request carries an email literal
 *  - /signed?q=     page whose script calls /api/signed with a single-use
 *                    nonce + signature (a replay of a captured request fails)
 *
 * Toggles in `state` simulate site changes: `requirePageToken` (the API then
 * needs a header only a freshly served page has), `shapeChanged` (the API
 * answers with a different shape).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OpsRequest {
  method: string;
  path: string;
  query: string;
  /** Came through the test forward proxy (it adds x-rba-test-egress-ip). */
  viaProxy: boolean;
  /** Names of cookies the request carried (never values). */
  cookieNames: string[];
  /** Remote port of the TCP connection (identifies the client socket). */
  remotePort: number | undefined;
}

export interface OpsState {
  requests: OpsRequest[];
  /** sid -> user name */
  sessions: Map<string, string>;
  /** user name -> per-account identity the /me/orders page embeds in its API request */
  profiles: Map<string, { uid: string; email: string }>;
  /** subscriber literal the public /newsletter page sends */
  newsletterSubscriber: string;
  requirePageToken: boolean;
  shapeChanged: boolean;
  pageTokens: Set<string>;
  usedNonces: Set<string>;
}

export interface OpsSite {
  origin: string;
  url(path: string): string;
  state: OpsState;
  /** Create a signed-in user; returns the sid cookie value. */
  addUser(name: string): string;
  /** API requests only (path starts with /api/). */
  apiRequests(): OpsRequest[];
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;

function cookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export async function startOperationsSite(): Promise<OpsSite> {
  const secret = crypto.randomBytes(16);
  const state: OpsState = {
    requests: [],
    sessions: new Map(),
    profiles: new Map(),
    newsletterSubscriber: `reader-${crypto.randomBytes(3).toString('hex')}@ops-fixture.test`,
    requirePageToken: false,
    shapeChanged: false,
    pageTokens: new Set(),
    usedNonces: new Set(),
  };
  let origin = '';
  const sign = (q: string, nonce: string) => crypto.createHmac('sha256', secret).update(`${q}\0${nonce}`).digest('base64url').slice(0, 32);

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const html = (res: http.ServerResponse, title: string, body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page(title, body));
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', origin);
    const p = u.pathname;
    const c = cookies(req.headers.cookie);
    state.requests.push({
      method: req.method ?? 'GET',
      path: p,
      query: u.search,
      viaProxy: typeof req.headers['x-rba-test-egress-ip'] === 'string',
      cookieNames: Object.keys(c),
      remotePort: req.socket.remotePort,
    });
    const user = c.sid ? (state.sessions.get(c.sid) ?? null) : null;

    if (p === '/') return html(res, 'Ops fixture', '<h1>Ops fixture</h1>');

    if (p === '/search') {
      let token = '';
      if (state.requirePageToken) {
        token = crypto.randomBytes(12).toString('hex');
        state.pageTokens.add(token);
      }
      return html(
        res,
        'Search',
        `<h1>Search</h1><pre id="out">loading</pre><script>
          var q = new URLSearchParams(location.search).get('q') || '';
          var h = { accept: 'application/json' };
          var t = ${JSON.stringify(token)};
          if (t) h['x-page-token'] = t;
          fetch('/api/search?q=' + encodeURIComponent(q) + '&lang=en', { headers: h })
            .then(function (r) { return r.json(); })
            .then(function (d) { document.getElementById('out').textContent = JSON.stringify(d); });
        </script>`,
      );
    }
    if (p === '/api/search') {
      if (state.requirePageToken) {
        const t = req.headers['x-page-token'];
        if (typeof t !== 'string' || !state.pageTokens.has(t)) return json(res, 401, { error: 'page token required' });
      }
      const q = u.searchParams.get('q') ?? '';
      const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (state.shapeChanged) return json(res, 200, { query: q, results: [{ name: `Result for ${q}` }] });
      return json(res, 200, {
        query: q,
        lang: u.searchParams.get('lang'),
        total: 3,
        hits: [1, 2, 3].map((i) => ({ id: `${slug}-${i}`, title: `Result ${i} for ${q}`, score: 10 - i })),
      });
    }

    if (p === '/orders') {
      return html(
        res,
        'Orders',
        `<h1>Orders</h1><pre id="out">loading</pre><script>
          var s = new URLSearchParams(location.search).get('status') || 'open';
          fetch('/api/orders?status=' + encodeURIComponent(s), { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (d) { document.getElementById('out').textContent = JSON.stringify(d); });
        </script>`,
      );
    }
    if (p === '/api/orders') {
      if (!user) return json(res, 401, { error: 'login required' });
      const s = u.searchParams.get('status') ?? 'open';
      return json(res, 200, {
        user,
        status: s,
        orders: [1, 2].map((i) => ({ id: `${user}-${s}-${i}`, status: s, item: `${user}'s item ${i}` })),
      });
    }

    if (p === '/login-as') {
      // Test-only sign-in: sets the sid cookie of an existing fixture user.
      const name = u.searchParams.get('user') ?? '';
      const sid = [...state.sessions].find(([, n]) => n === name)?.[0];
      if (!sid) return json(res, 404, { error: 'no such user' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`, 'cache-control': 'no-store' });
      return res.end(page('Signed in', '<h1>Signed in</h1>'));
    }

    if (p === '/me/orders') {
      // The page embeds the signed-in user's numeric id and email; its API request carries them
      // in the path, a query param, a header and the JSON body (not in storage, not a credential).
      const prof = user ? state.profiles.get(user) : undefined;
      return html(
        res,
        'My orders',
        `<h1>My orders</h1><pre id="out">loading</pre><script>
          var me = ${JSON.stringify(prof ?? { uid: '0', email: '' })};
          var s = new URLSearchParams(location.search).get('status') || 'open';
          fetch('/api/users/' + me.uid + '/orders?owner=' + encodeURIComponent(me.email) + '&status=' + encodeURIComponent(s), {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-account-email': me.email },
            body: JSON.stringify({ userId: me.uid, status: s })
          })
            .then(function (r) { return r.json(); })
            .then(function (d) { document.getElementById('out').textContent = JSON.stringify(d); });
        </script>`,
      );
    }
    const mine = /^\/api\/users\/([^/]+)\/orders$/.exec(p);
    if (mine) {
      if (!user) return json(res, 401, { error: 'login required' });
      const prof = state.profiles.get(user)!;
      if (mine[1] !== prof.uid || u.searchParams.get('owner') !== prof.email || req.headers['x-account-email'] !== prof.email) return json(res, 403, { error: 'not your account' });
      const s = u.searchParams.get('status') ?? 'open';
      return json(res, 200, { status: s, orders: [1, 2].map((i) => ({ id: `${user}-${s}-${i}`, status: s, item: `${user}'s item ${i}` })) });
    }

    if (p === '/newsletter') {
      return html(
        res,
        'Newsletter',
        `<h1>Newsletter</h1><pre id="out">loading</pre><script>
          var t = new URLSearchParams(location.search).get('topic') || '';
          fetch('/api/newsletter?topic=' + encodeURIComponent(t) + '&subscriber=' + encodeURIComponent(${JSON.stringify(state.newsletterSubscriber)}))
            .then(function (r) { return r.json(); })
            .then(function (d) { document.getElementById('out').textContent = JSON.stringify(d); });
        </script>`,
      );
    }
    if (p === '/api/newsletter') {
      const t = u.searchParams.get('topic') ?? '';
      return json(res, 200, { topic: t, issues: [1, 2].map((i) => ({ title: `Issue ${i} about ${t}` })) });
    }

    if (p === '/signed') {
      const q = u.searchParams.get('q') ?? '';
      const nonce = crypto.randomBytes(24).toString('base64url');
      const sig = sign(q, nonce);
      return html(
        res,
        'Signed',
        `<h1>Signed</h1><pre id="out">loading</pre><script>
          fetch('/api/signed?q=' + encodeURIComponent(${JSON.stringify(q)}) + '&nonce=${nonce}&sig=${sig}')
            .then(function (r) { return r.json(); })
            .then(function (d) { document.getElementById('out').textContent = JSON.stringify(d); });
        </script>`,
      );
    }
    if (p === '/api/signed') {
      const q = u.searchParams.get('q') ?? '';
      const nonce = u.searchParams.get('nonce') ?? '';
      if (u.searchParams.get('sig') !== sign(q, nonce) || state.usedNonces.has(nonce)) return json(res, 403, { error: 'invalid or reused signature' });
      state.usedNonces.add(nonce);
      return json(res, 200, { query: q, items: [{ name: `Signed item for ${q}`, rank: 1 }, { name: `Second signed item for ${q}`, rank: 2 }] });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return {
    origin,
    url: (path: string) => origin + path,
    state,
    addUser(name: string) {
      const sid = crypto.randomBytes(16).toString('hex');
      state.sessions.set(sid, name);
      state.profiles.set(name, { uid: String(10_000_000 + crypto.randomInt(89_999_999)), email: `${name}.${crypto.randomBytes(2).toString('hex')}@ops-fixture.test` });
      return sid;
    },
    apiRequests: () => state.requests.filter((r) => r.path.startsWith('/api/')),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
