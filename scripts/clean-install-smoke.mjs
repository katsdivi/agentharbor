#!/usr/bin/env node
/**
 * Independent install smoke test, in a fresh folder whose path contains spaces.
 * Nothing from this checkout's .env, data/ or node_modules is used.
 *
 *   node scripts/clean-install-smoke.mjs --artifact pkg/remote-browser-accounts-<v>.zip --work <dir>
 *   node scripts/clean-install-smoke.mjs --clone <git repo path> [--ref <branch>] --work <dir>
 *   --keep   keep the work folder afterwards (default: removed)
 *
 * Steps: unpack (verifying the .sha256 if present) or git clone; install dependencies
 * (artifact: `npm ci --omit=dev --ignore-scripts`, what Claude Code does for a copied
 * plugin; clone: npm ci + actor ci + build); `claude plugin validate` when the CLI is
 * installed; doctor --json; then the MCP server over stdio with a temporary
 * CLAUDE_PLUGIN_DATA and no .env: initialize, tools/list, config_check. It never
 * runs a provider call (no Apify, no MailSlurp, no network from the server).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const artifact = opt('--artifact');
const clone = opt('--clone');
const work = resolve(opt('--work') ?? '');
if ((!artifact && !clone) || !opt('--work')) {
  console.error('usage: --artifact <zip> | --clone <repo> [--ref <branch>]  --work <dir> [--keep]');
  process.exit(2);
}
const log = (m) => console.log(`[smoke] ${m}`);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const run = (cmd, args, cwd, extra = {}) => {
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...extra }, maxBuffer: 64 * 1024 * 1024 });
  return { ...r, ms: Date.now() - t };
};

const base = join(work, `rba smoke ${artifact ? 'artifact' : 'clone'} ${process.pid}`);
mkdirSync(base, { recursive: true });
let dir;
try {
  // --- obtain the plugin ------------------------------------------------------------
  if (artifact) {
    const zip = resolve(artifact);
    if (existsSync(`${zip}.sha256`)) {
      const want = readFileSync(`${zip}.sha256`, 'utf8').split(/\s+/)[0];
      const got = createHash('sha256').update(readFileSync(zip)).digest('hex');
      check('artifact sha256', want === got, got);
    }
    execFileSync('unzip', ['-q', zip, '-d', base]);
    dir = join(base, basename(zip, '.zip'));
  } else {
    dir = join(base, 'plugin checkout');
    const args = ['clone', '-q', '--no-hardlinks'];
    if (opt('--ref')) args.push('--branch', opt('--ref'));
    execFileSync('git', [...args, resolve(clone), dir]);
    check('git clone', existsSync(join(dir, 'package.json')), dir);
  }
  const leaked = readdirSync(dir).filter((e) => ['.env', 'data', 'node_modules', 'dist'].includes(e) && !(artifact && e === 'dist'));
  check('no .env, data, node_modules (or dist in a clone) before install', leaked.length === 0, leaked.join(', ') || 'clean');

  // --- install ----------------------------------------------------------------------
  if (artifact) {
    const r = run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
    check('npm ci --omit=dev --ignore-scripts', r.status === 0, `${(r.ms / 1000).toFixed(1)} s (Claude Code's limit is 60 s)${r.status ? ` ${r.stderr.slice(-400)}` : ''}`);
  } else {
    for (const [label, args] of [['npm ci', ['ci', '--no-audit', '--no-fund']], ['npm --prefix actor ci', ['--prefix', 'actor', 'ci', '--no-audit', '--no-fund']], ['npm run build', ['run', 'build']]]) {
      const r = run('npm', args, dir);
      check(label, r.status === 0, `${(r.ms / 1000).toFixed(1)} s${r.status ? ` ${r.stderr.slice(-400)}` : ''}`);
      if (r.status) throw new Error(`${label} failed`);
    }
  }

  // --- claude plugin validate (optional) ----------------------------------------------
  const v = run('claude', ['plugin', 'validate', dir], dir);
  if (v.error) log('SKIP claude plugin validate: claude CLI not found');
  else check('claude plugin validate', v.status === 0, (v.stdout + v.stderr).trim().split('\n').pop());

  // --- doctor ------------------------------------------------------------------------
  const pdata = join(base, 'plugin data');
  // RBA_CONFIG_HOME points at an empty folder so the real user config (~/.config/remote-browser-accounts) is never used.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_ROOT: dir, CLAUDE_PLUGIN_DATA: pdata, RBA_CONFIG_HOME: join(work, 'user config (empty)') };
  const d = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(dir, 'dist', 'src', 'cli', 'doctor.js'), '--json'], { cwd: base, env, encoding: 'utf8' });
  try {
    const j = JSON.parse(d.stdout);
    const missing = j.checks.filter((c) => c.required && c.status === 'missing').map((c) => c.name);
    check('doctor: server can start', j.coreMissing === 0, missing.join(', ') || `${j.checks.length} checks`);
    const lm = j.checks.filter((c) => c.section === 'local-mode').map((c) => `${c.name}=${c.status}`).join(' ');
    log(`info doctor local-mode: ${lm}`);
  } catch {
    check('doctor --json', false, d.stderr.slice(-400));
  }

  // --- MCP stdio smoke ------------------------------------------------------------------
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(dir, 'scripts', 'start-mcp.mjs')], { cwd: base, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  const waiters = new Map();
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        waiters.get(m.id)?.(m);
      } catch {
        /* not JSON */
      }
    }
  });
  child.stderr.on('data', (c) => (stderr += c));
  let id = 0;
  const rpc = (method, params) =>
    new Promise((res, rej) => {
      const myId = ++id;
      const t = setTimeout(() => rej(new Error(`${method} timed out; stderr: ${stderr.slice(-400)}`)), 20000);
      waiters.set(myId, (m) => {
        clearTimeout(t);
        res(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rba-smoke', version: '0' } });
  check('MCP initialize', !!init.result, `server ${init.result?.serverInfo?.name} "${init.result?.serverInfo?.title ?? ''}" ${init.result?.serverInfo?.version}`);
  {
    // The server version must be derived from this artifact's release version + recorded build commit.
    const pv = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    const bi = JSON.parse(readFileSync(join(dir, 'dist', 'build-info.json'), 'utf8'));
    const want = `${pv}+${bi.commit.slice(0, 7)}${bi.treeClean ? '' : '.dirty'}`;
    check('MCP server version = release + build commit', init.result?.serverInfo?.version === want, `${init.result?.serverInfo?.version} (expected ${want})`);
  }
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {});
  const tools = list.result?.tools ?? [];
  check('MCP tools/list', tools.length > 0, `${tools.length} tools`);
  const cc = await rpc('tools/call', { name: 'config_check', arguments: {} });
  const text = cc.result?.content?.[0]?.text ?? '';
  check('MCP config_check runs without a .env', !!text && !cc.result?.isError, `${text.length} chars`);
  child.stdin.end();
  await new Promise((r) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      r();
    }, 10000);
    child.on('exit', () => {
      clearTimeout(t);
      r();
    });
  });
  check('data created under CLAUDE_PLUGIN_DATA only', existsSync(join(pdata, 'data', 'registry.sqlite')) && !existsSync(join(dir, 'data')) && !existsSync(join(dir, '.env')), join(pdata, 'data'));

  // --- upgrade: an existing v1 registry (synthetic row) is backed up, then migrated forward ------
  {
    const upHome = join(base, 'upgrade user config');
    const upData = join(upHome, 'data');
    mkdirSync(upData, { recursive: true });
    const { randomBytes } = await import('node:crypto');
    writeFileSync(join(upHome, '.env'), `RBA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    const { DatabaseSync } = await import('node:sqlite');
    const { SCHEMA } = await import(pathToFileURL(join(dir, 'dist', 'src', 'core', 'db.js')).href);
    const legacy = new DatabaseSync(join(upData, 'registry.sqlite'));
    legacy.exec(SCHEMA);
    const t = new Date().toISOString();
    legacy.prepare("INSERT INTO accounts (id, target_origin, proxy_mode, status, created_at, updated_at) VALUES ('acct_upgrade_probe','https://example.test','direct','active',?,?)").run(t, t);
    legacy.close();
    const upEnv = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_ROOT: dir, CLAUDE_PLUGIN_DATA: join(base, 'upgrade plugin data'), RBA_CONFIG_HOME: upHome };
    const dj = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(dir, 'dist', 'src', 'cli', 'doctor.js'), '--json'], { cwd: base, env: upEnv, encoding: 'utf8' });
    let reg = '';
    try {
      reg = JSON.parse(dj.stdout).checks.find((c) => c.name === 'registry')?.detail ?? '';
    } catch {
      reg = dj.stderr.slice(-200);
    }
    check('upgrade: doctor sees the v1 registry and the pending migration', /schema v1; this build migrates it/.test(reg), reg);
    const mod = await import(pathToFileURL(join(dir, 'dist', 'src', 'core', 'db.js')).href);
    const db = new mod.Db(upData);
    const backups = existsSync(join(upData, 'backups')) ? readdirSync(join(upData, 'backups')) : [];
    const after = db.get("SELECT MAX(version) v FROM schema_migrations").v;
    const kept = db.get("SELECT execution_mode FROM accounts WHERE id = 'acct_upgrade_probe'");
    db.close();
    check('upgrade: pre-upgrade backup written, schema migrated, row kept', backups.length === 1 && /^registry-v1-before-v\d+-/.test(backups[0]) && after > 1 && kept?.execution_mode === 'remote_direct', `${backups.join(', ')}; schema v${after}; account mode ${kept?.execution_mode}`);
    const b = new DatabaseSync(join(upData, 'backups', backups[0]), { readOnly: true });
    const bCols = b.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
    const bRows = b.prepare('SELECT COUNT(*) n FROM accounts').get().n;
    b.close();
    check('upgrade: backup is the untouched v1 database', !bCols.includes('execution_mode') && bRows === 1, `${bRows} account row, execution_mode column ${bCols.includes('execution_mode') ? 'present' : 'absent'}`);
  }
} catch (e) {
  check('smoke run', false, e.message);
} finally {
  const failed = results.filter((r) => !r.ok).length;
  log(`${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (!argv.includes('--keep')) rmSync(base, { recursive: true, force: true });
  else log(`kept ${base}`);
  process.exitCode = failed ? 1 : 0;
}
