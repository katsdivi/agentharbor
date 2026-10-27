/**
 * Release and build identity. The MCP server version is derived from the release
 * version (package.json, which must equal .claude-plugin/plugin.json and
 * actor/package.json) plus the build commit recorded in dist/build-info.json:
 *   0.1.0+bbf9716        built from a clean tree at that commit
 *   0.1.0+bbf9716.dirty  built with uncommitted changes
 *   0.1.0+unbuilt        no build record (running from source)
 * The "+build" suffix is semver build metadata, so version ordering is unchanged.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerInput } from '../../actor/src/protocol.js';
import { PROJECT_ROOT } from './config.js';

/** Worker wire protocol version (type-checked against actor/src/protocol.ts). */
export const WORKER_PROTOCOL: WorkerInput['protocolVersion'] = 1;

/** Plugin root: PROJECT_ROOT from dist/, the repo root when running from source (tests). */
export function pluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [PROJECT_ROOT, resolve(here, '..', '..')]) if (existsSync(join(c, '.claude-plugin', 'plugin.json'))) return c;
  return PROJECT_ROOT;
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface Versions {
  release: string;
  mcpServer: string;
  build: { commit: string | null; treeClean: boolean | null };
  manifests: { packageJson: string | null; pluginJson: string | null; actorPackageJson: string | null; consistent: boolean };
  workerProtocol: number;
}

export function versions(root = pluginRoot()): Versions {
  const pkg = (readJson(join(root, 'package.json'))?.version as string | undefined) ?? null;
  const plugin = (readJson(join(root, '.claude-plugin', 'plugin.json'))?.version as string | undefined) ?? null;
  const actor = (readJson(join(root, 'actor', 'package.json'))?.version as string | undefined) ?? null;
  const bi = readJson(join(root, 'dist', 'build-info.json'));
  const commit = typeof bi?.commit === 'string' ? bi.commit : null;
  const treeClean = typeof bi?.treeClean === 'boolean' ? bi.treeClean : null;
  const release = pkg ?? plugin ?? '0.0.0';
  const meta = commit ? `${commit.slice(0, 7)}${treeClean === false ? '.dirty' : ''}` : 'unbuilt';
  return {
    release,
    mcpServer: `${release}+${meta}`,
    build: { commit, treeClean },
    manifests: { packageJson: pkg, pluginJson: plugin, actorPackageJson: actor, consistent: !!pkg && pkg === plugin && pkg === actor },
    workerProtocol: WORKER_PROTOCOL,
  };
}
