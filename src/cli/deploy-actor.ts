#!/usr/bin/env node
/**
 * Deploys actor/ to the user's Apify account as a private Actor named
 * `remote-browser-worker` using the Apify REST API (no Apify CLI login needed;
 * the token is read from .env and never printed). Builds it and prints the
 * APIFY_ACTOR_ID value to put in .env.
 *
 * `--fixture` deploys fixture-actor/ instead, as the private test-only Actor
 * `rba-practice-fixture` (controlled signup/verification-email/upload site).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PROJECT_ROOT, loadConfig } from '../core/config.js';

const FIXTURE = process.argv.includes('--fixture');
const NAME = FIXTURE ? 'rba-practice-fixture' : 'remote-browser-worker';
const TITLE = FIXTURE ? 'RBA controlled test fixture (test-only)' : 'Remote browser worker (remote-browser-accounts plugin)';
const VERSION = '0.1';
const cfg = loadConfig();
if (!cfg.apify.token) {
  console.error('APIFY_TOKEN is missing in .env');
  process.exit(2);
}
const base = `${cfg.apify.apiBaseUrl}/v2`;
const headers = { Authorization: `Bearer ${cfg.apify.token}`, 'Content-Type': 'application/json' };

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = (await res.json().catch(() => ({}))) as { data: T; error?: { message?: string } };
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${j.error?.message ?? ''}`);
  return { status: res.status, data: j.data };
}

function collect(dir: string, root: string, out: Array<{ name: string; format: 'TEXT'; content: string }>): void {
  for (const e of readdirSync(dir)) {
    if (['node_modules', 'dist', 'storage', '.DS_Store'].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collect(p, root, out);
    else out.push({ name: relative(root, p), format: 'TEXT', content: readFileSync(p, 'utf8') });
  }
}

const actorDir = join(PROJECT_ROOT, FIXTURE ? 'fixture-actor' : 'actor');
const sourceFiles: Array<{ name: string; format: 'TEXT'; content: string }> = [];
collect(actorDir, actorDir, sourceFiles);
const version = { versionNumber: VERSION, sourceType: 'SOURCE_FILES', buildTag: 'latest', sourceFiles };

const me = await api<{ username: string }>('GET', '/users/me');
const actorId = `${me.data.username}~${NAME}`;
const existing = await api<{ id: string }>('GET', `/actors/${encodeURIComponent(actorId)}`);
let id: string;
if (existing.status === 404) {
  const created = await api<{ id: string }>('POST', '/actors', { name: NAME, title: TITLE, isPublic: false, versions: [version] });
  id = created.data.id;
  console.log(`Created private Actor ${actorId}`);
} else {
  id = existing.data.id;
  await api('PUT', `/actors/${id}/versions/${VERSION}`, version);
  console.log(`Updated source of ${actorId} (${sourceFiles.length} files)`);
}
let build = (await api<{ id: string; status: string }>('POST', `/actors/${id}/builds?version=${VERSION}&tag=latest&waitForFinish=60`)).data;
const deadline = Date.now() + 15 * 60_000;
while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(build.status) && Date.now() < deadline) {
  process.stdout.write(`build ${build.status}...\n`);
  build = (await api<{ id: string; status: string }>('GET', `/actor-builds/${build.id}?waitForFinish=60`)).data;
}
console.log(`Build ${build.id}: ${build.status}`);
if (build.status !== 'SUCCEEDED') {
  console.error('Build did not succeed; see the build log in Apify Console.');
  process.exit(1);
}
console.log(FIXTURE ? `Fixture Actor: ${actorId} (test-only; start it per test run)` : `Set in .env:  APIFY_ACTOR_ID=${actorId}`);
