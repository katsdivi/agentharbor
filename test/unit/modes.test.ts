import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Db, SCHEMA } from '../../src/core/db.js';
import { currentVersion, latestVersion, migrate, SchemaTooNewError } from '../../src/core/migrations.js';
import { resolveRoute } from '../../src/core/modes.js';
import { testConfig, testCtx } from '../helpers/ctx.js';

const cfg = (defaultMode: 'direct' | 'datacenter' | 'residential' = 'direct', defaultExecutionMode: any = null, country: string | null = null) => ({
  proxy: { defaultMode, country },
  defaultExecutionMode,
});
const acct = (execution_mode: string | null, proxy_mode = 'direct', proxy_country: string | null = null) => ({ id: 'acct_x', execution_mode, proxy_mode, proxy_country });

describe('execution mode resolution', () => {
  it('keeps the existing default (remote_direct) for existing installs', () => {
    expect(resolveRoute({}, cfg())).toMatchObject({ mode: 'remote_direct', proxy: null, source: 'config_default', workerProxyMode: 'direct' });
    expect(resolveRoute({}, cfg('residential', null, 'DE'))).toMatchObject({ mode: 'remote_proxy', proxy: { kind: 'residential', country: 'DE' }, workerProxyMode: 'residential' });
  });

  it('maps legacy proxyMode without treating it as a fallback', () => {
    expect(resolveRoute({ proxyMode: 'direct' }, cfg())).toMatchObject({ mode: 'remote_direct', source: 'legacy_proxyMode' });
    expect(resolveRoute({ proxyMode: 'datacenter', country: 'us' }, cfg())).toMatchObject({ mode: 'remote_proxy', proxy: { kind: 'datacenter', country: 'US' } });
  });

  it('honours explicit modes', () => {
    expect(resolveRoute({ mode: 'local' }, cfg())).toMatchObject({ mode: 'local', proxy: null, workerProxyMode: 'direct', source: 'explicit' });
    expect(resolveRoute({ mode: 'remote_proxy', proxy: { kind: 'residential' } }, cfg())).toMatchObject({ mode: 'remote_proxy', workerProxyMode: 'residential' });
    expect(resolveRoute({}, cfg('direct', 'local'))).toMatchObject({ mode: 'local', source: 'config_default' });
  });

  it('refuses contradictions instead of coercing', () => {
    const bad: Array<[any, string]> = [
      [{ mode: 'remote_proxy' }, 'needs proxy.kind'],
      [{ mode: 'remote_proxy', proxyMode: 'direct' }, 'not proxyMode direct'],
      [{ mode: 'local', proxyMode: 'residential' }, 'cannot use proxyMode'],
      [{ mode: 'remote_direct', proxy: { kind: 'datacenter' } }, 'does not use a proxy'],
      [{ mode: 'local', country: 'DE' }, 'country applies only'],
      [{ mode: 'remote_proxy', proxy: { kind: 'datacenter' }, proxyMode: 'residential' }, 'contradicts'],
      [{ mode: 'anonymous' }, 'unknown execution mode'],
    ];
    for (const [req, msg] of bad) expect(() => resolveRoute(req, cfg()), JSON.stringify(req)).toThrow(msg);
  });

  it('binds accounts to their mode and refuses silent switches', () => {
    expect(resolveRoute({ account: acct('local') }, cfg())).toMatchObject({ mode: 'local', source: 'account' });
    expect(resolveRoute({ account: acct(null, 'residential', 'FR') }, cfg())).toMatchObject({ mode: 'remote_proxy', proxy: { kind: 'residential', country: 'FR' } });
    expect(() => resolveRoute({ mode: 'remote_direct', account: acct('local') }, cfg())).toThrow('bound to execution mode local');
    expect(() => resolveRoute({ mode: 'local', account: acct('remote_direct') }, cfg())).toThrow('refusing to switch routes silently');
    expect(() => resolveRoute({ proxyMode: 'datacenter', account: acct('remote_proxy', 'residential') }, cfg())).toThrow('configured for proxy residential');
    expect(() => resolveRoute({ country: 'us', account: acct('remote_proxy', 'residential', 'FR') }, cfg())).toThrow('configured for proxy country FR');
    expect(resolveRoute({ country: 'fr', account: acct('remote_proxy', 'residential', 'FR') }, cfg())).toMatchObject({ proxy: { kind: 'residential', country: 'FR' } });
  });

  it('rejects an invalid configured default', () => {
    expect(() => testConfig({ RBA_DEFAULT_EXECUTION_MODE: 'anonymous' })).toThrow('RBA_DEFAULT_EXECUTION_MODE');
    expect(() => testConfig({ RBA_DEFAULT_EXECUTION_MODE: 'remote_proxy' })).toThrow('RBA_DEFAULT_PROXY_MODE');
    expect(testConfig({ RBA_DEFAULT_EXECUTION_MODE: 'local' }).defaultExecutionMode).toBe('local');
    expect(testConfig().defaultExecutionMode).toBeNull();
  });
});

