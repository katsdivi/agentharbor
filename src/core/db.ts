import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { backupBeforeUpgrade, existingVersion, migrate } from './migrations.js';
import { redact } from './redact.js';

export type Row = Record<string, SQLInputValue>;

/** Schema version 1 (adopted as-is for databases created before versioned migrations). Later changes go in migrations.ts. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  target_origin TEXT NOT NULL,
  label TEXT,
  email TEXT,
  inbox_id TEXT,
  credential_blob TEXT,
  state_blob TEXT,
  state_saved_at TEXT,
  proxy_mode TEXT NOT NULL DEFAULT 'direct',
  proxy_country TEXT,
  proxy_session_key TEXT,
  status TEXT NOT NULL,
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  last_login_check_at TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS accounts_target ON accounts(target_origin);

CREATE TABLE IF NOT EXISTS leases (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL UNIQUE,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_run_id TEXT,
  container_url TEXT,
  token_blob TEXT,
  account_id TEXT,
  lease_id TEXT,
  proxy_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  egress_json TEXT,
  memory_mb INTEGER NOT NULL,
  max_minutes INTEGER NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'interactive',
  created_at TEXT NOT NULL,
  ready_at TEXT,
  closed_at TEXT,
  last_activity_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  account_id TEXT,
  session_id TEXT,
  params_json TEXT NOT NULL,
  progress_json TEXT,
  result_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  owner_pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  month TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  usd REAL,
  basis TEXT NOT NULL,
  detail_json TEXT,
  UNIQUE(provider, kind, ref)
);
CREATE INDEX IF NOT EXISTS usage_month ON usage(month);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  format TEXT NOT NULL,
  mime TEXT NOT NULL,
  origin TEXT NOT NULL,
  source_id TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  status TEXT NOT NULL,
  policy TEXT,
  verdict TEXT,
  report_json TEXT,
  locked_by TEXT,
  lock_expires INTEGER,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
`;

export class Db {
  readonly sql: DatabaseSync;
  /** Backup written before this open upgraded the schema (null when no upgrade ran). */
  upgradeBackup: string | null = null;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const file = join(dataDir, 'registry.sqlite');
    this.sql = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* first open on some FS */
    }
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    // Snapshot an existing database before any one-way schema upgrade (see migrations.ts).
    const before = existingVersion(this.sql);
    this.upgradeBackup = before === null ? null : backupBeforeUpgrade(this.sql, dataDir);
    this.sql.exec(SCHEMA);
    const applied = migrate(this.sql);
    if (applied.length) this.log('info', `schema upgraded to v${applied[applied.length - 1]}${this.upgradeBackup ? `; pre-upgrade backup ${this.upgradeBackup}` : ''}`);
    // WAL sidecars hold recent rows too; the 0700 directory protects them, and they get 0600 as well.
    for (const side of [`${file}-wal`, `${file}-shm`]) try { chmodSync(side, 0o600); } catch { /* not created yet */ }
  }

  get<T = Row>(q: string, ...params: SQLInputValue[]): T | undefined {
    return this.sql.prepare(q).get(...params) as T | undefined;
  }

  all<T = Row>(q: string, ...params: SQLInputValue[]): T[] {
    return this.sql.prepare(q).all(...params) as T[];
  }

  run(q: string, ...params: SQLInputValue[]): { changes: number } {
    const r = this.sql.prepare(q).run(...params);
    return { changes: Number(r.changes) };
  }

  /**
   * IMMEDIATE transaction: takes the write lock up front so concurrent
   * processes (MCP server, dashboard, a second Claude session) serialize.
   */
  tx<T>(fn: () => T): T {
    // Re-entrant: a nested call joins the outer transaction.
    if (this.depth > 0) return fn();
    this.sql.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = fn();
      this.sql.exec('COMMIT');
      return r;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }
  private depth = 0;

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.run('INSERT INTO logs (ts, level, message) VALUES (?, ?, ?)', nowIso(), level, redact(message));
  }

  close(): void {
    this.sql.close();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
