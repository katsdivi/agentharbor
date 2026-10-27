/**
 * v4 (W2): durable workflow state.
 *  - jobs.step / jobs.outcome: how far a job got and what is known about its side effect;
 *  - jobs.idempotency_key: one job per key (partial unique index);
 *  - jobs.owner_instance / heartbeat_at: process identity that survives pid reuse;
 *  - job_steps: per-step evidence, kept after a crash;
 *  - cleanup_queue: provider resources still to be released (retried with backoff).
 * Idempotent; never drops or rewrites user data (the one UPDATE only labels
 * legacy interrupted-after-submit rows with outcome_unknown).
 */
import type { DatabaseSync } from 'node:sqlite';
import { addColumn, type Migration } from '../migrations.js';

export const v4: Migration = {
  version: 4,
  name: 'workflow_state',
  up(sql: DatabaseSync) {
    addColumn(sql, 'jobs', 'step', 'TEXT');
    addColumn(sql, 'jobs', 'outcome', 'TEXT');
    addColumn(sql, 'jobs', 'idempotency_key', 'TEXT');
    addColumn(sql, 'jobs', 'owner_instance', 'TEXT');
    addColumn(sql, 'jobs', 'heartbeat_at', 'INTEGER');
    addColumn(sql, 'jobs', 'interrupted_at', 'TEXT');
    sql.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS job_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  evidence_json TEXT
);
CREATE INDEX IF NOT EXISTS job_steps_job ON job_steps(job_id);
CREATE TABLE IF NOT EXISTS cleanup_queue (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('apify_run', 'local_worker', 'mailslurp_inbox', 'lease', 'file_lock')),
  ref TEXT NOT NULL,
  job_id TEXT,
  session_id TEXT,
  account_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE(kind, ref)
);
CREATE INDEX IF NOT EXISTS cleanup_pending ON cleanup_queue(done_at, next_attempt_at);
`);
    sql.exec(`UPDATE jobs SET outcome = 'outcome_unknown' WHERE outcome IS NULL AND submitted_at IS NOT NULL AND status = 'failed' AND error LIKE 'interrupted:%'`);
  },
};
