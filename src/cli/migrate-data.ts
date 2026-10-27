#!/usr/bin/env node
/**
 * Copies an existing install (its .env and data folder) to a new location, normally
 * the folder Claude Code keeps across plugin updates. It copies and never moves or
 * deletes: the source stays exactly as it was. Never prints configuration values.
 *
 *   migrate-data --target <dir>                copy to <dir>/.env and <dir>/data
 *   migrate-data --plugin-data <marketplace>   copy to ~/.claude/plugins/data/remote-browser-accounts-<marketplace>
 *   migrate-data --user-config                 copy to ~/.config/remote-browser-accounts (outside the plugin folder;
 *                                              kept across updates and uninstall; recommended)
 *   --from-env <file>                          source .env (default: the one in use)
 *   --retire-source                            afterwards rename the source .env to .env.migrated-<time>
 *                                              (nothing is deleted) so the copy is the one in use
 *
 * Refuses when the target already has a .env or a registry, or when the source
 * database has an unflushed write-ahead log (a running server): stop Claude Code first.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hasRegistry, loadConfig, userConfigDir } from '../core/config.js';
import { pluginDataDir } from './install-checks.js';

export interface MigrateResult {
  sourceEnv: string;
  sourceData: string;
  targetEnv: string;
  targetData: string;
  tables: Record<string, number>;
  filesCopied: number;
  retired: string | null;
}

export class MigrateError extends Error {}

const DB_FILES = new Set(['registry.sqlite', 'registry.sqlite-wal', 'registry.sqlite-shm', 'registry.sqlite-journal']);

function tableCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  const names = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as Array<{ name: string }>;
  for (const { name } of names) out[name] = (db.prepare(`select count(*) as n from "${name.replace(/"/g, '""')}"`).get() as { n: number }).n;
  return out;
}

function lockDown(p: string): number {
  let n = 0;
  if (statSync(p).isDirectory()) {
    chmodSync(p, 0o700);
    for (const e of readdirSync(p)) n += lockDown(join(p, e));
  } else {
    chmodSync(p, 0o600);
    n++;
  }
  return n;
}

export function migrateData(o: { sourceEnv: string; sourceData: string; targetDir: string; retireSource?: boolean; now?: Date }): MigrateResult {
  const targetEnv = join(o.targetDir, '.env');
  const targetData = join(o.targetDir, 'data');
  if (!existsSync(o.sourceEnv)) throw new MigrateError(`source .env not found: ${o.sourceEnv}`);
  if (resolve(o.sourceData) === resolve(targetData)) throw new MigrateError('source and target are the same folder');
  if (existsSync(targetEnv)) throw new MigrateError(`target already has a .env: ${targetEnv}. Nothing was copied.`);
  if (hasRegistry(targetData)) throw new MigrateError(`target already has data: ${targetData}. Nothing was copied.`);
  const srcDb = join(o.sourceData, 'registry.sqlite');
  const wal = `${srcDb}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new MigrateError('the source database is in use (non-empty write-ahead log). Quit Claude Code sessions using this plugin and the dashboard, then retry. Nothing was copied.');
  }

  mkdirSync(targetData, { recursive: true, mode: 0o700 });
  // Everything except the live database files, which are copied consistently below.
  if (existsSync(o.sourceData)) {
    for (const e of readdirSync(o.sourceData)) {
      if (DB_FILES.has(e)) continue;
      cpSync(join(o.sourceData, e), join(targetData, e), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    }
  }
  let tables: Record<string, number> = {};
  if (hasRegistry(o.sourceData)) {
    const src = new DatabaseSync(srcDb, { readOnly: true });
    try {
      tables = tableCounts(src);
      src.exec(`VACUUM INTO '${join(targetData, 'registry.sqlite').replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    const dst = new DatabaseSync(join(targetData, 'registry.sqlite'), { readOnly: true });
    try {
      const ic = (dst.prepare('pragma integrity_check').get() as Record<string, string>)['integrity_check'];
      if (ic !== 'ok') throw new MigrateError(`integrity check of the copy failed (${ic}); the source is untouched. Remove ${o.targetDir} before retrying.`);
      const copied = tableCounts(dst);
      for (const [t, n] of Object.entries(tables)) {
        if (copied[t] !== n) throw new MigrateError(`row count mismatch in ${t} (${n} vs ${copied[t]}); the source is untouched. Remove ${o.targetDir} before retrying.`);
      }
    } finally {
      dst.close();
    }
  }
  copyFileSync(o.sourceEnv, targetEnv);
  chmodSync(o.targetDir, 0o700);
  chmodSync(targetEnv, 0o600);
  const filesCopied = lockDown(targetData);

  let retired: string | null = null;
  if (o.retireSource) {
    retired = `${o.sourceEnv}.migrated-${(o.now ?? new Date()).toISOString().replace(/[:.]/g, '-')}`;
    renameSync(o.sourceEnv, retired);
  }
  return { sourceEnv: o.sourceEnv, sourceData: o.sourceData, targetEnv, targetData, tables, filesCopied, retired };
}

const isMain = process.argv[1] && resolve(process.argv[1]).replace(/\.ts$/, '.js').endsWith(join('cli', 'migrate-data.js'));
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const t = opt('--target');
    const m = opt('--plugin-data');
    const u = argv.includes('--user-config') ? userConfigDir(process.env) : null;
    if (!t && !m && !u) throw new MigrateError('pass --user-config, --target <dir> or --plugin-data <marketplace>');
    const targetDir = t ? resolve(t) : u ? u : pluginDataDir(m!);
    const fromEnv = opt('--from-env');
    const cfg = loadConfig(fromEnv ? { ...process.env, RBA_ENV_FILE: resolve(fromEnv) } : process.env);
    if (!cfg.envFile) throw new MigrateError('no .env in use; nothing to migrate');
    const r = migrateData({ sourceEnv: cfg.envFile, sourceData: cfg.dataDir, targetDir, retireSource: argv.includes('--retire-source') });
    console.log(`Copied ${r.sourceEnv} -> ${r.targetEnv}`);
    console.log(`Copied ${r.sourceData} -> ${r.targetData} (${r.filesCopied} files; registry integrity ok; rows: ${Object.entries(r.tables).map(([k, v]) => `${k}=${v}`).join(', ') || 'no registry'})`);
    console.log('The source was not modified or deleted.');
    if (r.retired) console.log(`Renamed the source .env to ${r.retired}; the copy is now the one in use.`);
    else console.log(`To switch to the copy: rename ${r.sourceEnv} (for example to .env.migrated), or set RBA_ENV_FILE=${r.targetEnv}. If the copy is in the plugin data folder, the plugin refuses to choose between the two until you do.`);
  } catch (e) {
    console.error(`migrate-data: ${(e as Error).message}`);
    process.exitCode = e instanceof MigrateError ? 2 : 1;
  }
}
