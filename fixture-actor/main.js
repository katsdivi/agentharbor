/**
 * RBA controlled test fixture (Apify Actor). TEST-ONLY, not a real service.
 *
 * Serves, on the run's public container URL:
 *   /signup  -> creates a pending account and SENDS a real verification email by
 *               delivering it over SMTP straight to the recipient domain's MX
 *               servers, like any mail server does (no credentials involved).
 *               (Apify's apify/send-mail only allows the account owner's address.)
 *   /verify  -> marks the account verified and logs it in (session cookie)
 *   /login, /account, /logout
 *   /upload  -> echoes the received file's name, size and sha256
 *
 * Safety: email only to `allowedRecipientDomains`, at most `maxEmails` per run;
 * at most 20 accounts; 5 MB upload cap; exits after `lifetimeSecs`. Logs never
 * contain addresses, names, passwords or tokens.
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';

const env = process.env;
const API = (env.APIFY_API_PUBLIC_BASE_URL || env.APIFY_API_BASE_URL || 'https://api.apify.com').replace(/\/+$/, '');
const log = (event, fields = {}) => console.log(`[fixture] ${event} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`);

async function readInput() {
  const store = env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID || env.APIFY_DEFAULT_KEY_VALUE_STORE_ID;
  const key = env.ACTOR_INPUT_KEY || env.APIFY_INPUT_KEY || 'INPUT';
  const r = await fetch(`${API}/v2/key-value-stores/${store}/records/${key}`, { headers: { Authorization: `Bearer ${env.APIFY_TOKEN}` } });
  return r.ok ? r.json() : {};
}

const input = await readInput();
const allowedDomains = (input.allowedRecipientDomains || []).map((d) => String(d).toLowerCase());
const maxEmails = Math.min(Number(input.maxEmails ?? 3), 10);
const lifetimeSecs = Math.min(Math.max(Number(input.lifetimeSecs ?? 900), 60), 3600);
const publicUrl = (env.ACTOR_WEB_SERVER_URL || env.APIFY_CONTAINER_URL || '').replace(/\/+$/, '');
const port = Number(env.ACTOR_WEB_SERVER_PORT || env.APIFY_CONTAINER_PORT || 4321);

const accounts = new Map(); // email -> { name, passHash, verified, token }
const sessions = new Map(); // sid -> email
let emailsSent = 0;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>
  <p class="banner">RBA controlled test fixture - not a real service</p>${body}</body></html>`;
const send = (res, status, title, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(page(title, body));
};
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
const user = (req) => sessions.get(cookies(req).sid) || null;
const newSession = (email) => {
  const sid = crypto.randomBytes(18).toString('hex');
  sessions.set(sid, email);
  return `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax`;
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Minimal multipart/form-data parser: returns the first file part. */
function firstFile(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length + 2; // CRLF
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const part = body.subarray(start, next - 2); // strip CRLF before boundary
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const head = part.subarray(0, sep).toString('utf8');
      const fn = /filename="([^"]*)"/i.exec(head);
      if (fn) return { filename: fn[1], data: part.subarray(sep + 4) };
    }
    pos = next;
  }
  return null;
}

