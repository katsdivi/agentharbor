import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { FileRegistry } from '../files/registry.js';
import { join } from 'node:path';
import { MailSlurpClient } from '../email/mailslurp.js';
import { ApifyProvider } from '../providers/apify.js';
import { LocalProvider } from '../providers/local.js';
import type { BrowserProvider } from '../providers/types.js';
import { Accounts } from './accounts.js';
import { loadConfig, type Config } from './config.js';
import { Vault } from './crypto.js';
import { Db } from './db.js';
import { RbaError } from './errors.js';
import { Jobs } from './jobs.js';
import { registerSecret } from './redact.js';
import { Sessions, type Providers } from './sessions.js';
import { Usage } from './usage.js';
import { Reports } from '../reports/store.js';

export interface Ctx {
  cfg: Config;
  db: Db;
  vault: Vault;
  accounts: Accounts;
  usage: Usage;
  /** Remote (Apify) provider; same as providers.remote. */
  provider: BrowserProvider | null;
  providers: Providers;
  mail: MailSlurpClient | null;
  sessions: Sessions;
  jobs: Jobs;
  dirs: { artifacts: string; results: string; uploads: string };
  files: FileRegistry;
  /** In-memory one-time verification codes keyed by job id (never persisted or returned). */
  codes: Map<string, string>;
  /** Per-run execution reports (W3; finalizeSession / finalizeJob are wired by the lead). */
  reports: Reports;
}

export interface CtxOverrides {
  cfg?: Config;
  provider?: BrowserProvider | null;
  /** Local provider override (tests); default: LocalProvider over actor/dist. */
  localProvider?: BrowserProvider | null;
  mail?: MailSlurpClient | null;
  fetchImpl?: typeof fetch;
}

export function buildContext(o: CtxOverrides = {}): Ctx {
  const cfg = o.cfg ?? loadConfig();
  for (const s of [cfg.apify.token, cfg.mailslurp.apiKey, cfg.dashboard.token]) registerSecret(s);
  const db = new Db(cfg.dataDir);
  const vault = new Vault(cfg.encryptionKey);
  const accounts = new Accounts(db, vault);
  const provider =
    o.provider !== undefined
      ? o.provider
      : cfg.apify.token && cfg.apify.actorId
        ? new ApifyProvider({ token: cfg.apify.token, actorId: cfg.apify.actorId, apiBaseUrl: cfg.apify.apiBaseUrl, build: cfg.apify.build ?? undefined })
        : null;
  const mail = o.mail !== undefined ? o.mail : cfg.mailslurp.apiKey ? new MailSlurpClient(cfg.mailslurp.apiKey, cfg.mailslurp.apiBaseUrl) : null;
  const usage = new Usage(db, cfg, provider);
  const local = o.localProvider !== undefined ? o.localProvider : new LocalProvider({ runsDir: join(cfg.dataDir, 'local-runs'), recordVideoDir: cfg.localRecordVideoDir ?? undefined });
  const providers: Providers = { remote: provider, local };
  const sessions = new Sessions(cfg, db, vault, accounts, usage, providers);
  if (o.fetchImpl) sessions.fetchImpl = o.fetchImpl;
  const dirs = {
    artifacts: join(cfg.dataDir, 'artifacts'),
    results: join(cfg.dataDir, 'results'),
    uploads: join(cfg.dataDir, 'uploads'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const ctx = { cfg, db, vault, accounts, usage, provider, providers, mail, sessions, jobs: new Jobs(db), dirs, codes: new Map(), files: new FileRegistry(db, cfg) } as Ctx;
  ctx.reports = new Reports(ctx);
  // Snapshot the execution report when a run ends (best effort: a report failure never fails the run).
  const snap = (what: string, p: Promise<unknown>) =>
    void p.catch((e) => {
      try {
        db.log('warn', `run report ${what} not finalized: ${(e as Error).message}`);
      } catch {
        /* database already closed (shutdown) */
      }
    });
  sessions.onFinished = (id) => snap(id, ctx.reports.finalizeSession(id));
  ctx.jobs.onTerminal = (id) => snap(id, ctx.reports.finalizeJob(id));
  return ctx;
}

export function requireMail(ctx: Ctx): MailSlurpClient {
  if (!ctx.mail) throw new RbaError('config_missing', 'MAILSLURP_API_KEY missing in .env; receiving email is unavailable');
  return ctx.mail;
}

/** Apply retention: old logs, job events and artifacts/results files. */
export function applyRetention(ctx: Ctx): { logs: number; files: number } {
  const logCutoff = new Date(Date.now() - ctx.cfg.retention.logDays * 86400_000).toISOString();
  const logs = ctx.db.run('DELETE FROM logs WHERE ts < ?', logCutoff).changes + ctx.db.run('DELETE FROM job_events WHERE ts < ?', logCutoff).changes;
  const fileCutoff = Date.now() - ctx.cfg.retention.artifactDays * 86400_000;
  let files = 0;
  for (const dir of [ctx.dirs.artifacts, ctx.dirs.results]) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).mtimeMs < fileCutoff) {
        rmSync(p, { force: true, recursive: true });
        files++;
      }
    }
  }
  ctx.db.run('DELETE FROM artifacts WHERE created_at < ?', new Date(fileCutoff).toISOString());
  return { logs, files };
}
