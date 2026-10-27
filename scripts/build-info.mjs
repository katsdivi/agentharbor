#!/usr/bin/env node
/**
 * Writes dist/build-info.json: the git commit the build was made from, whether the
 * working tree had uncommitted changes, and a SHA-256 over every compiled .js file
 * (sorted relative paths + contents). The MCP server re-computes the same hash at
 * runtime (config_check) so the loaded build can be tied to a commit.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export function distHash(distDir) {
  const files = [];
  const walk = (d) => {
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
  return { sha256: h.digest('hex'), files: files.length };
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // decoded (paths may contain spaces)
const git = (args) => execFileSync('git', args, { cwd: root }).toString().trim();
let commit = 'unknown';
let treeClean = false;
try {
  commit = git(['rev-parse', 'HEAD']);
  treeClean = git(['status', '--porcelain', '--', 'src', 'actor/src/protocol.ts', 'package.json', 'package-lock.json', 'tsconfig.json']) === '';
} catch {
  /* not a git checkout */
}
const { sha256, files } = distHash(join(root, 'dist'));
const tsc = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version;
writeFileSync(join(root, 'dist', 'build-info.json'), JSON.stringify({ commit, treeClean, distSha256: sha256, jsFiles: files, typescript: tsc }, null, 2) + '\n');
console.log(`build-info: commit ${commit.slice(0, 12)}${treeClean ? '' : ' (UNCOMMITTED CHANGES)'} dist ${sha256.slice(0, 16)} (${files} files)`);
