import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { versions } from '../../src/core/version.js';
import { SERVER_VERSION } from '../../src/mcp/server.js';

function fakeRoot(o: { pkg?: string; plugin?: string; actor?: string; build?: { commit: string; treeClean: boolean } }) {
  const r = mkdtempSync(join(tmpdir(), 'rba-version-'));
  mkdirSync(join(r, '.claude-plugin'));
  mkdirSync(join(r, 'actor'));
  mkdirSync(join(r, 'dist'));
  if (o.pkg) writeFileSync(join(r, 'package.json'), JSON.stringify({ version: o.pkg }));
  if (o.plugin) writeFileSync(join(r, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: o.plugin }));
  if (o.actor) writeFileSync(join(r, 'actor', 'package.json'), JSON.stringify({ version: o.actor }));
  if (o.build) writeFileSync(join(r, 'dist', 'build-info.json'), JSON.stringify(o.build));
  return r;
}

describe('release and build identity', () => {
  it('derives the MCP server version from the release version and the build commit', () => {
    const v = versions(fakeRoot({ pkg: '1.2.3', plugin: '1.2.3', actor: '1.2.3', build: { commit: 'abcdef1234567890', treeClean: true } }));
    expect(v.mcpServer).toBe('1.2.3+abcdef1');
    expect(v.manifests.consistent).toBe(true);
    expect(versions(fakeRoot({ pkg: '1.2.3', plugin: '1.2.3', actor: '1.2.3', build: { commit: 'abcdef1234567890', treeClean: false } })).mcpServer).toBe('1.2.3+abcdef1.dirty');
    expect(versions(fakeRoot({ pkg: '1.2.3', plugin: '1.2.3', actor: '1.2.3' })).mcpServer).toBe('1.2.3+unbuilt');
  });

  it('flags manifests whose versions disagree', () => {
    expect(versions(fakeRoot({ pkg: '1.2.3', plugin: '1.2.4', actor: '1.2.3' })).manifests.consistent).toBe(false);
  });

  it('this repository: package.json, plugin.json and actor/package.json agree, and the server reports the derived version', () => {
    const v = versions();
    expect(v.manifests.consistent, JSON.stringify(v.manifests)).toBe(true);
    expect(SERVER_VERSION).toBe(v.mcpServer);
    expect(SERVER_VERSION.startsWith(`${v.release}+`)).toBe(true);
  });
});
