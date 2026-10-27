import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Ctx } from '../core/context.js';
import { resultsPath } from '../core/crawl.js';
import { safeEqual } from '../core/crypto.js';
import { RbaError } from '../core/errors.js';
import { isTerminal } from '../core/jobs.js';
import { redact } from '../core/redact.js';

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);

const CSS = `
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6b6b70;--line:#e3e3e8;--acc:#2856d8;--bad:#b42318;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--mut:#9a9aa3;--line:#2b2b31;--acc:#7b9cff;--bad:#ff8a80;--ok:#6fdc8c}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1100px}
a{color:var(--acc)}h1{font-size:20px}h2{font-size:16px;margin-top:28px}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;white-space:nowrap}
.mut{color:var(--mut)}.bad{color:var(--bad)}.ok{color:var(--ok)}code{font-size:12px}
input,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{cursor:pointer}form{margin:8px 0}nav a{margin-right:14px}`;

export interface DashboardHandle {
  server: Server;
  url: string;
  /** Single-use login link valid for two minutes. */
  oneTimeLoginUrl: string;
  close(): Promise<void>;
}

/** Read a whole request body up to `limit` bytes. */
function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new RbaError('invalid_input', 'upload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Minimal multipart/form-data parser (form fields and file parts). */
export function parseMultipart(body: Buffer, contentType: string): Array<{ name: string; filename: string | null; data: Buffer }> {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!m) throw new RbaError('invalid_input', 'expected multipart/form-data');
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const out: Array<{ name: string; filename: string | null; data: Buffer }> = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const head = part.subarray(0, sep).toString('utf8');
      const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '';
      const fn = /filename="([^"]*)"/i.exec(head);
      out.push({ name, filename: fn ? fn[1]! : null, data: part.subarray(sep + 4) });
    }
    pos = next;
  }
  return out;
}

