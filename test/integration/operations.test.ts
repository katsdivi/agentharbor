/**
 * Saved read operations end to end, with real workers:
 *  - local mode (LocalProvider runs actor/dist as a child process);
 *  - remote_proxy through the fake Apify API + a test forward proxy, with a
 *    socket spy proving this process never connects to the target site.
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../src/core/context.js';
import { buildContext } from '../../src/core/context.js';
import { RbaError } from '../../src/core/errors.js';
import { redact, redactDeep } from '../../src/core/redact.js';
import * as ops from '../../src/operations/service.js';
import { ApifyProvider } from '../../src/providers/apify.js';
import { startFakeApify } from '../fakes/apify.js';
import { startIpEcho } from '../fixtures/ipecho.js';
import { startOperationsSite, type OpsSite } from '../fixtures/operations-site.js';
import { startTestProxy } from '../fixtures/proxy.js';
import { testConfig, testCtx } from '../helpers/ctx.js';

const json = (v: unknown) => JSON.stringify(v);

async function expectRba(p: Promise<unknown> | (() => unknown), code: string, text?: string) {
  let err: unknown;
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(err, 'expected an error').toBeInstanceOf(RbaError);
  expect((err as RbaError).code).toBe(code);
  if (text) expect((err as RbaError).message).toContain(text);
}

function sidCookie(site: OpsSite, sid: string) {
  return { cookies: [{ name: 'sid', value: sid, domain: new URL(site.origin).hostname, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
}

describe('saved operations: disabled by default', () => {
  it('every operation entry point answers config_missing while RBA_OPERATIONS_ENABLED is unset', async () => {
    const ctx = testCtx({});
    expect(ctx.cfg.operations.enabled).toBe(false);
    await expectRba(() => ops.list(ctx, {}), 'config_missing', 'RBA_OPERATIONS_ENABLED');
    await expectRba(ops.call(ctx, { operationId: 'op_x', args: {} }), 'config_missing');
    ctx.db.close();
  });
});

describe('saved operations in local mode', () => {
  let site: OpsSite;
  let ctx: Ctx;
  let alice: string;
  let bob: string;
  let aliceSid: string;

  beforeAll(async () => {
    site = await startOperationsSite();
    ctx = testCtx({
      RBA_ALLOWED_ORIGINS: site.origin,
      RBA_AUTHORIZED_TARGETS: site.origin,
      RBA_ALLOW_PRIVATE_HOSTS: new URL(site.origin).host,
      RBA_OPERATIONS_ENABLED: 'true',
      RBA_MAX_CONCURRENT_SESSIONS: '3',
    });
    aliceSid = site.addUser('alice');
    const bobSid = site.addUser('bob');
    alice = ctx.accounts.create({ targetOrigin: site.origin, proxyMode: 'direct', executionMode: 'local', status: 'active', label: 'alice' }).id;
    bob = ctx.accounts.create({ targetOrigin: site.origin, proxyMode: 'direct', executionMode: 'local', status: 'active', label: 'bob' }).id;
    ctx.accounts.saveState(alice, sidCookie(site, aliceSid) as never);
    ctx.accounts.saveState(bob, sidCookie(site, bobSid) as never);
  });
  afterAll(async () => {
    for (const id of ctx.sessions.ownedIds()) await ctx.sessions.close(id).catch(() => undefined);
    ctx.sessions.stopHeartbeat();
    await site.close();
    ctx.db.close();
  });

  let searchOp = '';

  it('learns a public read operation as a draft that cannot be called before review', async () => {
    const r = await ops.learn(ctx, {
      name: 'search',
      public: true,
      mode: 'local',
      trigger: { url: `${site.origin}/search?q={query}` },
      examples: [{ query: 'sqlite' }, { query: 'postgres' }],
      readOnly: true,
    });
    searchOp = r.operationId;
    expect(r.status).toBe('draft');
    expect(r.learnedIn.mode).toBe('local');
    expect(r.review).toMatchObject({ method: 'GET', path: '/api/search', queryKeys: ['q', 'lang'], bodyPresent: false, minTier: 1 });
    // The arg fills the query string and the Referer header template.
    expect(r.review.params).toEqual([{ name: 'query', type: 'string', places: [['query:q'], ['header:referer']] }]);
    expect(json(r.untrusted.preview)).toContain('Result 1 for sqlite');
    // Examples are private: not in the stored spec.
    const row = ctx.db.get<{ spec_json: string }>('SELECT spec_json FROM operations WHERE id = ?', r.operationId)!;
    expect(row.spec_json).not.toContain('sqlite');
    expect(row.spec_json).not.toContain('postgres');
    await expectRba(ops.call(ctx, { operationId: r.operationId, args: { query: 'duckdb' } }), 'conflict', 'must be reviewed');
    await expectRba(() => ops.review(ctx, { operationId: r.operationId, specSha256: '0'.repeat(64), confirmReadOnly: true }), 'conflict');
    expect(ops.review(ctx, { operationId: r.operationId, specSha256: r.specSha256, confirmReadOnly: true }).status).toBe('reviewed');
  }, 120_000);

  it('repeats the extraction with new args via HTTP replay in the worker (tier 1)', async () => {
    const before = site.state.requests.length;
    const r = await ops.call(ctx, { operationId: searchOp, args: { query: 'duck db' } });
    expect(r).toMatchObject({ ok: true, class: 'ok', tier: 1, mode: 'local' });
    expect(json(r.untrusted!.data)).toContain('Result 1 for duck db');
    const seen = site.state.requests.slice(before);
    expect(seen.map((x) => x.path)).toEqual(['/api/search']);
    expect(seen[0]!.query).toBe('?q=duck%20db&lang=en');
  }, 120_000);

  it('refuses input errors before sending anything', async () => {
    const before = site.state.requests.length;
    const r = await ops.call(ctx, { operationId: searchOp, args: { query: 'x', other: 'y' } });
    expect(r).toMatchObject({ ok: false, class: 'input', sent: false });
    expect(r.untrusted.reason).toContain('unknown param "other"');
    expect(site.state.requests.length).toBe(before);
  });

  it('validates only with inputs different from the learning examples, and checks the result shape', async () => {
    await expectRba(ops.validate(ctx, { operationId: searchOp, args: { query: 'SQLite' } }), 'invalid_input', 'differ from the learning example');
    const v = await ops.validate(ctx, { operationId: searchOp, args: { query: 'mysql' } });
    expect(v).toMatchObject({ ok: true, valid: true });
  }, 120_000);

  it('falls back to the browser in the same mode when replay fails, and reports it', async () => {
    site.state.requirePageToken = true;
    try {
      const r = await ops.call(ctx, { operationId: searchOp, args: { query: 'redis' } });
      expect(r).toMatchObject({ ok: true, tier: 3, mode: 'local' });
      expect(r.attempts.map((a) => [a.tier, a.class])).toEqual([[1, 'auth'], [3, 'ok']]);
      expect(json(r.untrusted!.data)).toContain('Result 1 for redis');
      const noFallback = await ops.call(ctx, { operationId: searchOp, args: { query: 'redis' }, allowBrowserFallback: false });
      expect(noFallback).toMatchObject({ ok: false, class: 'auth', tier: 1 });
      expect(noFallback.untrusted.data).toBeUndefined();
    } finally {
      site.state.requirePageToken = false;
    }
  }, 120_000);

  it('fails truthfully on drift, and a repair needs a new review', async () => {
    site.state.shapeChanged = true;
    try {
      const r = await ops.call(ctx, { operationId: searchOp, args: { query: 'mongodb' } });
      expect(r.ok).toBe(false);
      expect(r.class).toBe('drift');
      expect(r.untrusted.data).toBeUndefined();
      const v = await ops.validate(ctx, { operationId: searchOp, args: { query: 'mongodb' } });
      expect(v.valid).toBe(false);

      const rep = await ops.call(ctx, { operationId: searchOp, args: { query: 'mongodb' }, allowRepair: true });
      expect(rep.ok).toBe(false);
      expect(rep.repair).toMatchObject({ attempted: true, changed: true, status: 'needs_review' });
      await expectRba(ops.call(ctx, { operationId: searchOp, args: { query: 'mongodb' } }), 'conflict');
      // Bounded: a second repair right away is refused by the cooldown.
      const sha = (rep.repair as { specSha256: string }).specSha256;
      ops.review(ctx, { operationId: searchOp, specSha256: sha, confirmReadOnly: true });
      const after = await ops.call(ctx, { operationId: searchOp, args: { query: 'mongodb' } });
      expect(after).toMatchObject({ ok: true, tier: 1 });
      expect(json(after.untrusted!.data)).toContain('Result for mongodb');
      site.state.shapeChanged = false;
      const again = await ops.call(ctx, { operationId: searchOp, args: { query: 'mongodb' }, allowRepair: true });
      expect(again.ok).toBe(false);
      expect(again.repair).toMatchObject({ attempted: false });
      expect(String((again.repair as { reason: string }).reason)).toContain('minutes ago');
    } finally {
      site.state.shapeChanged = false;
    }
  }, 180_000);

  let signedOp = '';

  it('a single-use signature cannot be replayed: tier 1 is refused, the browser answers (tier 3)', async () => {
    const r = await ops.learn(ctx, { name: 'signed', public: true, mode: 'local', trigger: { url: `${site.origin}/signed?q={q}` }, examples: [{ q: 'alpha' }, { q: 'bravo' }], readOnly: true });
    // The nonce and signature are references (values kept encrypted, out of the spec).
    expect(r.review.references.map((x) => x.at[0])).toEqual(['query:nonce', 'query:sig']);
    signedOp = r.operationId;
    ops.review(ctx, { operationId: r.operationId, specSha256: r.specSha256, confirmReadOnly: true });
    const c = await ops.call(ctx, { operationId: r.operationId, args: { q: 'charlie' } });
    expect(c).toMatchObject({ ok: true, tier: 3, mode: 'local' });
    expect(c.attempts.map((a) => [a.tier, a.class, a.status])).toEqual([[1, 'blocked', 403], [3, 'ok', 200]]);
    expect(json(c.untrusted!.data)).toContain('Signed item for charlie');
    const refused = await ops.call(ctx, { operationId: r.operationId, args: { q: 'charlie' }, allowBrowserFallback: false });
    expect(refused).toMatchObject({ ok: false, class: 'blocked', tier: 1 });
  }, 180_000);

  let ordersOp = '';

  it('scopes an account operation to its account; the spec holds no session values', async () => {
    const r = await ops.learn(ctx, {
      name: 'orders',
      accountId: alice,
      trigger: { url: `${site.origin}/orders?status={status}` },
      examples: [{ status: 'open' }, { status: 'closed' }],
      readOnly: true,
    });
    ordersOp = r.operationId;
    expect(r.learnedIn.mode).toBe('local');
    expect(r.scope).toEqual({ accountId: alice });
    const row = ctx.db.get<{ spec_json: string }>('SELECT spec_json FROM operations WHERE id = ?', r.operationId)!;
    expect(row.spec_json).not.toContain(aliceSid);
    ops.review(ctx, { operationId: r.operationId, specSha256: r.specSha256, confirmReadOnly: true });

    const c = await ops.call(ctx, { operationId: ordersOp, args: { status: 'shipped' } });
    expect(c).toMatchObject({ ok: true, tier: 1, mode: 'local' });
    expect(json(c.untrusted!.data)).toContain('alice-shipped-1');
    expect(json(c.untrusted!.data)).not.toContain('bob');

    expect(ops.list(ctx, { accountId: bob }).map((o) => o.operationId)).not.toContain(ordersOp);
    expect(ops.list(ctx, { accountId: alice, includePublic: false }).map((o) => o.operationId)).toEqual([ordersOp]);
  }, 180_000);

  it("refuses to run an account's operation in another account's session or an account-less session", async () => {
    const bobSession = await ctx.sessions.start({ accountId: bob, mode: 'local', maxMinutes: 3 });
    const anon = await ctx.sessions.start({ mode: 'local', maxMinutes: 3 });
    try {
      const before = site.state.requests.length;
      await expectRba(ops.call(ctx, { operationId: ordersOp, args: { status: 'open' }, sessionId: bobSession.sessionId }), 'forbidden', 'another account');
      await expectRba(ops.call(ctx, { operationId: ordersOp, args: { status: 'open' }, sessionId: anon.sessionId }), 'forbidden');
      await expectRba(ops.call(ctx, { operationId: searchOp, args: { query: 'public' }, sessionId: bobSession.sessionId }), 'forbidden', 'Public operations');
      expect(site.state.requests.length).toBe(before);
      // A public operation in an account-less session works, in that session's mode.
      const ok = await ops.call(ctx, { operationId: signedOp, args: { q: 'public' }, sessionId: anon.sessionId });
      expect(ok).toMatchObject({ ok: true, mode: 'local', sessionId: anon.sessionId });
    } finally {
      await ctx.sessions.close(bobSession.sessionId);
      await ctx.sessions.close(anon.sessionId);
    }
  }, 180_000);

  it('refuses an explicit route that differs from the account binding', async () => {
    await expectRba(ops.call(ctx, { operationId: ordersOp, args: { status: 'open' }, mode: 'remote_direct' }), 'invalid_input', 'bound to execution mode local');
  });

  it('deleting the operation removes its private data and call log', async () => {
    ops.remove(ctx, { operationId: ordersOp });
    expect(ctx.db.get('SELECT 1 FROM operation_private WHERE operation_id = ?', ordersOp)).toBeUndefined();
    expect(ctx.db.get('SELECT 1 FROM operation_calls WHERE operation_id = ?', ordersOp)).toBeUndefined();
  });
});

describe('saved operations are private by default (local mode)', () => {
  let site: OpsSite;
  let ctx: Ctx;
  let alice: string;
  let bob: string;
  let A: { uid: string; email: string };
  let opId = '';
  /** Every form of alice's identity that must not leave the vault. */
  const forms = () => [A.uid, A.email, encodeURIComponent(A.email), A.email.split('@')[0]!];
  const clean = (v: unknown, what: string) => {
    const s = json(v);
    for (const f of forms()) expect(s, `${what} must not contain ${f}`).not.toContain(f);
  };

  beforeAll(async () => {
    site = await startOperationsSite();
    ctx = testCtx({
      RBA_ALLOWED_ORIGINS: site.origin,
      RBA_AUTHORIZED_TARGETS: site.origin,
      RBA_ALLOW_PRIVATE_HOSTS: new URL(site.origin).host,
      RBA_OPERATIONS_ENABLED: 'true',
      RBA_MAX_CONCURRENT_SESSIONS: '3',
    });
    const aliceSid = site.addUser('alice');
    const bobSid = site.addUser('bob');
    A = site.state.profiles.get('alice')!;
    alice = ctx.accounts.create({ targetOrigin: site.origin, proxyMode: 'direct', executionMode: 'local', status: 'active', label: 'alice', email: A.email }).id;
    bob = ctx.accounts.create({ targetOrigin: site.origin, proxyMode: 'direct', executionMode: 'local', status: 'active', label: 'bob' }).id;
    ctx.accounts.saveState(alice, sidCookie(site, aliceSid) as never);
    ctx.accounts.saveState(bob, sidCookie(site, bobSid) as never);
  });
  afterAll(async () => {
    for (const id of ctx.sessions.ownedIds()) await ctx.sessions.close(id).catch(() => undefined);
    ctx.sessions.stopHeartbeat();
    await site.close();
    ctx.db.close();
  });

  it("parameterizes the account's user id and email (path, query, header, JSON body) as encrypted account constants", async () => {
    const r = await ops.learn(ctx, {
      name: 'my_orders',
      accountId: alice,
      trigger: { url: `${site.origin}/me/orders?status={status}` },
      examples: [{ status: 'open' }, { status: 'closed' }],
      readOnly: true,
    });
    opId = r.operationId;
    // The learn result (review summary, warnings, preview) carries none of it.
    clean(r, 'learn result');
    expect(r.review.path).not.toContain(A.uid);
    // Every place that carried the id or email is a reference now. The learner itself keeps the repeated
    // email as a session: value; the numeric id (path and body) becomes an account constant here.
    const refs = (p: string) => r.review.references.filter((x) => x.at.join(' > ') === p).map((x) => x.ref);
    for (const p of ['body > json:/userId', 'header:x-account-email', 'path:2', 'query:owner']) expect(refs(p), p).toHaveLength(1);
    expect(refs('path:2')[0]).toMatch(/^session:rba-account\//);
    expect(refs('body > json:/userId')[0]).toBe(refs('path:2')[0]);
    expect(r.privacy).toMatchObject({ exportable: false, boundTo: { accountId: alice, origin: site.origin, route: { mode: 'local', proxyKind: null } } });
    // Stored spec: no literal; the values are in the vault-encrypted private record only.
    const row = ctx.db.get<Record<string, unknown>>('SELECT * FROM operations WHERE id = ?', opId)!;
    clean(row, 'operations row');
    const blob = ctx.db.get<{ blob: string }>('SELECT blob FROM operation_private WHERE operation_id = ?', opId)!.blob;
    for (const f of forms()) expect(blob).not.toContain(f);
    ops.review(ctx, { operationId: opId, specSha256: r.specSha256, confirmReadOnly: true });

    // The constants are filled back at call time: the site sees alice's id in the path again.
    const before = site.state.requests.length;
    const c = await ops.call(ctx, { operationId: opId, args: { status: 'shipped' } });
    expect(c).toMatchObject({ ok: true, tier: 1, mode: 'local' });
    expect(json(c.untrusted!.data)).toContain('alice-shipped-1');
    const sent = site.state.requests.slice(before).filter((x) => x.path.startsWith('/api/'));
    expect(sent.map((x) => x.path)).toEqual([`/api/users/${A.uid}/orders`]);
    clean({ ...c, untrusted: { reason: c.untrusted.reason, attemptReasons: c.untrusted.attemptReasons } }, 'call result');
  }, 180_000);

  it('redacts account identifiers locally in operation outputs, not process-wide: account_list still shows the email', async () => {
    // A failing first attempt quotes the request (with alice's id and email) in its reason.
    const real = A.email;
    site.state.profiles.set('alice', { ...A, email: `changed.${A.email}` });
    let c;
    try {
      c = await ops.call(ctx, { operationId: opId, args: { status: 'pending' } });
    } finally {
      site.state.profiles.set('alice', { ...A, email: real });
    }
    expect(c.attempts[0]).toMatchObject({ tier: 1, class: 'blocked', status: 403 });
    clean({ reason: c.untrusted.reason, attemptReasons: c.untrusted.attemptReasons, repair: c.repair }, 'call reasons');
    // Errors of the operation tools are redacted locally too.
    let err: unknown;
    try {
      await ops.learn(ctx, { name: 'my_orders', accountId: alice, trigger: { url: `${site.origin}/me/orders?status={status}` }, examples: [{ status: 'open' }, { status: 'closed' }], readOnly: true, match: { path: `/api/users/${A.uid}/nothing` } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RbaError);
    clean((err as RbaError).message, 'learn error');
    // The global redactor (every MCP response and log line) does not hide the account's identifiers.
    expect(redact(A.email)).toBe(A.email);
    expect(redact(A.uid)).toBe(A.uid);
    expect(json(redactDeep(ctx.accounts.view(ctx.accounts.row(alice))))).toContain(A.email);
  }, 180_000);

  it('never shows them via operation_list / includeSpec, the call log, or the run report; spec export is disabled', async () => {
    const list = ops.list(ctx, { includeSpec: true });
    clean(list, 'operation_list includeSpec');
    const mine = list.find((o) => o.operationId === opId)!;
    expect(mine.spec).toMatchObject({ exportable: false });
    expect(json(mine.spec)).not.toContain('"request"');
    expect(json(mine.spec)).not.toContain('"slots"');
    clean(ctx.db.all('SELECT * FROM operation_calls WHERE operation_id = ?', opId), 'operation_calls');
    const sessions = ctx.db.all<{ id: string }>("SELECT id FROM sessions WHERE account_id = ? AND purpose = 'operation'", alice);
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) clean(await ctx.reports.get({ sessionId: s.id }), `run_report ${s.id}`);
    clean(ctx.db.all('SELECT * FROM run_reports'), 'run_reports table');
  }, 60_000);

  it("refuses account B's session and account-less sessions, before anything is sent", async () => {
    const bobSession = await ctx.sessions.start({ accountId: bob, mode: 'local', maxMinutes: 3 });
    const anon = await ctx.sessions.start({ mode: 'local', maxMinutes: 3 });
    try {
      const before = site.state.requests.length;
      await expectRba(ops.call(ctx, { operationId: opId, args: { status: 'open' }, sessionId: bobSession.sessionId }), 'forbidden', 'another account');
      await expectRba(ops.call(ctx, { operationId: opId, args: { status: 'open' }, sessionId: anon.sessionId }), 'forbidden');
      await expectRba(ops.validate(ctx, { operationId: opId, args: { status: 'pending' }, sessionId: bobSession.sessionId }), 'forbidden');
      expect(site.state.requests.length).toBe(before);
    } finally {
      await ctx.sessions.close(bobSession.sessionId);
      await ctx.sessions.close(anon.sessionId);
    }
  }, 120_000);

  it("refuses cross-account reuse: a row moved to account B no longer decrypts its constants", async () => {
    const before = site.state.requests.length;
    ctx.db.run('UPDATE operations SET account_id = ? WHERE id = ?', bob, opId);
    try {
      await expectRba(ops.call(ctx, { operationId: opId, args: { status: 'open' } }), 'forbidden', 'bound to another account');
    } finally {
      ctx.db.run('UPDATE operations SET account_id = ? WHERE id = ?', alice, opId);
    }
    expect(site.state.requests.length).toBe(before);
  });

  it("refuses after the account's execution mode or target origin changed", async () => {
    const before = site.state.requests.length;
    ctx.db.run("UPDATE accounts SET execution_mode = 'remote_direct' WHERE id = ?", alice);
    try {
      await expectRba(ops.call(ctx, { operationId: opId, args: { status: 'open' } }), 'forbidden', 'execution route changed');
    } finally {
      ctx.db.run("UPDATE accounts SET execution_mode = 'local' WHERE id = ?", alice);
    }
    ctx.db.run("UPDATE accounts SET target_origin = 'https://elsewhere.example' WHERE id = ?", alice);
    try {
      await expectRba(ops.call(ctx, { operationId: opId, args: { status: 'open' } }), 'forbidden', 'target origin changed');
    } finally {
      ctx.db.run('UPDATE accounts SET target_origin = ? WHERE id = ?', site.origin, alice);
    }
    expect(site.state.requests.length).toBe(before);
    // Unchanged again: it runs.
    expect((await ops.call(ctx, { operationId: opId, args: { status: 'open' } })).ok).toBe(true);
  }, 120_000);

  it('an operation saved before the privacy rules (privacy_version NULL) is not callable', async () => {
    ctx.db.run('UPDATE operations SET privacy_version = NULL WHERE id = ?', opId);
    try {
      await expectRba(ops.call(ctx, { operationId: opId, args: { status: 'open' } }), 'conflict', 'before');
      expect(ops.list(ctx, { accountId: alice }).find((o) => o.operationId === opId)!.callable).toBe(false);
    } finally {
      ctx.db.run('UPDATE operations SET privacy_version = 1 WHERE id = ?', opId);
    }
  });

  it('refuses to save a public operation whose request carries a private-looking literal', async () => {
    const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM operations')!.n;
    let err: RbaError | undefined;
    try {
      await ops.learn(ctx, { name: 'newsletter', public: true, mode: 'local', trigger: { url: `${site.origin}/newsletter?topic={topic}` }, examples: [{ topic: 'sqlite' }, { topic: 'postgres' }], readOnly: true });
    } catch (e) {
      err = e as RbaError;
    }
    expect(err).toBeInstanceOf(RbaError);
    expect(err!.code).toBe('forbidden');
    expect(err!.message).toContain('public operation');
    expect(err!.message).toContain('query:subscriber');
    expect(err!.message).not.toContain(site.state.newsletterSubscriber);
    expect(err!.message).not.toContain(site.state.newsletterSubscriber.split('@')[0]);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM operations')!.n).toBe(n);
  }, 120_000);

  it('refuses a public operation whose trigger URL holds a registered account email', async () => {
    await expectRba(
      ops.learn(ctx, { name: 'leaky', public: true, mode: 'local', trigger: { url: `${site.origin}/search?q={query}&who=${encodeURIComponent(A.email)}` }, examples: [{ query: 'sqlite' }, { query: 'postgres' }], readOnly: true }),
      'forbidden',
      'trigger.url',
    );
  }, 120_000);
});

