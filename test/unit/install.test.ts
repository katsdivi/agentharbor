import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, findEnvFile, loadConfig, resolveDataDir } from '../../src/core/config.js';
import { pluginDataDir, nodeVersionOk } from '../../src/cli/install-checks.js';
import { MigrateError, migrateData } from '../../src/cli/migrate-data.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const base = mkdtempSync(join(tmpdir(), 'rba-install test-')); // space in the path on purpose
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const dir = (name: string) => {
  const d = join(base, `${n++}-${name}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const key = () => randomBytes(32).toString('base64');
function writeEnv(d: string, extra = ''): string {
  const f = join(d, '.env');
  writeFileSync(f, `RBA_ENCRYPTION_KEY=${key()}\n${extra}`, { mode: 0o600 });
  return f;
}
function makeRegistry(dataDir: string, rows = 3): void {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'registry.sqlite'));
  db.exec('create table accounts(id text primary key, origin text); create table schema_migrations(version integer primary key, name text, applied_at text)');
  for (let i = 0; i < rows; i++) db.prepare('insert into accounts values (?, ?)').run(`a${i}`, 'https://example.test');
  db.exec("insert into schema_migrations values (1, 'base', 'now')");
  db.close();
}

describe('env file and data dir resolution', () => {
  it('prefers RBA_ENV_FILE, then CLAUDE_PLUGIN_DATA, then CLAUDE_PLUGIN_ROOT', () => {
    const data = dir('pdata');
    const root = dir('proot');
    const rootEnv = writeEnv(root);
    expect(findEnvFile({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: root })).toBe(rootEnv);
    const dataEnv = writeEnv(data);
    expect(findEnvFile({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: root })).toBe(dataEnv);
    const explicit = writeEnv(dir('explicit'));
    expect(findEnvFile({ RBA_ENV_FILE: explicit, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: root })).toBe(explicit);
  });

  it('existing in-place install: root .env and <root>/data keep working when CLAUDE_PLUGIN_DATA is empty', () => {
    const root = dir('legacy root');
    writeEnv(root);
    makeRegistry(join(root, 'data'));
    const pdata = dir('empty plugin data');
    const cfg = loadConfig({ CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pdata });
    expect(cfg.envFile).toBe(join(root, '.env'));
    expect(cfg.dataDir).toBe(join(root, 'data'));
    expect(readdirSync(pdata)).toEqual([]);
  });

  it('new install: .env and data in CLAUDE_PLUGIN_DATA; no .env at all also uses CLAUDE_PLUGIN_DATA/data', () => {
    const pdata = dir('new plugin data');
    const root = dir('new root');
    expect(loadConfig({ CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pdata }).dataDir).toBe(join(pdata, 'data'));
    writeEnv(pdata);
    const cfg = loadConfig({ CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pdata });
    expect(cfg.envFile).toBe(join(pdata, '.env'));
    expect(cfg.dataDir).toBe(join(pdata, 'data'));
  });

  it('refuses when a new .env would hide existing data next to another .env', () => {
    const root = dir('old');
    writeEnv(root);
    makeRegistry(join(root, 'data'));
    const pdata = dir('fresh');
    writeEnv(pdata);
    expect(() => loadConfig({ CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pdata })).toThrow(ConfigError);
    expect(() => loadConfig({ CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pdata })).toThrow(/Refusing to start with empty data/);
    makeRegistry(join(pdata, 'data'));
    expect(() => loadConfig({ CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pdata })).toThrow(/two installs with data/);
    // An explicit choice is honoured.
    expect(loadConfig({ RBA_ENV_FILE: join(root, '.env'), CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pdata }).dataDir).toBe(join(root, 'data'));
  });

  it('RBA_DATA_DIR wins and resolves relative to the .env folder', () => {
    const d = dir('rel');
    const f = writeEnv(d);
    expect(resolveDataDir('store', f, {})).toBe(join(d, 'store'));
    expect(resolveDataDir('/abs/x', f, {})).toBe('/abs/x');
  });

  it('display name: default, custom, rejected control characters; never changes ids', () => {
    expect(loadConfig({ RBA_ENV_FILE: writeEnv(dir('dn1')) }).displayName).toBe('Remote Browser Accounts');
    expect(loadConfig({ RBA_ENV_FILE: writeEnv(dir('dn2'), 'RBA_DISPLAY_NAME=Team Browser\n') }).displayName).toBe('Team Browser');
    expect(() => loadConfig({ RBA_ENV_FILE: writeEnv(dir('dn3')), RBA_DISPLAY_NAME: 'x‮y' })).toThrow(/RBA_DISPLAY_NAME/);
  });
});

describe('install helpers', () => {
  it('names the plugin data dir the way Claude Code does', () => {
    expect(pluginDataDir('remote-browser-accounts-local', { HOME: '/h' })).toBe('/h/.claude/plugins/data/remote-browser-accounts-remote-browser-accounts-local');
    expect(pluginDataDir('m', { HOME: '/h', CLAUDE_CODE_PLUGIN_CACHE_DIR: '/c' })).toBe('/c/data/remote-browser-accounts-m');
  });
  it('node version gate', () => {
    expect(nodeVersionOk('22.12.0')).toBe(false);
    expect(nodeVersionOk('22.13.0')).toBe(true);
    expect(nodeVersionOk('24.7.0')).toBe(true);
    expect(nodeVersionOk('21.9.0')).toBe(false);
  });
});

describe('migrate-data', () => {
  function legacy(): { env: string; data: string } {
    const d = dir('src install');
    const env = writeEnv(d);
    const data = join(d, 'data');
    makeRegistry(data, 5);
    mkdirSync(join(data, 'results'), { recursive: true });
    writeFileSync(join(data, 'results', 'r.json'), '{}');
    return { env, data };
  }

  it('copies .env and data, verifies the database, leaves the source untouched', () => {
    const s = legacy();
    const before = readFileSync(s.env);
    const target = join(dir('dest'), 'plugin data');
    const r = migrateData({ sourceEnv: s.env, sourceData: s.data, targetDir: target });
    expect(r.tables.accounts).toBe(5);
    expect(readFileSync(join(target, '.env')).equals(before)).toBe(true);
    expect(statSync(join(target, '.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(target, 'data')).mode & 0o777).toBe(0o700);
    expect(existsSync(join(target, 'data', 'results', 'r.json'))).toBe(true);
    const db = new DatabaseSync(join(target, 'data', 'registry.sqlite'), { readOnly: true });
    expect((db.prepare('select count(*) as n from accounts').get() as { n: number }).n).toBe(5);
    db.close();
    expect(readFileSync(s.env).equals(before)).toBe(true);
    expect(existsSync(join(s.data, 'registry.sqlite'))).toBe(true);
    expect(r.retired).toBeNull();
  });

  it('refuses an occupied target and a database in use; never overwrites', () => {
    const s = legacy();
    const target = dir('occupied');
    writeEnv(target);
    const envBefore = readFileSync(join(target, '.env'));
    expect(() => migrateData({ sourceEnv: s.env, sourceData: s.data, targetDir: target })).toThrow(MigrateError);
    expect(readFileSync(join(target, '.env')).equals(envBefore)).toBe(true);
    writeFileSync(join(s.data, 'registry.sqlite-wal'), 'x');
    expect(() => migrateData({ sourceEnv: s.env, sourceData: s.data, targetDir: dir('t2') })).toThrow(/in use/);
  });

  it('--retire-source renames (never deletes) the source .env, after which the copy resolves', () => {
    const s = legacy();
    const root = resolve(s.env, '..');
    const pdata = dir('pd');
    migrateData({ sourceEnv: s.env, sourceData: s.data, targetDir: pdata, retireSource: true, now: new Date(0) });
    expect(existsSync(s.env)).toBe(false);
    expect(existsSync(`${s.env}.migrated-1970-01-01T00-00-00-000Z`)).toBe(true);
    const cfg = loadConfig({ CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pdata });
    expect(cfg.dataDir).toBe(join(pdata, 'data'));
  });
});

describe('init-env CLI (built)', () => {
  const cli = join(ROOT, 'dist', 'src', 'cli', 'init-env.js');
  // A checkout that is itself an in-use install (repo .env + data/registry.sqlite) makes init-env
  // refuse by design (it would hide that data); the clean-install smoke covers the fresh case.
  const repoInstallHasData = existsSync(join(ROOT, '.env')) && existsSync(join(ROOT, 'data', 'registry.sqlite'));
  it.runIf(repoInstallHasData && existsSync(cli))('refuses to create a .env that would hide this checkout\'s existing data', () => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--target', join(dir('init-refuse'), 'plugin data')], { env: { PATH: process.env.PATH!, HOME: base }, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('Nothing was written');
  });
  it.skipIf(!existsSync(cli) || repoInstallHasData)('creates <target>/.env at mode 600 without printing secrets, then never overwrites', () => {
    const target = join(dir('init'), 'plugin data');
    const env = { PATH: process.env.PATH!, HOME: base };
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--target', target], { env, encoding: 'utf8' });
    const file = join(target, '.env');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    const k = /^RBA_ENCRYPTION_KEY=(.+)$/m.exec(text)![1]!;
    expect(Buffer.from(k, 'base64').length).toBe(32);
    expect(out).not.toContain(k);
    const again = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--target', target], { env, encoding: 'utf8' });
    expect(again).toMatch(/already exists/);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it.skipIf(!existsSync(cli))('refuses to create a plugin-data .env that would shadow an install with data', () => {
    const root = dir('legacy for init');
    writeEnv(root);
    makeRegistry(join(root, 'data'));
    const target = dir('pd for init');
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--target', target], { env: { PATH: process.env.PATH!, HOME: base, CLAUDE_PLUGIN_ROOT: root }, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(existsSync(join(target, '.env'))).toBe(false);
  });
});
