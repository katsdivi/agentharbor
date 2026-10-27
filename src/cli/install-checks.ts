/**
 * Install diagnostics shared by `doctor` and tests. Every check reports names,
 * paths and versions only: never a variable's value.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { ConfigError, PROJECT_ROOT, envFileCandidates, hasRegistry, loadConfig, missingByCapability, userConfigDir } from '../core/config.js';

export const PLUGIN_NAME = 'remote-browser-accounts';
export const MIN_NODE = [22, 13] as const;

export type CheckStatus = 'ok' | 'missing' | 'warn' | 'info';
export interface Check {
  section: 'runtime' | 'build' | 'local-mode' | 'config' | 'data';
  name: string;
  status: CheckStatus;
  detail: string;
  /** A missing required check means the MCP server cannot start. */
  required: boolean;
}

/** `~/.claude/plugins/data/<id>` the way Claude Code names ${CLAUDE_PLUGIN_DATA} for `remote-browser-accounts@<marketplace>`. */
export function pluginDataDir(marketplace: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(env.HOME || homedir(), '.claude', 'plugins');
  return join(root, 'data', `${PLUGIN_NAME}@${marketplace}`.replace(/[^A-Za-z0-9_-]/g, '-'));
}

export function nodeVersionOk(v: string = process.versions.node): boolean {
  const [maj = 0, min = 0] = v.split('.').map(Number);
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
}

/** Same algorithm as scripts/build-info.mjs: sha256 over sorted relative paths + contents of every .js file. */
export function distHash(distDir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(distDir);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(distDir, f));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

/** Which .env candidate is in use, labelled by where it comes from. */
export function envSource(file: string, env: NodeJS.ProcessEnv): string {
  if (env.RBA_ENV_FILE && file === env.RBA_ENV_FILE) return 'RBA_ENV_FILE';
  if (env.CLAUDE_PLUGIN_DATA && file === join(env.CLAUDE_PLUGIN_DATA, '.env')) return 'plugin data dir (survives updates)';
  const user = userConfigDir(env);
  if (user && file === join(user, '.env')) return 'user config folder (outside the plugin folder; survives updates and uninstall)';
  if (env.CLAUDE_PLUGIN_ROOT && file === join(env.CLAUDE_PLUGIN_ROOT, '.env')) return 'plugin root (in-place install)';
  return 'project root (source checkout / in-place install)';
}

function nearestExisting(p: string): string {
  let d = p;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return d;
}

