/**
 * v5 (W3, privacy and artifacts): per-run execution reports, recorded
 * acceptances of retained findings, and the versioned verification fields of
 * file artifacts. Additive only: existing rows keep NULL in the new columns,
 * which is how a verification made before policy versions is recognised (it is
 * never rewritten).
 */
import { addColumn, type Migration } from '../migrations.js';

export const v5: Migration = {
  version: 5,
  name: 'privacy_reports',
  up(sql) {
    sql.exec(`
CREATE TABLE IF NOT EXISTS run_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  job_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  report_version INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  finalized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS run_reports_run ON run_reports(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_reports_job ON run_reports(job_id);
CREATE INDEX IF NOT EXISTS run_reports_session ON run_reports(session_id);
CREATE TABLE IF NOT EXISTS file_acceptances (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  report_digest TEXT NOT NULL,
  policy TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  findings INTEGER NOT NULL,
  gaps INTEGER NOT NULL,
  job_id TEXT,
  accepted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_acceptances_artifact ON file_acceptances(artifact_id);
`);
    addColumn(sql, 'files', 'policy_version', 'INTEGER');
    addColumn(sql, 'files', 'verification_id', 'TEXT');
    addColumn(sql, 'files', 'report_digest', 'TEXT');
    addColumn(sql, 'files', 'verified_at', 'TEXT');
  },
};
