/**
 * v3 (W1): saved read operations. Additive only (new tables and indexes).
 *
 *  - operations: one learned READ operation, scoped to an account (account_id)
 *    or public (NULL). spec_json holds the vendored api-anything Operation with
 *    references only (cookie:/session: slots); no credentials, examples or
 *    captured values. Callable only when status = 'reviewed' and the review
 *    was made on exactly this spec (reviewed_sha256 = spec_sha256).
 *  - operation_private: vault-encrypted per-operation private data (example
 *    args, session: ref values). Never exported.
 *  - operation_captures: vault-encrypted captured exchanges with a hard expiry.
 *  - operation_calls: outcome log (no args, no data), bounded per operation.
 */
import type { Migration } from '../migrations.js';

export const v3: Migration = {
  version: 3,
  name: 'saved_operations',
  up(sql) {
    sql.exec(`
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  target_origin TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_sha256 TEXT NOT NULL,
  upstream_rev TEXT NOT NULL,
  read_only_declared INTEGER NOT NULL CHECK (read_only_declared = 1),
  status TEXT NOT NULL CHECK (status IN ('draft', 'reviewed', 'needs_review', 'disabled')),
  reviewed_at TEXT,
  reviewed_sha256 TEXT,
  min_tier INTEGER NOT NULL DEFAULT 1,
  learned_mode TEXT NOT NULL,
  learned_proxy_json TEXT, -- added after v3 shipped to a real registry; v7 adds it to those (never edit an applied migration again)
  repair_count INTEGER NOT NULL DEFAULT 0,
  last_repair_at TEXT,
  last_ok_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS operations_scope_name ON operations (COALESCE(account_id, ''), name);
CREATE TABLE IF NOT EXISTS operation_private (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
  blob TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_captures (
  id TEXT PRIMARY KEY,
  operation_id TEXT REFERENCES operations(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  blob TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operation_captures_expiry ON operation_captures (expires_at);
CREATE TABLE IF NOT EXISTS operation_calls (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  mode TEXT NOT NULL,
  tier INTEGER,
  class TEXT NOT NULL,
  ms INTEGER,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS operation_calls_op ON operation_calls (operation_id, at);
`);
  },
};
