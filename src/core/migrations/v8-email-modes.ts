/**
 * v8: email modes (kept / disposable) for account inboxes, see docs/CLAUDE-ACC-PLUGIN.md §4.
 *  - inbox_meta: one row per account inbox: mode, the sites it is bound to (only mail
 *    from those sender sites is surfaced), the disposable open window, and lifecycle state;
 *  - inbox_tombstones: salted one-way hashes of retired or deleted addresses, so an
 *    address is never reused and nothing readable is kept after deletion.
 * Accounts created before v8 get a row lazily (mode kept) on first use.
 * Idempotent; never drops or rewrites user data.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrations.js';

export const v8: Migration = {
  version: 8,
  name: 'email_modes',
  up(sql: DatabaseSync) {
    sql.exec(`
CREATE TABLE IF NOT EXISTS inbox_meta (
  account_id TEXT PRIMARY KEY,
  inbox_id TEXT,
  address TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('kept', 'disposable')),
  bound_sites_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'retired', 'deleted')),
  created_at INTEGER NOT NULL,
  open_until INTEGER,
  extended INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER,
  retire_at INTEGER,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  last_trim_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_meta_status ON inbox_meta(mode, status);
CREATE TABLE IF NOT EXISTS inbox_tombstones (
  hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
  },
};