export function startDashboard(ctx: Ctx, port = ctx.cfg.dashboard.port): Promise<DashboardHandle> {
  const token = ctx.cfg.dashboard.token;
  if (!token) throw new RbaError('config_missing', 'RBA_DASHBOARD_TOKEN missing; run npm run init-env');
  const sessionKey = randomBytes(32);
  let oneTime: { nonce: string; exp: number } | null = { nonce: randomBytes(24).toString('base64url'), exp: Date.now() + 120_000 };
  let actualPort = port;

  const sign = (v: string) => createHmac('sha256', sessionKey).update(v).digest('base64url');
  const newCookie = () => {
    const id = randomBytes(18).toString('base64url');
    return `${id}.${sign(id)}`;
  };
  const cookieOk = (c: string | undefined) => {
    if (!c) return false;
    const [id, sig] = c.split('.');
    return !!id && !!sig && safeEqual(sig, sign(id));
  };
  const csrfFor = (cookie: string) => sign(`csrf:${cookie}`);

  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(ctx.cfg.displayName)}</title><style>${CSS}</style></head><body><nav><a href="/">Overview</a><a href="/accounts">Accounts</a><a href="/jobs">Jobs</a><a href="/files">Files</a><a href="/usage">Usage</a></nav><h1>${esc(title)}</h1>${body}</body></html>`;

  const send = (res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(html);
  };

  const readForm = (req: IncomingMessage): Promise<URLSearchParams> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 16_384) {
          reject(new RbaError('invalid_input', 'form too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });

  const getCookie = (req: IncomingMessage) => /(?:^|;\s*)rba_dash=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // Security headers on every response; no CORS headers are ever sent.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    // DNS-rebinding protection: only our own loopback host names.
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) return send(res, 421, 'misdirected request');
    const selfOrigins = allowedHosts.map((h) => `http://${h}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (!origin || !selfOrigins.includes(origin)) return send(res, 403, 'cross-origin request refused');
    }
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) {
      return send(res, 403, 'cross-site request refused');
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === '/login') {
      if (req.method === 'GET') {
        const once = url.searchParams.get('once');
        if (once && oneTime && Date.now() < oneTime.exp && safeEqual(once, oneTime.nonce)) {
          oneTime = null;
          const c = newCookie();
          res.writeHead(303, { Location: '/', 'Set-Cookie': `rba_dash=${c}; HttpOnly; SameSite=Strict; Path=/` });
          return res.end();
        }
        return send(res, 200, page('Sign in', `<form method="post" action="/login"><p class="mut">Enter RBA_DASHBOARD_TOKEN from your .env file.</p><input type="password" name="token" autocomplete="off" required> <button>Sign in</button></form>`));
      }
      const f = await readForm(req);
      if (safeEqual(f.get('token') ?? '', token)) {
        const c = newCookie();
        res.writeHead(303, { Location: '/', 'Set-Cookie': `rba_dash=${c}; HttpOnly; SameSite=Strict; Path=/` });
        return res.end();
      }
      return send(res, 401, page('Sign in', '<p class="bad">Invalid token.</p><a href="/login">Try again</a>'));
    }

    const cookie = getCookie(req);
    if (!cookieOk(cookie)) {
      res.writeHead(303, { Location: '/login' });
      return res.end();
    }
    const csrf = csrfFor(cookie!);
    const csrfField = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
    const checkCsrf = (f: URLSearchParams) => {
      if (!safeEqual(f.get('csrf') ?? '', csrf)) throw new RbaError('forbidden', 'bad CSRF token');
    };

    // Explicit local file selection: the user picks a file in this loopback page.
    // (A webpage or email cannot reach this endpoint: Origin/Host/CSRF checks above.)
    if (req.method === 'POST' && path === '/files/import') {
      const ct = String(req.headers['content-type'] ?? '');
      const raw = await readRaw(req, ctx.files.maxBytes + 256 * 1024);
      const parts = parseMultipart(raw, ct);
      const csrfPart = parts.find((p) => p.name === 'csrf' && p.filename === null);
      if (!safeEqual(csrfPart?.data.toString('utf8') ?? '', csrf)) throw new RbaError('forbidden', 'bad CSRF token');
      const file = parts.find((p) => p.name === 'file' && p.filename !== null);
      if (!file) throw new RbaError('invalid_input', 'no file chosen');
      const v = ctx.files.importBuffer(file.data, file.filename ?? 'file');
      ctx.db.log('info', `file ${v.artifactId} imported via dashboard (${v.format}, ${v.size} bytes)`);
      res.writeHead(303, { Location: '/files' });
      return res.end();
    }

    if (req.method === 'POST') {
      const f = await readForm(req);
      checkCsrf(f);
      let m = /^\/accounts\/([\w-]+)\/password$/.exec(path);
      if (m) {
        const pw = f.get('password') ?? '';
        if (pw.length < 1 || pw.length > 512) throw new RbaError('invalid_input', 'password length 1..512');
        ctx.accounts.row(m[1]!);
        const username = f.get('username') || undefined;
        ctx.accounts.setCredentials(m[1]!, { password: pw, username });
        ctx.db.log('info', `password set for ${m[1]} via dashboard`);
        res.writeHead(303, { Location: `/accounts/${m[1]}` });
        return res.end();
      }
      m = /^\/accounts\/([\w-]+)\/(quarantine|lift)$/.exec(path);
      if (m) {
        if (m[2] === 'lift') ctx.accounts.liftQuarantine(m[1]!);
        else ctx.accounts.quarantine(m[1]!, 'quarantined from dashboard');
        res.writeHead(303, { Location: `/accounts/${m[1]}` });
        return res.end();
      }
      m = /^\/jobs\/([\w-]+)\/cancel$/.exec(path);
      if (m) {
        ctx.jobs.cancel(m[1]!);
        res.writeHead(303, { Location: `/jobs/${m[1]}` });
        return res.end();
      }
      return send(res, 404, page('Not found', ''));
    }

    if (path === '/files') {
      const rows = ctx.files
        .list()
        .map(
          (f) =>
            `<tr><td><code>${esc(f.artifactId)}</code></td><td>${esc(f.displayName)}</td><td>${esc(f.format)}</td><td>${f.size}</td><td>${esc(f.origin)}</td><td>${esc(f.verification ?? '')}</td><td><code>${esc(f.sha256.slice(0, 12))}…</code></td></tr>`,
        )
        .join('');
      return send(
        res,
        200,
        page(
          'Files',
          `<form method="post" action="/files/import" enctype="multipart/form-data">${csrfField}<input type="file" name="file" required> <button>Import</button></form>
          <p class="mut">The file is copied into the plugin's private storage (original unchanged). Limit ${Math.round(ctx.files.maxBytes / 1048576)} MB. Use the artifact id with media_inspect, media_sanitize or portal_upload.</p>
          <table><tr><th>Artifact</th><th>Name</th><th>Format</th><th>Bytes</th><th>Origin</th><th>Verification</th><th>SHA-256</th></tr>${rows}</table>`,
        ),
      );
    }

    if (path === '/' || path === '/usage') {
      const report = await ctx.usage.report();
      const totals = report.totals as Record<string, { quantity: number; usd: number; bases: string[] }>;
      const sessions = ctx.db.all<any>(`SELECT * FROM sessions WHERE status IN ('starting','ready','closing') ORDER BY created_at`);
      const body =
        `<h2>Usage (since ${esc((report.window as any).since)}, ${esc((report.window as any).basis)})</h2><table><tr><th>Kind</th><th>Quantity</th><th>USD</th><th>Basis</th></tr>${Object.entries(totals)
          .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v.quantity.toFixed(4))}</td><td>${esc(v.usd.toFixed(4))}</td><td>${esc(v.bases.join(', '))}</td></tr>`)
          .join('')}</table>
        <p>Budget: $${esc((report.budget as any).monthlyBudgetUsd)} (${esc((report.budget as any).scope)}) · plugin runs: reconciled $${esc(((report.pluginApifyRuns as any).reconciledUsd).toFixed(4))}, preliminary $${esc(((report.pluginApifyRuns as any).preliminaryReportedUsd).toFixed(4))} (last reconciled ${esc((report.pluginApifyRuns as any).lastReconciledAt ?? 'never')}) · Apify account reported: <code>${esc(redact(JSON.stringify(report.apifyAccountReported)))}</code></p>
        <ul class="mut">${(report.notes as string[]).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` +
        (path === '/'
          ? `<h2>Active sessions</h2><table><tr><th>Session</th><th>Account</th><th>Proxy</th><th>Status</th><th>Started</th></tr>${sessions
              .map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.account_id ?? '—')}</td><td>${esc(s.proxy_mode)}</td><td>${esc(s.status)}</td><td>${esc(s.created_at)}</td></tr>`)
              .join('')}</table>${jobsTable(ctx, 10)}`
          : '');
      return send(res, 200, page(path === '/' ? 'Remote browser accounts' : 'Usage', body));
    }

    if (path === '/accounts') {
      const rows = ctx.accounts.list();
      return send(
        res,
        200,
        page(
          'Accounts',
          `<table><tr><th>ID</th><th>Target</th><th>Email</th><th>Status</th><th>Password</th><th>State saved</th><th>Lease</th></tr>${rows
            .map(
              (a) =>
                `<tr><td><a href="/accounts/${esc(a.accountId)}">${esc(a.accountId)}</a></td><td>${esc(a.targetOrigin)}</td><td>${esc(a.email ?? '—')}</td><td>${esc(a.status)}</td><td>${a.credentialRef ? 'stored' : '<span class="bad">none</span>'}</td><td>${esc(a.browserStateSavedAt ?? '—')}</td><td>${esc(a.lease?.holder ?? '—')}</td></tr>`,
            )
            .join('')}</table>`,
        ),
      );
    }

    let m = /^\/accounts\/([\w-]+)$/.exec(path);
    if (m) {
      const a = ctx.accounts.view(ctx.accounts.row(m[1]!));
      return send(
        res,
        200,
        page(
          `Account ${a.accountId}`,
          `<table>${Object.entries({ target: a.targetOrigin, email: a.email, status: a.status, reason: a.statusReason, verified: a.verifiedAt, proxy: `${a.proxyProfile.mode} ${a.proxyProfile.country ?? ''}`, password: a.credentialRef ? 'stored (encrypted)' : 'none', browserState: a.browserStateSavedAt ?? 'none', lease: a.lease ? `${a.lease.holder} until ${a.lease.expiresAt}` : 'free' })
            .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? '—')}</td></tr>`)
            .join('')}</table>
          <h2>Set password</h2><p class="mut">Stored encrypted with RBA_ENCRYPTION_KEY. Claude can only use it by reference.</p>
          <form method="post" action="/accounts/${esc(a.accountId)}/password">${csrfField}<input name="username" placeholder="username (optional)" autocomplete="off"> <input type="password" name="password" placeholder="password" autocomplete="new-password" required> <button>Save</button></form>
          <form method="post" action="/accounts/${esc(a.accountId)}/${a.status === 'quarantined' || a.status === 'blocked' ? 'lift' : 'quarantine'}">${csrfField}<button>${a.status === 'quarantined' || a.status === 'blocked' ? 'Lift quarantine' : 'Quarantine'}</button></form>`,
        ),
      );
    }

    if (path === '/jobs') return send(res, 200, page('Jobs', jobsTable(ctx, 200)));

    m = /^\/jobs\/([\w-]+)$/.exec(path);
    if (m) {
      const j = ctx.jobs.view(m[1]!) as any;
      const hasResults = existsSync(resultsPath(ctx, j.jobId));
      return send(
        res,
        200,
        page(
          `Job ${j.jobId}`,
          `<p>${esc(j.kind)} · <b>${esc(j.status)}</b> ${j.error ? `<span class="bad">${esc(j.error)}</span>` : ''}</p>
          ${hasResults ? `<p><a href="/results/${esc(j.jobId)}">Download results (JSONL)</a></p>` : ''}
          ${isTerminal(j.status) ? '' : `<form method="post" action="/jobs/${esc(j.jobId)}/cancel">${csrfField}<button>Cancel</button></form>`}
          <h2>Progress</h2><pre>${esc(JSON.stringify(j.progress, null, 2))}</pre><h2>Result</h2><pre>${esc(JSON.stringify(j.result, null, 2))}</pre>
          <h2>Events</h2><table>${j.events.map((e: any) => `<tr><td>${esc(e.ts)}</td><td>${esc(e.state)}</td><td style="white-space:normal">${esc(e.message)}</td></tr>`).join('')}</table>`,
        ),
      );
    }

    m = /^\/results\/([\w-]+)$/.exec(path);
    if (m) {
      ctx.jobs.row(m[1]!);
      const f = resultsPath(ctx, m[1]!);
      if (!existsSync(f)) return send(res, 404, page('Not found', ''));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Length': String(statSync(f).size), 'Content-Disposition': `attachment; filename="${m[1]}.jsonl"` });
      return createReadStream(f).pipe(res);
    }

    return send(res, 404, page('Not found', ''));
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      const err = e instanceof RbaError ? e : new RbaError('internal', 'internal error');
      if (!res.headersSent) send(res, err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400, page('Error', `<p class="bad">${esc(redact(err.message))}</p>`));
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: never reachable from the network.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({ server, url, oneTimeLoginUrl: `${url}/login?once=${oneTime!.nonce}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function jobsTable(ctx: Ctx, n: number): string {
  return `<h2>Recent jobs</h2><table><tr><th>Job</th><th>Kind</th><th>Status</th><th>Account</th><th>Updated</th><th>Error</th></tr>${ctx.jobs
    .list(n)
    .map((j: any) => `<tr><td><a href="/jobs/${esc(j.jobId)}">${esc(j.jobId)}</a></td><td>${esc(j.kind)}</td><td>${esc(j.status)}</td><td>${esc(j.accountId ?? '—')}</td><td>${esc(j.updatedAt)}</td><td class="bad" style="white-space:normal">${esc(j.error ?? '')}</td></tr>`)
    .join('')}</table>`;
}
