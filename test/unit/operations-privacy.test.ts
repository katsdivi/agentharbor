import { describe, expect, it } from 'vitest';
import { RbaError } from '../../src/core/errors.js';
import { migrate } from '../../src/core/migrations.js';
import { buildRequest } from '../../src/operations/request.js';
import { KnownValues, findPrivate, privatizeAccountOperation, redactPrivate, redactPrivateDeep, sanitizeShape, scanStored, secretLike } from '../../src/operations/privacy.js';
import { list, opStore } from '../../src/operations/service.js';
import { stripExamples } from '../../src/operations/store.js';
import { OperationSchema, type Operation } from '../../src/vendor/api-anything/spec.js';
import { testCtx } from '../helpers/ctx.js';

const UID = '48213377';
const EMAIL = 'alice.k@corp.example';
const WS = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const op = (over: Record<string, unknown> = {}): Operation =>
  OperationSchema.parse({
    name: 'orders',
    request: {
      method: 'POST',
      url: `https://app.example/api/users/${UID}/orders?owner=${encodeURIComponent(EMAIL)}&status=open&lang=en`,
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-workspace': WS, referer: `https://app.example/w/${WS}/orders?status=open` },
      body: JSON.stringify({ userId: UID, status: 'open', page: 1 }),
    },
    slots: [
      { param: 'status', at: ['query:status'] },
      { param: 'status', at: ['body', 'json:/status'] },
      { param: 'status', at: ['header:referer'], template: `https://app.example/w/${WS}/orders?status={status}` },
    ],
    trigger: { url: 'https://app.example/orders?status={status}' },
    match: { method: 'POST', host: 'app.example', path: `/api/users/${UID}/orders` },
    response: { format: 'json', extract: 'orders' },
    params: [{ name: 'status', type: 'string', example: 'open' }],
    readOnly: true,
    ...over,
  });

const none = new KnownValues([]);

