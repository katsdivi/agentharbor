#!/usr/bin/env node
/**
 * Builds a self-contained plugin artifact from an existing build (run via
 * `npm run package`, which builds first):
 *
 *   pkg/remote-browser-accounts-<version>/       plugin directory (load with a local marketplace or --plugin-dir)
 *   pkg/remote-browser-accounts-<version>.zip    the same directory, zipped (usable as an `archive` plugin source)
 *   pkg/remote-browser-accounts-<version>.zip.sha256
 *
 * Contents come from an ALLOWLIST (manifests, prebuilt dist/ and actor/dist/, readable
 * source, lockfiles, docs). node_modules is not shipped: Claude Code installs runtime
 * dependencies from the pruned package-lock.json when it copies the plugin, or run
 * `npm ci --omit=dev` yourself. After copying, the script FAILS if any file matches
 * the denylist (.env, data/, *.sqlite, node_modules, .claude/, test/) or contains
 * something that looks like a credential. It never prints a matched value.
 *
 *   --allow-dirty   package even if the build was made from uncommitted changes
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `${pkg.name}-${pkg.version}`;
const outRoot = join(root, 'pkg');
const out = join(outRoot, name);

const die = (m) => {
  console.error(`package: ${m}`);
  process.exit(1);
};

// --- preconditions -------------------------------------------------------------
const infoPath = join(root, 'dist', 'build-info.json');
if (!existsSync(infoPath)) die('dist/build-info.json missing; run npm run build first');
if (!existsSync(join(root, 'actor', 'dist', 'main.js'))) die('actor/dist/main.js missing; run npm run build first');
const info = JSON.parse(readFileSync(infoPath, 'utf8'));
if (!info.treeClean && !process.argv.includes('--allow-dirty')) die(`the build (commit ${String(info.commit).slice(0, 12)}) has uncommitted changes; commit first or pass --allow-dirty`);

// --- allowlist -----------------------------------------------------------------
const ALLOW = [
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'skills',
  'commands',
  'agents',
  'hooks',
  'dist',
  'src',
  'tsconfig.json',
  'actor/dist',
  'actor/src',
  'actor/.actor',
  'actor/Dockerfile',
  'actor/.dockerignore',
  'actor/package.json',
  'actor/package-lock.json',
  'actor/tsconfig.json',
  'scripts/start-mcp.mjs',
  'scripts/build-info.mjs',
  'README.md',
  'LICENSE',
  '.env.example',
  'docs/INSTALL.md',
  'docs/PLATFORMS.md',
  'docs/FILES.md',
  'docs/MODES.md',
];
const SKIP_FILE = (p) => p.endsWith('.map') || p.endsWith('.DS_Store') || p.endsWith('.tsbuildinfo');

rmSync(out, { recursive: true, force: true });
rmSync(`${out}.zip`, { force: true });
mkdirSync(out, { recursive: true });
for (const rel of ALLOW) {
  const src = join(root, rel);
  if (!existsSync(src)) continue;
  cpSync(src, join(out, rel), { recursive: true, dereference: false, filter: (s) => !SKIP_FILE(s) && !s.split(sep).includes('node_modules') });
}

// --- package.json and lockfile: runtime dependencies only ------------------------
const runtimeScripts = Object.fromEntries(
  ['init-env', 'check-config', 'doctor', 'migrate-data', 'dashboard', 'deploy-actor', 'live-check', 'mcp'].filter((k) => pkg.scripts[k]).map((k) => [k, pkg.scripts[k]]),
);
const outPkg = { ...pkg, scripts: runtimeScripts };
delete outPkg.devDependencies;
writeFileSync(join(out, 'package.json'), JSON.stringify(outPkg, null, 2) + '\n');

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
if (lock.lockfileVersion < 2) die('package-lock.json must be lockfileVersion 2 or 3');
const pruned = { ...lock, packages: {} };
let dropped = 0;
for (const [k, v] of Object.entries(lock.packages)) {
  if (k === '') {
    const top = { ...v };
    delete top.devDependencies;
    pruned.packages[k] = top;
  } else if (v.dev) dropped++;
  else pruned.packages[k] = v;
}
const lockDeps = pruned.packages[''].dependencies ?? {};
if (JSON.stringify(Object.keys(lockDeps).sort()) !== JSON.stringify(Object.keys(outPkg.dependencies ?? {}).sort())) die('lockfile and package.json dependencies differ');
for (const [k, v] of Object.entries(pruned.packages)) {
  if (k && v.resolved && !v.resolved.startsWith('https://')) die(`non-https resolved URL for ${k}`);
  if (k && (v.link || (v.resolved && /^(git|file):/.test(v.resolved)))) die(`non-registry dependency ${k}`);
}
writeFileSync(join(out, 'package-lock.json'), JSON.stringify(pruned, null, 2) + '\n');

// --- denylist + credential scan ------------------------------------------------------
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(out, p).split(sep).join('/'));
  }
};
walk(out);
files.sort();
const DENY = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)/, /(^|\/)data\//, /\.sqlite/, /(^|\/)node_modules\//, /(^|\/)\.claude\//, /(^|\/)test\//, /(^|\/)fixture-actor\//, /\.(key|pem|db)$/, /\.bak/];
const denied = files.filter((f) => DENY.some((r) => r.test(f)));
if (denied.length) die(`denylisted paths in the package: ${denied.join(', ')}`);
const SECRET = [
  ['apify token', /apify_api_[A-Za-z0-9]{20,}/],
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['github token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['secret assignment', /^(APIFY_TOKEN|MAILSLURP_API_KEY|RBA_ENCRYPTION_KEY|RBA_DASHBOARD_TOKEN)=(?!REPLACE_ME\s*$)\S{8,}/m],
];
const hits = [];
for (const f of files) {
  const text = readFileSync(join(out, f), 'utf8');
  for (const [label, re] of SECRET) if (re.test(text)) hits.push(`${f}: ${label}`);
}
if (hits.length) die(`possible credentials (values not shown): ${hits.join('; ')}`);

// --- manifest, zip, checksum ---------------------------------------------------------
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const manifest = files.map((f) => `${sha(readFileSync(join(out, f)))}  ${f}`).join('\n') + '\n';
writeFileSync(join(out, 'MANIFEST.sha256'), manifest);
writeFileSync(
  join(out, 'PACKAGE-INFO.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, commit: info.commit, treeClean: info.treeClean, distSha256: info.distSha256, files: files.length + 2, devPackagesPruned: dropped }, null, 2) + '\n',
);
execFileSync('zip', ['-qrX', `${name}.zip`, name], { cwd: outRoot });
const zipSha = sha(readFileSync(`${out}.zip`));
writeFileSync(`${out}.zip.sha256`, `${zipSha}  ${name}.zip\n`);
const size = statSync(`${out}.zip`).size;
console.log(`package: ${out}`);
console.log(`package: ${files.length + 2} files, zip ${(size / 1024).toFixed(0)} KiB, sha256 ${zipSha}`);
console.log(`package: commit ${String(info.commit).slice(0, 12)}${info.treeClean ? '' : ' (UNCOMMITTED CHANGES)'}; ${dropped} dev-only lockfile entries pruned; denylist and credential scan passed`);
