import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { RbaError } from '../../src/core/errors.js';
import { migrate } from '../../src/core/migrations.js';
import { createServer } from '../../src/mcp/server.js';
import { MissingRefError, InputError, buildRequest, carriesArgs, checkArgs, sensitiveHeaders } from '../../src/operations/request.js';
import { refusal, reviewSummary } from '../../src/operations/review.js';
import { LIMITS, exampleLeaks, stripExamples, type SpecEnvelope } from '../../src/operations/store.js';
import { opStore } from '../../src/operations/service.js';
import { OperationSchema, type Operation } from '../../src/vendor/api-anything/spec.js';
import { testConfig, testCtx } from '../helpers/ctx.js';

const base = (over: Record<string, unknown> = {}): Operation =>
  OperationSchema.parse({
    name: 'search',
    request: { method: 'GET', url: 'https://shop.example/api/search?q=sqlite&lang=en', headers: { accept: 'application/json', 'x-csrf-token': 'tok' } },
    slots: [{ param: 'query', at: ['query:q'] }, { ref: 'cookie:csrf', at: ['header:x-csrf-token'] }],
    trigger: { url: 'https://shop.example/search?q={query}' },
    match: { method: 'GET', host: 'shop.example', path: '/api/search' },
    response: { format: 'json', extract: 'hits' },
    params: [{ name: 'query', type: 'string', example: 'sqlite' }],
    readOnly: true,
    ...over,
  });

const cookie = (name: string, value: string, domain: string) => ({ name, value, domain, path: '/', expires: -1, httpOnly: false, secure: false });

describe('operations: config and schema', () => {
  it('RBA_OPERATIONS_ENABLED defaults off and parses strictly', () => {
    expect(testConfig({}).operations.enabled).toBe(false);
    expect(testConfig({ RBA_OPERATIONS_ENABLED: 'true' }).operations.enabled).toBe(true);
    expect(testConfig({ RBA_OPERATIONS_ENABLED: '0' }).operations.enabled).toBe(false);
    expect(() => testConfig({ RBA_OPERATIONS_ENABLED: 'yes please' })).toThrow('RBA_OPERATIONS_ENABLED');
  });

  it('migration v3 creates the tables once and is idempotent', () => {
    const ctx = testCtx();
    const versions = ctx.db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version);
    expect(versions).toContain(3);
    for (const t of ['operations', 'operation_private', 'operation_captures', 'operation_calls']) {
      expect(ctx.db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t), t).toBeTruthy();
    }
    // Re-running does nothing and keeps data.
    expect(migrate(ctx.db.sql)).toEqual([]);
    ctx.db.close();
  });

  it('the tools answer config_missing while disabled', async () => {
    const ctx = testCtx();
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const mcp = new Client({ name: 't', version: '0' });
    await mcp.connect(b);
    const r = (await mcp.callTool({ name: 'operation_list', arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error.code).toBe('config_missing');
    await mcp.close();
    ctx.db.close();
  });
});

describe('operations: read-only review', () => {
  it('refuses GraphQL mutations and methods other than GET/HEAD/POST', () => {
    expect(refusal(base())).toBeNull();
    expect(refusal(base({ request: { method: 'PUT', url: 'https://shop.example/api/x', headers: {} } }))).toContain('PUT');
    expect(refusal(base({ request: { method: 'DELETE', url: 'https://shop.example/api/x', headers: {} } }))).toContain('DELETE');
    const gql = base({ request: { method: 'POST', url: 'https://shop.example/graphql', headers: {}, body: '{"query":"mutation { deleteItem(id: 1) { ok } }"}' } });
    expect(refusal(gql)).toContain('mutation');
    const gqlRead = base({ request: { method: 'POST', url: 'https://shop.example/graphql', headers: {}, body: '{"query":"query Search { items { name } }"}' } });
    expect(refusal(gqlRead)).toBeNull();
  });

  it('never treats a method as proof of read-only: POST and suspicious words are flagged for the reviewer', () => {
    const post = reviewSummary(base({ request: { method: 'POST', url: 'https://shop.example/api/orders/submit', headers: {}, body: '{"q":"x"}' } }));
    expect(post.warnings.join(' ')).toMatch(/method POST/);
    expect(post.warnings.join(' ')).toMatch(/body/);
    expect(post.warnings.join(' ')).toMatch(/state-changing/);
    const clicky = reviewSummary(base({ trigger: { url: 'https://shop.example/', steps: [{ action: 'click', selector: '#go' }] } }));
    expect(clicky.warnings.join(' ')).toMatch(/clicks/);
    // GET gets no method warning, but the review still lists what is sent.
    const get = reviewSummary(base());
    expect(get).toMatchObject({ method: 'GET', host: 'shop.example', path: '/api/search', queryKeys: ['q', 'lang'], references: [{ ref: 'cookie:csrf', at: ['header:x-csrf-token'] }] });
  });
});

