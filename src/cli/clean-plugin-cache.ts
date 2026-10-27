#!/usr/bin/env node
/**
 * Removes secrets and state from INACTIVE copies of this plugin in Claude Code's
 * plugin cache (~/.claude/plugins/cache/<marketplace>/remote-browser-accounts/<version>).
 *
 * Claude Code copies the whole plugin folder (ignoring .gitignore) into that cache
 * on install/update. When an older install kept its .env and data/ inside the
 * plugin folder, the copy duplicates the secrets and the registry.
 *
 *   clean-plugin-cache          list what would be removed (nothing is changed)
 *   clean-plugin-cache --yes    remove .env* (not .env.example) and data/ from each copy
 *
 * Refuses a copy when it is the folder this plugin is running from, when the
 * .env or data folder currently in use lives inside it, or when a running
 * process has it on its command line. Prints paths and file names only, never
 * values. Removal is ordinary deletion (not forensic erasure).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PROJECT_ROOT, loadConfig } from '../core/config.js';
import { staleCacheCopies } from './install-checks.js';

export interface CleanResult {
  dir: string;
  removed: string[];
  refused?: string;
}

function inside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

export function cleanPluginCache(o: { env: NodeJS.ProcessEnv; activeRoot: string; apply: boolean; activeEnvFile: string | null; activeDataDir: string | null; processList?: string }): CleanResult[] {
  const out: CleanResult[] = [];
  for (const copy of staleCacheCopies(o.env, o.activeRoot)) {
    const r: CleanResult = { dir: copy.dir, removed: [] };
    if (inside(o.activeRoot, copy.dir)) r.refused = 'this is the folder the plugin is running from';
    else if (o.activeEnvFile && inside(o.activeEnvFile, copy.dir)) r.refused = 'the .env in use lives in this copy';
    else if (o.activeDataDir && inside(o.activeDataDir, copy.dir)) r.refused = 'the data folder in use lives in this copy';
    else if (o.processList?.includes(copy.dir)) r.refused = 'a running process references this copy';
    if (!r.refused) {
      const targets = readdirSync(copy.dir)
        .filter((n) => (/^\.env(\..*)?$/.test(n) && n !== '.env.example') || n === 'data')
        .map((n) => join(copy.dir, n));
      for (const t of targets) {
        if (o.apply) rmSync(t, { recursive: true, force: true });
        r.removed.push(t.slice(copy.dir.length + 1) + (t.endsWith('data') ? '/' : ''));
      }
    }
    out.push(r);
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]).replace(/\.ts$/, '.js').endsWith(join('cli', 'clean-plugin-cache.js'));
if (isMain) {
  const apply = process.argv.includes('--yes');
  let activeEnvFile: string | null = null;
  let activeDataDir: string | null = null;
  try {
    const cfg = loadConfig();
    activeEnvFile = cfg.envFile;
    activeDataDir = cfg.dataDir;
  } catch {
    /* no usable config: still safe, the copies are compared by path below */
  }
  let processList = '';
  try {
    processList = execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    processList = '';
  }
  const root = process.env.CLAUDE_PLUGIN_ROOT ? resolve(process.env.CLAUDE_PLUGIN_ROOT) : PROJECT_ROOT;
  const res = cleanPluginCache({ env: process.env, activeRoot: root, apply, activeEnvFile, activeDataDir, processList });
  if (res.length === 0) console.log('No cache copies of this plugin hold .env files or data.');
  for (const r of res) {
    if (r.refused) console.log(`REFUSED ${r.dir}: ${r.refused}`);
    else console.log(`${apply ? 'REMOVED' : 'WOULD REMOVE'} from ${r.dir}: ${r.removed.join(', ')}`);
  }
  if (!apply && res.some((r) => !r.refused)) console.log('Nothing was changed. Re-run with --yes to remove these.');
}