export async function installChecks(env: NodeJS.ProcessEnv = process.env, root: string = PROJECT_ROOT): Promise<Check[]> {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  // --- runtime ---------------------------------------------------------------
  add({ section: 'runtime', name: 'node', required: true, status: nodeVersionOk() ? 'ok' : 'missing', detail: `${process.versions.node} (need >= ${MIN_NODE.join('.')}) on ${process.platform}-${process.arch}` });
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const v = (db.prepare('select sqlite_version() as v').get() as { v: string }).v;
    db.close();
    add({ section: 'runtime', name: 'node:sqlite', required: true, status: 'ok', detail: `SQLite ${v}` });
  } catch (e) {
    add({ section: 'runtime', name: 'node:sqlite', required: true, status: 'missing', detail: (e as Error).message });
  }

  // --- build -----------------------------------------------------------------
  const dist = join(root, 'dist');
  const entry = join(dist, 'src', 'mcp', 'index.js');
  add({ section: 'build', name: 'server build', required: true, status: existsSync(entry) ? 'ok' : 'missing', detail: existsSync(entry) ? entry : `${entry} missing: run npm run build (source checkout)` });
  if (existsSync(entry)) {
    try {
      const info = JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8')) as { commit?: string; treeClean?: boolean; distSha256?: string };
      const match = distHash(dist) === info.distSha256;
      add({ section: 'build', name: 'build-info', required: false, status: match ? 'ok' : 'warn', detail: `commit ${(info.commit ?? 'unknown').slice(0, 12)}${info.treeClean ? '' : ' (built with uncommitted changes)'}; dist hash ${match ? 'matches' : 'DOES NOT match'} the recorded build` });
    } catch {
      add({ section: 'build', name: 'build-info', required: false, status: 'warn', detail: 'dist/build-info.json missing or unreadable' });
    }
  }
  // Read each runtime dependency's own package.json (npm installs them flat under node_modules).
  for (const name of ['@modelcontextprotocol/sdk', 'zod', '@cantoo/pdf-lib']) {
    try {
      const v = (JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;
      add({ section: 'build', name, required: true, status: 'ok', detail: v });
    } catch {
      add({ section: 'build', name, required: true, status: 'missing', detail: `not installed under ${root}: run npm ci (or npm ci --omit=dev in a packaged install)` });
    }
  }

  // --- local mode (optional) ---------------------------------------------------
  const worker = join(root, 'actor', 'dist', 'main.js');
  add({ section: 'local-mode', name: 'worker build', required: false, status: existsSync(worker) ? 'ok' : 'warn', detail: existsSync(worker) ? worker : 'actor/dist/main.js missing: local mode unavailable (npm run build)' });
  type Playwright = { chromium: { executablePath(): string } };
  let pw: Playwright | null = null;
  try {
    pw = createRequire(join(root, 'actor', 'package.json'))('playwright') as Playwright;
    add({ section: 'local-mode', name: 'playwright', required: false, status: 'ok', detail: (JSON.parse(readFileSync(join(root, 'actor', 'node_modules', 'playwright', 'package.json'), 'utf8')) as { version: string }).version });
  } catch {
    add({ section: 'local-mode', name: 'playwright', required: false, status: 'warn', detail: 'not installed: local mode unavailable (npm ci --prefix actor)' });
  }
  if (pw !== null) {
    const p: Playwright = pw;
    let exe = '';
    try {
      exe = p.chromium.executablePath();
    } catch {
      /* unknown platform */
    }
    add({ section: 'local-mode', name: 'chromium', required: false, status: exe && existsSync(exe) ? 'ok' : 'warn', detail: exe && existsSync(exe) ? exe : 'Playwright Chromium not downloaded: local mode unavailable (cd actor && npx playwright install chromium)' });
  }

  // --- config ----------------------------------------------------------------
  // Claude Code copies the whole plugin folder (ignoring .gitignore) into its plugin cache on
  // install/update, so anything secret or stateful in the plugin folder gets duplicated.
  const inRoot = pluginRootState(root);
  add({
    section: 'config',
    name: 'plugin folder contents',
    required: false,
    status: inRoot.length ? 'warn' : 'ok',
    detail: inRoot.length
      ? `${inRoot.join(', ')} inside ${root}: Claude Code copies these into ~/.claude/plugins/cache on every install/update. Move them out: node "${join(root, 'dist', 'src', 'cli', 'migrate-data.js')}" --user-config --retire-source`
      : 'no .env, backups or registry inside the plugin folder',
  });
  const stale = staleCacheCopies(env, root);
  add({
    section: 'config',
    name: 'plugin cache copies',
    required: false,
    status: stale.length ? 'warn' : 'ok',
    detail: stale.length
      ? `cache copies holding secrets or state (not the folder in use): ${stale.map((s) => `${s.dir} [${s.items.join(', ')}]`).join('; ')}. Remove them with: node "${join(root, 'dist', 'src', 'cli', 'clean-plugin-cache.js')}"`
      : 'none hold .env files or registry data',
  });
  const found = envFileCandidates(env).filter((c) => existsSync(c));
  let cfg: ReturnType<typeof loadConfig> | null = null;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    const v = e instanceof ConfigError ? e.variable : 'config';
    add({ section: 'config', name: v, required: true, status: 'missing', detail: (e as Error).message });
  }
  if (cfg?.envFile) {
    const mode = statSync(cfg.envFile).mode & 0o777;
    const perm = process.platform === 'win32' ? 'permissions not checked on Windows' : `mode ${mode.toString(8)}${mode & 0o077 ? ' WARNING: readable by group/others, run chmod 600 on it' : ''}`;
    add({ section: 'config', name: '.env', required: false, status: process.platform !== 'win32' && mode & 0o077 ? 'warn' : 'ok', detail: `${cfg.envFile} [${envSource(cfg.envFile, env)}]; ${perm}` });
    const others = [...new Set(found.filter((f) => f !== cfg!.envFile))];
    if (others.length) add({ section: 'config', name: '.env (others)', required: false, status: 'info', detail: `also present, not used: ${others.join(', ')}` });
  } else if (cfg) {
    const target = env.CLAUDE_PLUGIN_DATA ? join(env.CLAUDE_PLUGIN_DATA, '.env') : join(root, '.env');
    add({ section: 'config', name: '.env', required: false, status: 'warn', detail: `no .env found; create one with: node "${join(root, 'dist', 'src', 'cli', 'init-env.js')}"${env.CLAUDE_PLUGIN_DATA ? ` --target "${dirname(target)}"` : ''}` });
  }
  if (cfg) {
    for (const [cap, names] of Object.entries(missingByCapability(cfg))) {
      add({ section: 'config', name: cap, required: false, status: names.length ? 'info' : 'ok', detail: names.length ? `not configured: set ${names.join(', ')}` : 'configured' });
    }
  }

  // --- data ------------------------------------------------------------------
  if (cfg) {
    const d = cfg.dataDir;
    let writable = false;
    try {
      accessSync(nearestExisting(d), constants.W_OK);
      writable = true;
    } catch {
      /* not writable */
    }
    add({ section: 'data', name: 'data dir', required: true, status: writable ? 'ok' : 'missing', detail: `${d}${existsSync(d) ? '' : ' (created on first start)'}${writable ? '' : ' NOT WRITABLE'}` });
    if (hasRegistry(d)) {
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(join(d, 'registry.sqlite'), { readOnly: true });
        let version = 1;
        try {
          version = (db.prepare('select max(version) as v from schema_migrations').get() as { v: number | null }).v ?? 1;
        } catch {
          /* pre-migration database: adopted as v1 on next start */
        }
        db.close();
        const { latestVersion } = await import('../core/migrations.js');
        const latest = latestVersion();
        add({ section: 'data', name: 'registry', required: true, status: version > latest ? 'missing' : 'ok', detail: `schema v${version}; this build ${version > latest ? `only knows v${latest}: upgrade the plugin, never downgrade` : version < latest ? `migrates it to v${latest} on next start` : 'is current'}` });
      } catch (e) {
        add({ section: 'data', name: 'registry', required: false, status: 'warn', detail: `could not read: ${(e as Error).message}` });
      }
    } else {
      add({ section: 'data', name: 'registry', required: false, status: 'info', detail: 'none yet (new install)' });
    }
  }
  return out;
}

