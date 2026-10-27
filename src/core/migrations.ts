/**
 * Versioned schema migrations.
 *
 * v1 is the original `CREATE TABLE IF NOT EXISTS` schema in db.ts, so a
 * database created by an earlier build is adopted as v1 and migrated forward.
 * Each later migration runs in its own IMMEDIATE transaction, must be
 * idempotent (check before ALTER) and must never drop or rewrite user data.
 * A database whose version is newer than this build is refused, never
 * downgraded. Version slots are reserved in docs/dev/INTERFACES.md §3.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { v3 } from './migrations/v3-operations.js';
import { v4 } from './migrations/v4-workflow.js';
import { v5 } from './migrations/v5-privacy.js';
import { v6 } from './migrations/v6-operations-privacy.js';
import { v7 } from './migrations/v7-operations-learned-proxy.js';
import { v8 } from './migrations/v8-email-modes.js';

export interface Migration {
  version: number;
  name: string;
  up(sql: DatabaseSync): void;
}

export function hasColumn(sql: DatabaseSync, table: string, column: string): boolean {
  return (sql.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

export function addColumn(sql: DatabaseSync, table: string, column: string, decl: string): void {
  if (!hasColumn(sql, table, column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Legacy worker proxy mode -> execution mode (documented derivation, see src/core/modes.ts). */
const LEGACY_MODE_SQL = `CASE WHEN proxy_mode IN ('datacenter', 'residential') THEN 'remote_proxy' ELSE 'remote_direct' END`;

export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: 'execution_modes',
    up(sql) {
      addColumn(sql, 'accounts', 'execution_mode', 'TEXT');
      addColumn(sql, 'sessions', 'execution_mode', 'TEXT');
      addColumn(sql, 'sessions', 'route_json', 'TEXT');
      // Every pre-existing account and session ran on the remote provider.
      sql.exec(`UPDATE accounts SET execution_mode = ${LEGACY_MODE_SQL} WHERE execution_mode IS NULL`);
      sql.exec(`UPDATE sessions SET execution_mode = ${LEGACY_MODE_SQL} WHERE execution_mode IS NULL`);
    },
  },
  v3,
  v4,
  v5,
  v6,
  v7,
  v8,
];

/** Worker-owned migrations register here after lead review (one file per slot under ./migrations/). */
export function allMigrations(): Migration[] {
  return [...MIGRATIONS].sort((a, b) => a.version - b.version);
}

export function latestVersion(): number {
  return allMigrations().reduce((m, x) => Math.max(m, x.version), 1);
}

export class SchemaTooNewError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`database schema version ${found} is newer than this build supports (${supported}); install the newer plugin build or point RBA_DATA_DIR at a different directory. Refusing to downgrade.`);
  }
}

export function currentVersion(sql: DatabaseSync): number {
  const r = sql.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  return r?.v ?? 0;
}

/** Bring `sql` to the latest version. Returns the versions applied. */
export function migrate(sql: DatabaseSync, migrations: Migration[] = allMigrations()): number[] {
  sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const latest = migrations.reduce((m, x) => Math.max(m, x.version), 1);
  sql.exec('BEGIN IMMEDIATE');
  try {
    sql.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)').run('base_schema', new Date().toISOString());
    sql.exec('COMMIT');
  } catch (e) {
    sql.exec('ROLLBACK');
    throw e;
  }
  const found = currentVersion(sql);
  if (found > latest) throw new SchemaTooNewError(found, latest);
  const applied: number[] = [];
  for (const m of migrations) {
    sql.exec('BEGIN IMMEDIATE');
    try {
      // Re-check inside the write lock: another process may have migrated meanwhile.
      const done = sql.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(m.version);
      if (!done) {
        m.up(sql);
        sql.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
        applied.push(m.version);
      }
      sql.exec('COMMIT');
    } catch (e) {
      sql.exec('ROLLBACK');
      throw e;
    }
  }
  return applied;
}

/** Schema version of an existing database before migration, or null for a brand-new (empty) database. */
export function existingVersion(sql: DatabaseSync): number | null {
  const tables = new Set((sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
  if (!tables.has('accounts')) return null;
  if (!tables.has('schema_migrations')) return 1;
  return currentVersion(sql) || 1;
}

/**
 * Before a database is upgraded, copy it (VACUUM INTO: a consistent snapshot even with
 * a write-ahead log) to <dataDir>/backups/registry-v<from>-before-v<to>-<time>.sqlite,
 * mode 0600. Migrations are one-way: an older build cannot be pointed at the upgraded
 * database; to go back, restore this file with the build that matches its version.
 * Returns the backup path, or null when no upgrade is pending.
 */
export function backupBeforeUpgrade(sql: DatabaseSync, dataDir: string, now = new Date()): string | null {
  const from = existingVersion(sql);
  const to = latestVersion();
  if (from === null || from >= to) return null;
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `registry-v${from}-before-v${to}-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`);
  sql.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  chmodSync(file, 0o600);
  return file;
}