describe('operations privacy: detection', () => {
  it('finds emails, UUIDs, JWTs, long tokens and known values; ids only outside strict mode', () => {
    expect(findPrivate(`x ${EMAIL} y`, none, true).map((h) => h.kind)).toContain('email address');
    expect(findPrivate(encodeURIComponent(EMAIL), none, true).map((h) => h.kind)).toContain('email address');
    expect(findPrivate(WS, none, true).map((h) => h.kind)).toContain('UUID');
    expect(findPrivate('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123456', none, true).map((h) => h.kind)).toContain('JWT');
    expect(findPrivate('Qm9vX3k2ZmJ4LTk4c0RhUXpL', none, true).map((h) => h.kind)).toContain('long token');
    expect(findPrivate('acme-team', new KnownValues(['ACME-team']), true).map((h) => h.kind)).toEqual(['known private value']);
    expect(findPrivate(UID, none, true)).toEqual([]);
    expect(findPrivate(UID, none, false).map((h) => h.kind)).toEqual(['numeric id']);
    // Ordinary request text is not private.
    for (const s of ['application/json', '/api/search', 'page-1-sort-relevance', 'en-US,en;q=0.9', 'persistedQueryHash', '2026-10-12']) {
      expect(findPrivate(s, none, true), s).toEqual([]);
    }
  });

  it('only true secrets qualify for the process-wide redactor, never plain account identifiers', () => {
    for (const v of [EMAIL, WS, UID, 'alice', 'workspace-main']) expect(secretLike(v), v).toBe(false);
    for (const v of ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123456', 'Qm9vX3k2ZmJ4LTk4c0RhUXpL', 'a3f9c2e1b7d04f6a8c9e0b1d2f3a4c5e']) expect(secretLike(v), v).toBe(true);
    expect(redactPrivate(`id ${UID} failed`, none, true)).toBe('id [private] failed');
    expect(redactPrivate(`id ${UID} failed`, none)).toContain(UID);
  });

  it('redacts private-looking literals and known values from free text', () => {
    const t = `GET https://app.example/api/users/${UID}/orders?owner=${encodeURIComponent(EMAIL)} failed for ${WS}`;
    const r = redactPrivate(t, new KnownValues([UID]));
    for (const v of [UID, EMAIL, encodeURIComponent(EMAIL), WS]) expect(r).not.toContain(v);
    expect(r).toContain('https://app.example/api/users/');
    const d = redactPrivateDeep({ a: [EMAIL], [EMAIL]: 1 }, none);
    expect(JSON.stringify(d.value)).not.toContain(EMAIL);
    expect(d.redacted).toBe(2);
  });
});

describe('operations privacy: account constants', () => {
  it('turns ids and emails in path, query, header, body and around a param into encrypted-ref constants, and fills them back', () => {
    const p = privatizeAccountOperation(stripExamples(op()), new KnownValues([EMAIL]));
    expect(p.findings).toEqual([]);
    const stored = JSON.stringify(p.operation);
    for (const v of [UID, EMAIL, encodeURIComponent(EMAIL), WS]) expect(stored).not.toContain(v);
    expect(Object.values(p.constants).sort()).toEqual([EMAIL, UID, WS].sort());
    expect(p.operation.match.path).toBe('/api/users/*/orders');
    expect(scanStored(p.operation, {}, new KnownValues([EMAIL]))).toEqual([]);
    // At call time the constants come from the private record (session values).
    const req = buildRequest(p.operation, { status: 'shipped' }, { cookies: [], values: p.constants });
    expect(req.url).toBe(`https://app.example/api/users/${UID}/orders?owner=${encodeURIComponent(EMAIL)}&status=shipped&lang=en`);
    expect(req.headers['x-workspace']).toBe(WS);
    expect(req.headers.referer).toBe(`https://app.example/w/${WS}/orders?status=shipped`);
    expect(JSON.parse(req.body!)).toEqual({ userId: UID, status: 'shipped', page: 1 });
  });

  it('refuses what cannot become a reference: a private literal in the trigger URL or description, a JSON key, a numeric JSON value', () => {
    const k = new KnownValues([]);
    const trig = privatizeAccountOperation(stripExamples(op({ trigger: { url: `https://app.example/u/${EMAIL}/orders?status={status}` } })), k);
    expect(scanStored(trig.operation, {}, k).map((f) => f.where)).toContain('trigger.url');
    const desc = privatizeAccountOperation(stripExamples(op({ description: `orders of ${EMAIL}` })), k);
    expect(scanStored(desc.operation, {}, k).map((f) => f.where)).toContain('description');
    const key = op();
    key.request.body = JSON.stringify({ [EMAIL]: { status: 'open' } });
    key.slots = [{ param: 'status', at: ['query:status'] }];
    expect(privatizeAccountOperation(stripExamples(key), k).findings.map((f) => f.where)).toContain('request body key name');
    const num = op();
    num.request.body = JSON.stringify({ userId: Number(UID), status: 'open' });
    expect(privatizeAccountOperation(stripExamples(num), k).findings[0]!.where).toContain('number JSON value');
  });

  it('a public operation is checked strictly: private-looking literals anywhere are findings', () => {
    const k = new KnownValues([]);
    const where = scanStored(stripExamples(op()), {}, k).map((f) => f.where);
    expect(where).toEqual(expect.arrayContaining(['request query:owner', 'request header:x-workspace', 'request header:referer (template)']));
    expect(scanStored(stripExamples(op()), { [`by.${EMAIL}`]: 'string' }, k).map((f) => f.where)).toContain('result shape');
    expect(sanitizeShape({ [`users.${UID}.name`]: 'string', 'items[].id': 'string' }, k)).toEqual({ 'users.*.name': 'string', 'items[].id': 'string' });
  });
});

describe('operations privacy: storage, binding, no export', () => {
  const env = (o: Operation) => ({ v: 1 as const, operation: stripExamples(o), resultShape: {} });
  const pub = () => OperationSchema.parse({ ...op(), request: { method: 'GET', url: 'https://app.example/api/search?q=x', headers: {} }, slots: [{ param: 'q', at: ['query:q'] }], match: {}, params: [{ name: 'q' }] });

  it('migration v6 adds the binding columns once (additive, idempotent)', () => {
    const ctx = testCtx();
    const cols = ctx.db.all<{ name: string }>('PRAGMA table_info(operations)').map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['privacy_version', 'bound_origin', 'bound_route_json']));
    expect(ctx.db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version)).toContain(6);
    expect(migrate(ctx.db.sql)).toEqual([]);
    ctx.db.close();
  });

  it('binds the private record to the scope: a row moved to another account does not decrypt', () => {
    const ctx = testCtx({ RBA_OPERATIONS_ENABLED: 'true' });
    const a = ctx.accounts.create({ targetOrigin: 'https://app.example', proxyMode: 'direct', executionMode: 'local', status: 'active' }).id;
    const b = ctx.accounts.create({ targetOrigin: 'https://app.example', proxyMode: 'direct', executionMode: 'local', status: 'active' }).id;
    const store = opStore(ctx);
    const row = store.insert({ name: 'o', accountId: a, targetOrigin: 'https://app.example', envelope: env(pub()), learnedMode: 'local', boundOrigin: 'https://app.example', priv: { examples: [{ q: 'a' }, { q: 'b' }], sessionValues: { 'rba-account/1': UID } } });
    expect(row.privacy_version).toBe(1);
    expect(JSON.parse(row.bound_route_json!)).toEqual({ mode: 'local', proxyKind: null });
    expect(store.private(row.id).sessionValues['rba-account/1']).toBe(UID);
    ctx.db.run('UPDATE operations SET account_id = ? WHERE id = ?', b, row.id);
    let err: unknown;
    try {
      store.private(row.id);
    } catch (e) {
      err = e;
    }
    expect((err as RbaError).code).toBe('forbidden');
    ctx.db.run("UPDATE operations SET account_id = ?, bound_origin = 'https://other.example' WHERE id = ?", a, row.id);
    expect(() => store.private(row.id)).toThrow('bound to another account');
    ctx.db.close();
  });

  it('operation_list includeSpec returns a redacted review summary, never the request template', () => {
    const ctx = testCtx({ RBA_OPERATIONS_ENABLED: 'true' });
    const store = opStore(ctx);
    // A row as an older build could have stored it (literals in the template): includeSpec still shows none.
    const leaky = OperationSchema.parse({ ...op(), slots: [{ param: 'status', at: ['query:status'] }] });
    const row = store.insert({ name: 'legacy', accountId: null, targetOrigin: 'https://app.example', envelope: { v: 1, operation: leaky, resultShape: {} }, learnedMode: 'local', priv: { examples: [{ status: 'a' }, { status: 'b' }], sessionValues: {} } });
    ctx.db.run('UPDATE operations SET privacy_version = NULL WHERE id = ?', row.id);
    const [v] = list(ctx, { includeSpec: true });
    const s = JSON.stringify(v);
    for (const x of [UID, EMAIL, encodeURIComponent(EMAIL), WS]) expect(s).not.toContain(x);
    expect(v!.spec).toMatchObject({ exportable: false, review: { path: '/api/users/[private]/orders' } });
    expect((v!.spec as { privateLiteralsRedacted: number }).privateLiteralsRedacted).toBeGreaterThan(0);
    expect(s).not.toContain('"request"');
    expect(v!.callable).toBe(false);
    expect(v!.privacy).toMatchObject({ version: null });
    ctx.db.close();
  });
});