describe('schema migrations', () => {
  it('adopts a pre-migration database as v1 and backfills execution modes without losing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rba-mig-'));
    const legacy = new DatabaseSync(join(dir, 'registry.sqlite'));
    legacy.exec(SCHEMA);
    const t = new Date().toISOString();
    legacy.prepare(`INSERT INTO accounts (id, target_origin, proxy_mode, status, created_at, updated_at) VALUES ('acct_a','https://a.test','direct','active',?,?)`).run(t, t);
    legacy.prepare(`INSERT INTO accounts (id, target_origin, proxy_mode, status, created_at, updated_at) VALUES ('acct_b','https://b.test','residential','active',?,?)`).run(t, t);
    legacy.prepare(`INSERT INTO sessions (id, provider, proxy_mode, status, memory_mb, max_minutes, created_at) VALUES ('sess_a','apify','datacenter','closed',2048,10,?)`).run(t);
    legacy.close();

    const db = new Db(dir);
    expect(currentVersion(db.sql)).toBe(latestVersion());
    expect(db.all('SELECT id, execution_mode FROM accounts ORDER BY id')).toEqual([
      { id: 'acct_a', execution_mode: 'remote_direct' },
      { id: 'acct_b', execution_mode: 'remote_proxy' },
    ]);
    expect(db.get('SELECT execution_mode FROM sessions')).toEqual({ execution_mode: 'remote_proxy' });
    // Idempotent on reopen.
    expect(migrate(db.sql)).toEqual([]);
    db.close();
  });

  it('snapshots an existing database before a one-way upgrade, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rba-mig-'));
    const legacy = new DatabaseSync(join(dir, 'registry.sqlite'));
    legacy.exec(SCHEMA);
    const t = new Date().toISOString();
    legacy.prepare(`INSERT INTO accounts (id, target_origin, proxy_mode, status, created_at, updated_at) VALUES ('acct_keep','https://a.test','direct','active',?,?)`).run(t, t);
    legacy.close();
    const db = new Db(dir);
    expect(db.upgradeBackup).toMatch(/backups\/registry-v1-before-v\d+-.*\.sqlite$/);
    expect(statSync(db.upgradeBackup!).mode & 0o777).toBe(0o600);
    db.close();
    // The backup is the pre-upgrade database: v1 schema (no execution_mode column), same rows.
    const b = new DatabaseSync(readdirSync(join(dir, 'backups')).map((f) => join(dir, 'backups', f))[0]!, { readOnly: true });
    expect(b.prepare('SELECT id FROM accounts').all()).toEqual([{ id: 'acct_keep' }]);
    expect((b.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>).some((c) => c.name === 'execution_mode')).toBe(false);
    b.close();
    // Already current: no second backup; a brand-new database gets none.
    expect(new Db(dir).upgradeBackup).toBeNull();
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
    const fresh = mkdtempSync(join(tmpdir(), 'rba-mig-'));
    expect(new Db(fresh).upgradeBackup).toBeNull();
  });

  it('v7 repairs a registry migrated through the original v3 (no learned_proxy_json column)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rba-mig-'));
    const db0 = new Db(dir);
    // Simulate the original v3 table: drop the column the edited v3 now creates, and pretend v7 never ran.
    db0.sql.exec('ALTER TABLE operations DROP COLUMN learned_proxy_json');
    db0.sql.exec('DELETE FROM schema_migrations WHERE version >= 7');
    db0.close();
    const db = new Db(dir);
    expect((db.sql.prepare('PRAGMA table_info(operations)').all() as Array<{ name: string }>).some((c) => c.name === 'learned_proxy_json')).toBe(true);
    expect(db.upgradeBackup).toMatch(/registry-v6-before-v8-/);
    db.close();
  });

  it('refuses a database newer than this build instead of downgrading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rba-mig-'));
    const db = new Db(dir);
    db.run(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', ?)`, new Date().toISOString());
    db.close();
    expect(() => new Db(dir)).toThrow(SchemaTooNewError);
  });

  it('accounts record the bound mode', () => {
    const ctx = testCtx();
    const a = ctx.accounts.create({ targetOrigin: 'https://a.test', proxyMode: 'direct', executionMode: 'local', status: 'unknown' });
    expect(ctx.accounts.view(a).executionMode).toBe('local');
    const b = ctx.accounts.create({ targetOrigin: 'https://a.test', proxyMode: 'datacenter', status: 'unknown' });
    expect(ctx.accounts.view(b).executionMode).toBe('remote_proxy');
    expect(() => ctx.accounts.create({ targetOrigin: 'https://a.test', proxyMode: 'datacenter', executionMode: 'local', status: 'unknown' })).toThrow('does not match');
  });

  it('remote modes without a provider are refused, never run locally', async () => {
    const ctx = testCtx({ RBA_ALLOWED_ORIGINS: 'https://a.test' });
    await expect(ctx.sessions.start({ mode: 'remote_direct' })).rejects.toThrow('Not falling back to local execution');
    await expect(ctx.sessions.start({ mode: 'remote_proxy', proxy: { kind: 'datacenter' } })).rejects.toThrow('Not falling back to local execution');
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')!.n).toBe(0);
  });

  it('local mode without a local provider is refused, never run remotely', async () => {
    const ctx = testCtx({ RBA_ALLOWED_ORIGINS: 'https://a.test' }, { localProvider: null });
    await expect(ctx.sessions.start({ mode: 'local' })).rejects.toThrow('Not falling back to a remote worker');
  });
});
