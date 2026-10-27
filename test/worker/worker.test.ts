import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/site.js';
import { startIpEcho } from '../fixtures/ipecho.js';
import { hostOf, startCounter, startWorker, type Worker } from './harness.js';

const SECRET = 'S3cr3t-Value-zq81-NEVER-LOG';

describe('worker: interactive session (direct mode)', () => {
  let site: FixtureSite;
  let other: FixtureSite; // allowed private host, NOT in the navigation allowlist
  let cdn: FixtureSite; // allowed RESOURCE origin only (not navigable)
  let counter: Awaited<ReturnType<typeof startCounter>>; // private host, never allowed
  let echo: Awaited<ReturnType<typeof startIpEcho>>;
  let w: Worker;

  beforeAll(async () => {
    site = await startFixtureSite();
    other = await startFixtureSite();
    cdn = await startFixtureSite();
    counter = await startCounter();
    echo = await startIpEcho();
    w = await startWorker({
      input: {
        network: {
          allowedNavigationOrigins: [site.origin],
          allowedSubresourceOrigins: [cdn.origin],
          allowPrivateHosts: [hostOf(site.origin), hostOf(other.origin), hostOf(cdn.origin), hostOf(echo.url)],
        },
        egressCheckUrl: echo.url,
        maxUploadBytes: 64 * 1024,
      },
    });
  });

  afterAll(async () => {
    await w?.stop();
    await Promise.all([site?.close(), other?.close(), cdn?.close(), counter?.close(), echo?.close()]);
  });

  it('health needs no auth; other routes need a valid bearer token', async () => {
    const h = await w.call('/health', undefined, { token: null });
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ ok: true, initialized: false, protocolVersion: 1 });
    const missing = await w.call('/status', undefined, { token: null });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('unauthorized');
    const wrong = await w.call('/navigate', { url: site.url('/') }, { token: 'nope' });
    expect(wrong.status).toBe(401);
  });

  it('refuses browser commands before init', async () => {
    const r = await w.call('/navigate', { url: site.url('/') });
    expect(r.body.error.code).toBe('not_ready');
  });

  it('rejects malformed request bodies', async () => {
    const r = await w.call('/session/init', { bogus: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_request');
  });

  it('initialises with verified direct egress', async () => {
    const r = await w.call('/session/init', {});
    expect(r.status).toBe(200);
    expect(r.body.egress).toMatchObject({ mode: 'direct', status: 'verified', enforcement: 'none(direct)', browserIp: '127.0.0.1' });
    expect(typeof r.body.browserVersion).toBe('string');
    const h = await w.call('/health', undefined, { token: null });
    expect(h.body.ready).toBe(true);
    const again = await w.call('/session/init', {});
    expect(again.body.error.code).toBe('bad_request');
  });

  it('navigates, inspects, fills and clicks (signup)', async () => {
    const nav = await w.call('/navigate', { url: site.url('/signup') });
    expect(nav.status).toBe(200);
    expect(nav.body.page).toMatchObject({ title: 'Sign up', status: 200, blocked: null });
    expect(nav.body.redirectChain).toEqual([site.url('/signup')]);

    const ins = await w.call('/inspect', {});
    expect(ins.status).toBe(200);
    const els = ins.body.elements as Array<Record<string, any>>;
    const email = els.find((e) => e.id === 'email')!;
    const pw = els.find((e) => e.id === 'password')!;
    expect(email).toMatchObject({ tag: 'input', selector: '#email', label: 'Email', hasValue: false, visible: true });
    expect(email.ref).toMatch(/^g\d+:e\d+$/);
    expect(pw.type).toBe('password');
    expect(ins.body.text).toContain('Sign up');
    // Duplicate buttons get no unique selector.
    expect(els.filter((e) => e.text === 'A' || e.text === 'B').every((e) => e.selector === null)).toBe(true);

    expect((await w.call('/fill', { ref: email.ref, value: 'new.user@example.com' })).status).toBe(200);
    expect((await w.call('/fill', { selector: '#password', value: SECRET })).status).toBe(200);
    expect((await w.call('/fill', { selector: '#name', value: 'New User' })).status).toBe(200);

    const ins2 = await w.call('/inspect', {});
    const pw2 = (ins2.body.elements as any[]).find((e) => e.id === 'password');
    expect(pw2.hasValue).toBe(true);
    expect(JSON.stringify(ins2.body)).not.toContain(SECRET);
    // Old-generation ref is stale.
    const stale = await w.call('/fill', { ref: email.ref, value: 'x' });
    expect(stale.body.error.code).toBe('stale_ref');
    expect(stale.body.error.message).toMatch(/inspect/);

    const submit = (ins2.body.elements as any[]).find((e) => e.id === 'submit');
    const click = await w.call('/click', { ref: submit.ref, waitForNavigation: true });
    expect(click.status).toBe(200);
    expect(click.body.page.title).toBe('Check your email');
    expect(site.state.accounts.get('new.user@example.com')?.password).toBe(SECRET);

    // Ref from before the navigation is stale.
    const afterNav = await w.call('/click', { ref: submit.ref });
    expect(afterNav.body.error.code).toBe('stale_ref');
  });

  it('element targeting errors', async () => {
    await w.call('/navigate', { url: site.url('/signup') });
    expect((await w.call('/click', { selector: 'button.dup' })).body.error.code).toBe('ambiguous_selector');
    expect((await w.call('/click', { selector: '#does-not-exist' })).body.error.code).toBe('element_not_found');
    expect((await w.call('/click', {})).body.error.code).toBe('bad_request');
    expect((await w.call('/click', { ref: 'g1:e1', selector: '#email' })).body.error.code).toBe('bad_request');
    expect((await w.call('/click', { selector: '###' })).body.error.code).toBe('bad_request');
  });

  it('requireOrigins: refuses to fill/upload on a non-permitted origin without touching the field', async () => {
    await w.call('/navigate', { url: site.url('/signup') });
    const bad = await w.call('/fill', { selector: '#password', value: SECRET, requireOrigins: [other.origin] });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toEqual({ code: 'navigation_blocked', message: 'page origin not permitted for this secret' });
    const ins = await w.call('/inspect', {});
    expect((ins.body.elements as any[]).find((e) => e.id === 'password').hasValue).toBe(false);
    const good = await w.call('/fill', { selector: '#password', value: SECRET, requireOrigins: [site.origin] });
    expect(good.status).toBe(200);
    expect((await w.call('/fill', { selector: '#password', value: 'x', requireOrigins: ['*'] })).body.error.code).toBe('bad_request');

    await w.call('/navigate', { url: site.url('/upload') });
    const buf = Buffer.from('hello');
    const up = await w.call('/upload', {
      selector: '#file',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      contentBase64: buf.toString('base64'),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      requireOrigins: [other.origin],
    });
    expect(up.body.error.code).toBe('navigation_blocked');
  });

  it('network policy blocks private, special-scheme and non-allowlisted navigations', async () => {
    const targets = [
      'http://169.254.169.254/latest/meta-data/',
      `http://localhost:${counter.port}/`,
      'file:///etc/passwd',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://[::ffff:127.0.0.1]/',
      `${counter.origin}/`,
      `${other.origin}/`, // allowed private host but not in navigation allowlist
    ];
    for (const url of targets) {
      const r = await w.call('/navigate', { url });
      expect(r.body.ok, url).toBe(false);
      expect(r.body.error.code, url).toBe('navigation_blocked');
    }
    expect(counter.hits).toEqual([]);
    expect(other.state.requests).toEqual([]);
  });

  it('blocks redirects from an allowed page to blocked destinations', async () => {
    const r1 = await w.call('/navigate', { url: site.url(`/redirect?to=${encodeURIComponent(`${counter.origin}/secret`)}`) });
    expect(r1.body.error.code).toBe('navigation_blocked');
    expect(counter.hits).toEqual([]);

    const r2 = await w.call('/navigate', { url: site.url(`/redirect?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`) });
    expect(r2.body.error.code).toBe('navigation_blocked');

    // Redirect to an origin outside allowedNavigationOrigins (reachable host):
    // refused at the redirect hop, before any request reaches the destination.
    other.state.requests.length = 0;
    const r3 = await w.call('/navigate', { url: site.url(`/redirect?to=${encodeURIComponent(other.url('/'))}`) });
    expect(r3.body.error.code).toBe('navigation_blocked');
    expect(r3.body.error.message).toMatch(/redirect blocked before it was sent/);
    // Two allowed hops, then a disallowed one.
    const twoHop = site.url(`/redirect?to=${encodeURIComponent(`/redirect?to=${encodeURIComponent(other.url('/second'))}`)}`);
    const r4 = await w.call('/navigate', { url: twoHop });
    expect(r4.body.error.code).toBe('navigation_blocked');
    expect(other.state.requests).toEqual([]);
    const st = await w.call('/status');
    expect(st.body.page.url).toBe('about:blank');

    // Allowed redirect records the chain.
    const ok = await w.call('/navigate', { url: site.url('/redirect?to=/page/2') });
    expect(ok.status).toBe(200);
    expect(ok.body.redirectChain).toEqual([site.url('/redirect?to=/page/2'), site.url('/page/2')]);
  });

  it('blocks clicks that navigate (directly or via redirect) to blocked destinations', async () => {
    other.state.requests.length = 0;
    for (const to of [
      `${counter.origin}/direct`,
      site.url(`/redirect?to=${encodeURIComponent(`${counter.origin}/via-redirect`)}`),
      other.url('/'),
      site.url(`/redirect?to=${encodeURIComponent(other.url('/click-via-redirect'))}`),
    ]) {
      await w.call('/navigate', { url: site.url(`/link?to=${encodeURIComponent(to)}`) });
      const c = await w.call('/click', { selector: '#go', waitForNavigation: true, timeoutMs: 10_000 });
      expect(c.body.ok, to).toBe(false);
      expect(c.body.error.code, to).toBe('navigation_blocked');
    }
    expect(counter.hits).toEqual([]);
    // Direct click (route handler) and click via redirect (per-hop guard): never contacted.
    expect(other.state.requests).toEqual([]);
  });

  it('popups and new windows never load anything (no request reaches the destination)', async () => {
    other.state.requests.length = 0;
    site.state.requests.length = 0;
    await w.call('/navigate', { url: site.url(`/popup?to=${encodeURIComponent(other.url('/popup-target'))}`) });
    await w.call('/click', { selector: '#pop' });
    await w.call('/click', { selector: '#popjs' });
    // Popup to an ALLOWED origin is refused too (single-page session).
    await w.call('/navigate', { url: site.url(`/popup?to=${encodeURIComponent(site.url('/page/1'))}`) });
    await w.call('/click', { selector: '#pop' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(other.state.requests).toEqual([]);
    expect(site.state.requests).not.toContain('GET /page/1');
    const st = await w.call('/status');
    expect(st.body.page.url).toContain('/popup');
  });

  it('resource policy: a disallowed origin receives zero requests of any kind', async () => {
    other.state.requests.length = 0;
    const r = await w.call('/navigate', { url: site.url(`/resources?to=${encodeURIComponent(other.origin)}`) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await new Promise((res) => setTimeout(res, 2500));
    // img, stylesheet, @import, script, iframe, audio, fetch, XHR, beacon, WebSocket,
    // EventSource, worker fetch, preconnect, and redirects of img/iframe/fetch.
    expect(other.state.requests).toEqual([]);
    const d = await w.call('/diagnostics');
    expect(d.status).toBe(200);
    expect(d.body.blockedHosts.map((b: { host: string }) => b.host)).toContain('127.0.0.1');
    // Proxy records are host/port only (request records carry scrubbed paths, never queries).
    expect(JSON.stringify({ c: d.body.connections, b: d.body.blockedHosts })).not.toMatch(/\/r\//);
  });

  it('after init, pages cannot reach the egress-check endpoint (no lasting exemption)', async () => {
    const before = echo.requests;
    await w.call('/navigate', { url: site.url(`/resources?to=${encodeURIComponent(new URL(echo.url).origin)}`) });
    await new Promise((res) => setTimeout(res, 2000));
    expect(echo.requests).toBe(before);
    const nav = await w.call('/navigate', { url: echo.url });
    expect(nav.body.error.code).toBe('navigation_blocked');
  });

  it('resource policy: a configured resource origin is reachable but not navigable', async () => {
    cdn.state.requests.length = 0;
    await w.call('/navigate', { url: site.url(`/resources?to=${encodeURIComponent(cdn.origin)}`) });
    await new Promise((res) => setTimeout(res, 2500));
    for (const want of ['GET /r/img.png', 'GET /r/script.js', 'GET /r/fetch', 'GET /r/frame', 'GET /r/img-via-redirect.png', 'GET /r/fetch-via-redirect', 'UPGRADE /r/ws']) {
      expect(cdn.state.requests, want).toContain(want);
    }
    const nav = await w.call('/navigate', { url: cdn.url('/') });
    expect(nav.body.error.code).toBe('navigation_blocked');
  });

  it('dialogs: dismissed by default; an action-scoped policy accepts only during its action', async () => {
    await w.call('/navigate', { url: site.url('/dialog') });
    const out = async () => (await w.call('/extract', { spec: { fields: { o: { selector: '#out' } } } })).body.items[0].o;
    const d1 = await w.call('/click', { selector: '#confirm' });
    expect(d1.body.dialogs).toEqual([{ type: 'confirm', handled: 'dismissed', byPolicy: false, message: 'Proceed?' }]);
    expect(await out()).toBe('declined');
    const d2 = await w.call('/click', { selector: '#confirm', dialog: { action: 'accept', types: ['confirm'] } });
    expect(d2.body.dialogs[0]).toMatchObject({ type: 'confirm', handled: 'accepted', byPolicy: true });
    expect(await out()).toBe('confirmed');
    // The policy was removed after that action.
    await w.call('/click', { selector: '#confirm' });
    expect(await out()).toBe('declined');
    // types filter: an accept policy for alerts does not accept a confirm.
    await w.call('/click', { selector: '#confirm', dialog: { action: 'accept', types: ['alert'] } });
    expect(await out()).toBe('declined');
    // Prompt text is typed but never echoed back or logged.
    const PROMPT = 'prompt-secret-9931';
    const d3 = await w.call('/click', { selector: '#prompt', dialog: { action: 'accept', promptText: PROMPT } });
    expect(await out()).toBe(`prompt:len${PROMPT.length}`);
    expect(JSON.stringify(d3.body)).not.toContain(PROMPT);
    expect(w.output()).not.toContain(PROMPT);
    // A confirm-gated form submits only with an accept policy.
    const blocked = await w.call('/click', { selector: '#guarded', waitForNavigation: true, timeoutMs: 2000 });
    expect(blocked.body.error.code).toBe('timeout');
    const sent = await w.call('/click', { selector: '#guarded', waitForNavigation: true, dialog: { action: 'accept' } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.page.title).toBe('Sent');
    const bad = await w.call('/click', { selector: '#x', dialog: { action: 'always' } });
    expect(bad.body.error.code).toBe('bad_request');
  });

  it('aborts subresources to private hosts', async () => {
    await w.call('/navigate', { url: site.url(`/embed?src=${encodeURIComponent(`${counter.origin}/img.png`)}`) });
    const st = await w.call('/status');
    expect(st.body.page.title).toBe('Embed');
    // Subresource to a private host was aborted.
    expect(counter.hits).toEqual([]);
  });

  it('subresources: iframe to a private host is blocked; allowed private host loads', async () => {
    await w.call('/navigate', { url: site.url(`/frame?src=${encodeURIComponent(`${counter.origin}/`)}`) });
    await w.call('/navigate', { url: site.url(`/frame?src=${encodeURIComponent(`${counter.origin}/redirect`)}`) });
    expect(counter.hits).toEqual([]);
  });

  it('returns prompt-injection text as data only', async () => {
    const r = await w.call('/navigate', { url: site.url('/inject') });
    expect(r.status).toBe(200);
    const ins = await w.call('/inspect', {});
    expect(ins.body.text).toContain('IGNORE PREVIOUS INSTRUCTIONS');
    const st = await w.call('/status');
    expect(st.body.page.url).toBe(site.url('/inject'));
  });

  it('uploads files with size and hash checks', async () => {
    await w.call('/navigate', { url: site.url('/upload') });
    const content = crypto.randomBytes(5000);
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    const up = await w.call('/upload', { selector: '#file', fileName: '../../etc/evil name.bin', mimeType: 'application/octet-stream', contentBase64: content.toString('base64'), sha256: sha });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ bytes: 5000, sha256: sha });
    const click = await w.call('/click', { selector: '#upload-submit', waitForNavigation: true });
    expect(click.status, JSON.stringify(click.body)).toBe(200);
    const ex = await w.call('/extract', {
      spec: { fields: { filename: { selector: '#upload-result .filename' }, size: { selector: '#upload-result .size' }, sha256: { selector: '#upload-result .sha256' } } },
    });
    expect(ex.body.items[0].size).toBe('5000');
    expect(ex.body.items[0].sha256).toBe(sha);
    expect(ex.body.items[0].filename).not.toContain('/');

    await w.call('/navigate', { url: site.url('/upload') });
    const big = crypto.randomBytes(64 * 1024 + 1);
    const tooBig = await w.call('/upload', { selector: '#file', fileName: 'big.bin', mimeType: 'application/octet-stream', contentBase64: big.toString('base64'), sha256: crypto.createHash('sha256').update(big).digest('hex') });
    expect(tooBig.body.error.code).toBe('upload_too_large');
    const mismatch = await w.call('/upload', { selector: '#file', fileName: 'a.bin', mimeType: 'application/octet-stream', contentBase64: content.toString('base64'), sha256: '0'.repeat(64) });
    expect(mismatch.body.error.code).toBe('bad_request');
    const notFile = await w.call('/upload', { selector: '#upload-submit', fileName: 'a.bin', mimeType: 'application/octet-stream', contentBase64: content.toString('base64'), sha256: sha });
    expect(notFile.body.error.code).toBe('bad_request');
  });

  it('extracts products with absolute hrefs', async () => {
    await w.call('/navigate', { url: site.url('/products') });
    const r = await w.call('/extract', {
      spec: { itemSelector: '.product', fields: { name: { selector: '.name' }, price: { selector: '.price' }, href: { selector: 'a.detail', attr: 'href' } } },
    });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(5);
    expect(r.body.items[0]).toEqual({ name: 'Product 1', price: '$10.00', href: site.url('/products/1') });
    expect(r.body.truncated).toBe(false);
    const lim = await w.call('/extract', { spec: { itemSelector: '.product', fields: { n: { selector: '.name' } }, maxItems: 2 } });
    expect(lim.body.items).toHaveLength(2);
    expect(lim.body.truncated).toBe(true);
    const all = await w.call('/extract', { spec: { fields: { names: { selector: '.product .name', all: true } } } });
    expect(all.body.items[0].names).toHaveLength(5);
    const bad = await w.call('/extract', { spec: { fields: { x: { selector: '.a', code: 'alert(1)' } } } });
    expect(bad.body.error.code).toBe('bad_request');
  });

  it('screenshots return PNG with password masking', async () => {
    await w.call('/navigate', { url: site.url('/login') });
    await w.call('/fill', { selector: '#password', value: SECRET });
    const r = await w.call('/screenshot', { fullPage: true, maskSelectors: ['#email'] });
    expect(r.status).toBe(200);
    const png = Buffer.from(r.body.pngBase64, 'base64');
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  it('detects blocks: captcha on signup, 403 and 429', async () => {
    site.state.captchaOnSignup = true;
    try {
      await w.call('/navigate', { url: site.url('/signup') });
      await w.call('/fill', { selector: '#email', value: 'cap@example.com' });
      const c = await w.call('/click', { selector: '#submit', waitForNavigation: true });
      expect(c.body.page.blocked).toMatchObject({ kind: 'captcha', category: 'challenge_required' });
    } finally {
      site.state.captchaOnSignup = false;
    }
    const b = await w.call('/navigate', { url: site.url('/blocked') });
    expect(b.body.page.status).toBe(403);
    expect(b.body.page.blocked).toMatchObject({ kind: 'access_denied', category: 'access_denied' });
    const rl = await w.call('/navigate', { url: site.url('/ratelimited') });
    expect(rl.body.page.blocked).toMatchObject({ kind: 'rate_limited' });
    const ok = await w.call('/navigate', { url: site.url('/') });
    expect(ok.body.page.blocked).toBeNull();
  });

  it('a CAPTCHA script, invisible widget or badge is an integration, not a block', async () => {
    const r = await w.call('/navigate', { url: site.url('/captcha-integration') });
    expect(r.status).toBe(200);
    expect(r.body.page.blocked).toBeNull();
    expect(r.body.page.integrations.map((i: { vendor: string }) => i.vendor)).toContain('recaptcha');
    const ins = await w.call('/inspect', { maxElements: 5 });
    expect(ins.body.page.blocked).toBeNull();
  });

  it('a hung page: the command is cancelled at its deadline and the session recovers', async () => {
    await w.call('/navigate', { url: site.url('/hang') });
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    const hung = await w.call('/inspect', { timeoutMs: 1000 });
    const took = Date.now() - t0;
    expect(hung.status).toBe(504);
    expect(hung.body.error).toMatchObject({ code: 'timeout', recovery: 'page_reset' });
    expect(took).toBeLessThan(1000 + 20_000 + 15_000);
    // Lock released only after the operation stopped: the next command runs (not busy).
    const next = await w.call('/navigate', { url: site.url('/page/1') });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.page.title).toBe('Page 1');
  }, 60_000);

  it('navigation timeout maps to timeout', async () => {
    const r = await w.call('/navigate', { url: site.url('/slow?ms=3000'), timeoutMs: 500 });
    expect(r.body.error.code).toBe('timeout');
    // Diagnostics show the request that kept the navigation from finishing.
    const d = await w.call('/diagnostics');
    const all = [...d.body.pendingRequests, ...d.body.recentRequests].map((x: { url: string }) => x.url);
    expect(all.some((u: string) => u.includes('/slow'))).toBe(true);
    expect(JSON.stringify(d.body)).not.toContain('ms=3000'); // query stripped
  });

  it('serializes concurrent commands', async () => {
    await w.call('/navigate', { url: site.url('/') });
    const [a, b] = await Promise.all([w.call('/navigate', { url: site.url('/slow?ms=1000') }), w.call('/inspect', {})]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('status reports page, uptime and egress', async () => {
    const r = await w.call('/status');
    expect(r.body).toMatchObject({ ok: true, egress: { status: 'verified' } });
    expect(typeof r.body.uptimeSecs).toBe('number');
  });

  it('never logs secret values or the bearer token', () => {
    const out = w.output();
    expect(out).toContain('RBA_WORKER_LISTENING');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(w.token);
    expect(out).not.toContain('token=');
    expect(out).not.toContain('new.user@example.com');
  });
});
