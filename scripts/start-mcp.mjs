#!/usr/bin/env node
/**
 * MCP server launcher used by .mcp.json. Checks the runtime and the build before
 * loading dist/src/mcp/index.js, so a missing build or an old Node.js produces one
 * clear line on stderr instead of a stack trace. stdout is the MCP channel and is
 * never written here.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // decoded: paths may contain spaces
const fail = (msg) => {
  process.stderr.write(`[rba] cannot start: ${msg}\n`);
  process.exit(1);
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  fail(`Node.js ${process.versions.node} is too old; this plugin needs Node.js >= 22.13 (built-in node:sqlite).`);
}
const entry = join(root, 'dist', 'src', 'mcp', 'index.js');
if (!existsSync(entry)) {
  fail(`not built (${entry} is missing). In a source checkout run: npm ci && npm --prefix actor ci && npm run build. A packaged install (npm run package) ships dist/ prebuilt.`);
}
if (!existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'))) {
  fail(`dependencies are not installed in ${root}. Run: npm ci --omit=dev (in that folder).`);
}
await import(pathToFileURL(entry).href);