describe('saved operations in remote_proxy mode (fake Apify, test proxy)', () => {
  it('learns and calls through the worker and proxy; this process never connects to the target', async () => {
    const site = await startOperationsSite();
    const echo = await startIpEcho();
    const proxy = await startTestProxy({ egressIp: '203.0.113.7' });
    const apify = await startFakeApify({ proxyUrl: proxy.url });
    const sitePort = Number(new URL(site.origin).port);
    const cfg = testConfig({
      APIFY_TOKEN: apify.token,
      APIFY_ACTOR_ID: 'tester~remote-browser-worker',
      RBA_ALLOWED_ORIGINS: site.origin,
      RBA_ALLOW_PRIVATE_HOSTS: [site.origin, echo.url].map((u) => new URL(u).host).join(','),
      RBA_EGRESS_CHECK_URL: echo.url,
      RBA_MONTHLY_BUDGET_USD: '10',
      RBA_MAX_CONCURRENT_SESSIONS: '2',
      RBA_OPERATIONS_ENABLED: 'true',
    });
    const provider = new ApifyProvider({ token: apify.token, actorId: 'tester~remote-browser-worker', apiBaseUrl: apify.url, allowInsecureContainerUrl: true, pollIntervalMs: 150, startupTimeoutMs: 60_000 });
    const ctx = buildContext({ cfg, provider, mail: null, localProvider: null });

    // Socket spy: every TCP connection this process opens. The test forward proxy runs in this
    // process too (it plays the provider's proxy); its connections are recorded separately.
    const connects: number[] = [];
    const proxyConnects: number[] = [];
    const orig = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      const a0 = args[0] as { port?: number } | number | unknown[];
      const opt = Array.isArray(a0) ? (a0[0] as { port?: number }) : a0;
      const port = typeof opt === 'number' ? opt : typeof opt === 'object' && opt ? Number((opt as { port?: number }).port) : NaN;
      if ((new Error().stack ?? '').includes('fixtures/proxy.ts')) proxyConnects.push(port);
      else connects.push(port);
      return (orig as (...x: unknown[]) => net.Socket).apply(this, args);
    } as typeof orig;
    try {
      const route = { mode: 'remote_proxy' as const, proxy: { kind: 'datacenter' as const } };
      const r = await ops.learn(ctx, { name: 'search', public: true, ...route, trigger: { url: `${site.origin}/search?q={query}` }, examples: [{ query: 'sqlite' }, { query: 'postgres' }], readOnly: true });
      expect(r.learnedIn.mode).toBe('remote_proxy');
      ops.review(ctx, { operationId: r.operationId, specSha256: r.specSha256, confirmReadOnly: true });
      const before = site.state.requests.length;
      const c = await ops.call(ctx, { operationId: r.operationId, args: { query: 'proxied call' }, ...route });
      expect(c).toMatchObject({ ok: true, tier: 1, mode: 'remote_proxy' });
      expect(json(c.untrusted!.data)).toContain('Result 1 for proxied call');
      expect(site.state.requests.slice(before).map((x) => x.path)).toEqual(['/api/search']);
      // The worker's fetch left through the upstream proxy (CONNECT tunnel to the site);
      // the browser's page loads were absolute-URI proxy requests (marked by the test proxy).
      expect(proxy.requests).toContain(`CONNECT ${new URL(site.origin).host}`);
      expect(site.state.requests.filter((x) => x.path === '/search').every((x) => x.viaProxy)).toBe(true);
      // Browser fallback in the same mode, still through the proxy.
      site.state.requirePageToken = true;
      const fb = await ops.call(ctx, { operationId: r.operationId, args: { query: 'fallback' }, ...route });
      expect(fb).toMatchObject({ ok: true, tier: 3, mode: 'remote_proxy' });
      expect(site.state.requests.filter((x) => x.path === '/search').every((x) => x.viaProxy)).toBe(true);
      // No connection from THIS process to the target site, in any step.
      expect(connects.length).toBeGreaterThan(0);
      expect(connects).not.toContain(sitePort);
      // The spy does see connections to the site: those of the stand-in provider proxy.
      expect(proxyConnects).toContain(sitePort);
    } finally {
      net.Socket.prototype.connect = orig;
      for (const id of ctx.sessions.ownedIds()) await ctx.sessions.close(id).catch(() => undefined);
      ctx.sessions.stopHeartbeat();
      ctx.db.close();
      await apify.close();
      await proxy.close();
      await echo.close();
      await site.close();
    }
  }, 240_000);
});