describe('operations: stored spec holds no samples or session values', () => {
  it('blanks param places (keeping JSON types) and drops examples', () => {
    const op = base({
      request: { method: 'POST', url: 'https://shop.example/api/search', headers: {}, body: '{"q":"sqlite","page":42,"exact":true}' },
      slots: [{ param: 'query', at: ['body', 'json:/q'] }, { param: 'page', at: ['body', 'json:/page'] }],
      params: [{ name: 'query', type: 'string', example: 'sqlite' }, { name: 'page', type: 'number', example: 42 }],
    });
    const s = stripExamples(op);
    expect(JSON.parse(s.request.body!)).toEqual({ q: '', page: 0, exact: true });
    expect(s.params.every((p) => p.example === undefined)).toBe(true);
    expect(exampleLeaks(s, [{ query: 'sqlite' }])).toEqual([]);
    expect(exampleLeaks(op, [{ query: 'sqlite' }])).toEqual(['query']);
    // A number param is still sent as a JSON number after blanking.
    const req = buildRequest(s, checkArgs(s, { query: 'duckdb', page: '3' }), { cookies: [], values: {} });
    expect(JSON.parse(req.body!)).toEqual({ q: 'duckdb', page: 3, exact: true });
  });
});

describe('operations: request filling', () => {
  it('fills params, never builds a Cookie header, resolves cookie refs only from cookies sent to that URL', () => {
    const op = stripExamples(base());
    const vals = checkArgs(op, { query: 'duck db' });
    const req = buildRequest(op, vals, { cookies: [cookie('csrf', 'abc123', 'shop.example'), cookie('sid', 'secret-sid', 'shop.example')], values: {} });
    expect(req.url).toBe('https://shop.example/api/search?q=duck%20db&lang=en');
    expect(req.headers['x-csrf-token']).toBe('abc123');
    expect(req.headers.cookie).toBeUndefined();
    // Another site's cookie with the same name is never used.
    expect(() => buildRequest(op, vals, { cookies: [cookie('csrf', 'other', 'evil.example')], values: {} })).toThrow(MissingRefError);
    expect(sensitiveHeaders(op).sort()).toEqual(['authorization', 'x-csrf-token']);
  });

  it('refuses unknown or missing args before anything is sent', () => {
    const op = base();
    expect(() => checkArgs(op, { query: 'x', extra: 1 })).toThrow(InputError);
    expect(() => checkArgs(op, {})).toThrow(InputError);
    const typed = base({ params: [{ name: 'query', type: 'number' }] });
    expect(() => checkArgs(typed, { query: 'abc' })).toThrow(InputError);
  });

  it('accepts a page answer only when it carries the call args at the param places', () => {
    const op = base();
    const vals = { query: 'duck db' };
    expect(carriesArgs(op, { method: 'GET', url: 'https://shop.example/api/search?q=duck+db&lang=en', headers: {} }, vals)).toBe(true);
    expect(carriesArgs(op, { method: 'GET', url: 'https://shop.example/api/search?q=sqlite&lang=en', headers: {} }, vals)).toBe(false);
    expect(carriesArgs(op, { method: 'GET', url: 'https://shop.example/api/search?lang=en', headers: {} }, vals)).toBe(false);
  });
});

describe('operations: store bounds', () => {
  const env = (op: Operation): SpecEnvelope => ({ v: 1, operation: stripExamples(op), resultShape: {} });

  it('binds a review to the exact spec and bounds the call log and repairs', () => {
    const ctx = testCtx();
    const store = opStore(ctx);
    const row = store.insert({ name: 'search', accountId: null, targetOrigin: 'https://shop.example', envelope: env(base()), learnedMode: 'remote_direct', priv: { examples: [{ query: 'sqlite' }, { query: 'postgres' }], sessionValues: {} } });
    expect(row.status).toBe('draft');
    expect(() => store.markReviewed(row.id, 'f'.repeat(64))).toThrow(RbaError);
    expect(store.markReviewed(row.id, row.spec_sha256).status).toBe('reviewed');
    // Same name in the same scope is refused.
    expect(() => store.insert({ name: 'search', accountId: null, targetOrigin: 'https://shop.example', envelope: env(base()), learnedMode: 'remote_direct', priv: { examples: [{}, {}], sessionValues: {} } })).toThrow('already exists');
    // Private data is encrypted at rest.
    const blob = ctx.db.get<{ blob: string }>('SELECT blob FROM operation_private WHERE operation_id = ?', row.id)!.blob;
    expect(blob).not.toContain('sqlite');
    expect(store.private(row.id).examples[0]).toEqual({ query: 'sqlite' });
    for (let i = 0; i < LIMITS.callLogPerOperation + 25; i++) store.logCall({ operationId: row.id, mode: 'local', tier: 1, cls: 'ok', ms: 1 });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM operation_calls WHERE operation_id = ?', row.id)!.n).toBe(LIMITS.callLogPerOperation);
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    store.takeRepair(row.id, t0);
    expect(() => store.takeRepair(row.id, t0 + 60_000)).toThrow('minutes ago');
    store.takeRepair(row.id, t0 + LIMITS.repairCooldownMs);
    store.takeRepair(row.id, t0 + 2 * LIMITS.repairCooldownMs);
    expect(() => store.takeRepair(row.id, t0 + 3 * LIMITS.repairCooldownMs)).toThrow('repair limit');
    // A replaced spec needs a new review.
    expect(store.replaceSpec(row.id, env(base({ name: 'search2' }))).status).toBe('needs_review');
    ctx.db.close();
  });
});