/** Secret-bearing or stateful entries directly inside a plugin folder (names only). */
export function pluginRootState(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) if (/^\.env(\..*)?$/.test(n) && n !== '.env.example') out.push(n);
  const data = join(dir, 'data');
  if (existsSync(data)) {
    let inData: string[] = [];
    try {
      inData = readdirSync(data);
    } catch {
      inData = [];
    }
    const secretish = inData.filter((n) => /^\.env|\.sqlite(-wal|-shm|-journal)?$|settings.*\.json$/.test(n));
    if (secretish.length || inData.length) out.push(`data/ (${secretish.length ? secretish.join(', ') : `${inData.length} entries`})`);
  }
  return out;
}

/** Copies of this plugin in Claude Code's plugin cache, other than `activeRoot`, that hold secrets or state. */
export function staleCacheCopies(env: NodeJS.ProcessEnv, activeRoot: string): Array<{ dir: string; items: string[] }> {
  const cacheRoot = join(env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(env.HOME || homedir(), '.claude', 'plugins'), 'cache');
  const out: Array<{ dir: string; items: string[] }> = [];
  let markets: string[] = [];
  try {
    markets = readdirSync(cacheRoot);
  } catch {
    return out;
  }
  for (const m of markets) {
    const pdir = join(cacheRoot, m, PLUGIN_NAME);
    let versions: string[] = [];
    try {
      versions = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const v of versions) {
      const dir = join(pdir, v);
      if (dir === activeRoot) continue;
      const items = pluginRootState(dir);
      if (items.length) out.push({ dir, items });
    }
  }
  return out;
}