/** Minimal SMTP delivery to the recipient domain's MX (port 25, then 2525). */
function smtpSession(host, port, from, to, message) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 15_000 });
    let buf = '';
    let step = 0;
    let last = '';
    const steps = [
      null, // greeting
      `EHLO ${from.split('@')[1]}`,
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${to}>`,
      'DATA',
      `${message.replace(/\r?\n\./g, '\r\n..')}\r\n.`,
      'QUIT',
    ];
    const expect = [220, 250, 250, 250, 354, 250, 221];
    const done = (ok, why) => {
      sock.destroy();
      resolve({ ok, why, last });
    };
    sock.on('timeout', () => done(false, `timeout at step ${step}`));
    sock.on('error', (e) => done(false, e.code || 'error'));
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!/^\d{3} /.test(line)) continue; // continuation lines "250-..."
        const code = Number(line.slice(0, 3));
        last = String(code);
        if (code !== expect[step] && !(step === 3 && code === 251)) return done(false, `step ${step} got ${code}`);
        step++;
        if (step >= steps.length) return done(true, 'sent');
        sock.write(`${steps[step]}\r\n`);
      }
    });
  });
}

async function sendVerification(to, link) {
  const domain = to.split('@')[1];
  let mx = [];
  try {
    mx = (await dns.promises.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch (e) {
    log('send_mail', { stage: 'mx_lookup', error: e.code || 'error' });
    return false;
  }
  const host = new URL(publicUrl || 'https://fixture.invalid').hostname;
  const from = `noreply@${host}`;
  const msgId = `<${crypto.randomBytes(12).toString('hex')}@${host}>`;
  const message = [
    `From: RBA test fixture <${from}>`,
    `To: <${to}>`,
    'Subject: Confirm your RBA fixture account',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${msgId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<p>This is a TEST message from the RBA controlled test fixture.</p><p><a href="${link}">Confirm your email address</a></p>`,
  ].join('\r\n');
  for (const port of [25, 2525]) {
    for (const h of mx) {
      const r = await smtpSession(h, port, from, to, message);
      log('send_mail', { mx: h, port, ok: r.ok, why: r.why, code: r.last || 'none' });
      if (r.ok) return true;
    }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const p = u.pathname;
  const method = req.method || 'GET';
  log('request', { method, path: p.replace(/[A-Za-z0-9]{16,}/g, '[id]') });
  try {
    if (method === 'GET' && p === '/') {
      return send(res, 200, 'RBA fixture', '<h1>RBA fixture</h1><a href="/signup">Sign up</a> <a href="/login">Log in</a> <a href="/upload">Upload</a> <a href="/account">Account</a>');
    }
    if (method === 'GET' && p === '/signup') {
      return send(res, 200, 'Sign up', `<h1>Sign up</h1><form method="post" action="/signup">
        <input id="name" name="name" placeholder="Name"><input id="email" name="email" type="email" placeholder="Email">
        <input id="password" name="password" type="password" placeholder="Password"><button id="create" type="submit">Create account</button></form>`);
    }
    if (method === 'POST' && p === '/signup') {
      const f = new URLSearchParams((await readBody(req, 64 * 1024)).toString('utf8'));
      const email = (f.get('email') || '').trim().toLowerCase();
      const domain = email.split('@')[1] || '';
      if (!allowedDomains.includes(domain)) return send(res, 200, 'Sign up', '<h1>Sign up</h1><p class="error">Email domain not allowed by this fixture</p>');
      if (accounts.has(email)) return send(res, 200, 'Sign up', '<h1>Sign up</h1><p class="error">Account already exists</p>');
      if (accounts.size >= 20 || emailsSent >= maxEmails) return send(res, 429, 'Sign up', '<h1>Sign up</h1><p class="error">Fixture limit reached</p>');
      const token = crypto.randomBytes(24).toString('hex');
      accounts.set(email, { name: (f.get('name') || '').slice(0, 80), passHash: hash(f.get('password') || ''), verified: false, token });
      emailsSent++;
      const ok = await sendVerification(email, `${publicUrl}/verify?token=${token}`);
      log('signup', { emailSent: ok });
      return send(res, 200, 'Check your email', ok ? '<h1>Check your email</h1><p>We sent a confirmation link.</p>' : '<h1>Sign up</h1><p class="error">Could not send the confirmation email</p>');
    }
    if (method === 'GET' && p === '/verify') {
      const t = u.searchParams.get('token') || '';
      const entry = [...accounts.entries()].find(([, a]) => a.token && a.token === t);
      if (!entry) return send(res, 400, 'Invalid link', '<h1>Invalid or expired link</h1>');
      entry[1].verified = true;
      entry[1].token = null;
      log('verified', {});
      res.writeHead(302, { location: '/account', 'set-cookie': newSession(entry[0]) });
      return res.end();
    }
    if (method === 'GET' && p === '/login') {
      return send(res, 200, 'Log in', `<h1>Log in</h1><form method="post" action="/login"><input id="email" name="email" type="email">
        <input id="password" name="password" type="password"><button id="login" type="submit">Log in</button></form>`);
    }
    if (method === 'POST' && p === '/login') {
      const f = new URLSearchParams((await readBody(req, 64 * 1024)).toString('utf8'));
      const email = (f.get('email') || '').trim().toLowerCase();
      const a = accounts.get(email);
      if (!a || !a.verified || a.passHash !== hash(f.get('password') || '')) return send(res, 200, 'Log in', '<h1>Log in</h1><p class="error">Invalid credentials or unverified email</p>');
      res.writeHead(302, { location: '/account', 'set-cookie': newSession(email) });
      return res.end();
    }
    if (method === 'GET' && p === '/account') {
      const email = user(req);
      if (!email) {
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      const a = accounts.get(email);
      return send(res, 200, 'Account', `<h1>Account</h1><p id="who">Logged in as ${esc(a.name)} (${esc(email)})</p><p id="verified">Email verified: ${a.verified ? 'yes' : 'no'}</p><a href="/logout">Log out</a>`);
    }
    if (method === 'GET' && p === '/logout') {
      sessions.delete(cookies(req).sid);
      res.writeHead(302, { location: '/login', 'set-cookie': 'sid=; Path=/; Max-Age=0; Secure' });
      return res.end();
    }
    if (method === 'GET' && p === '/upload') {
      return send(res, 200, 'Upload', `<h1>Upload</h1><form method="post" action="/upload" enctype="multipart/form-data">
        <input type="file" id="file" name="file"><button id="upload-submit" type="submit">Upload</button></form>`);
    }
    if (method === 'POST' && p === '/upload') {
      const body = await readBody(req, 5 * 1024 * 1024 + 64 * 1024);
      const f = firstFile(body, req.headers['content-type']);
      if (!f) return send(res, 400, 'Upload', '<p class="error">No file</p>');
      const sha = crypto.createHash('sha256').update(f.data).digest('hex');
      log('upload', { bytes: f.data.length });
      return send(res, 200, 'Uploaded', `<h1>Uploaded</h1><div id="upload-result"><span class="filename">${esc(f.filename)}</span> <span class="size">${f.data.length}</span> <span class="sha256">${sha}</span></div>`);
    }
    send(res, 404, 'Not found', '<h1>Not found</h1>');
  } catch (e) {
    log('error', { name: e?.name || 'error' });
    if (!res.headersSent) send(res, 500, 'Error', '<h1>Error</h1>');
  }
});

server.listen(port, () => log('FIXTURE_LISTENING', { port, lifetimeSecs, maxEmails, domains: allowedDomains.length }));
setTimeout(() => {
  log('lifetime_reached', {});
  server.close();
  process.exit(0);
}, lifetimeSecs * 1000).unref();
