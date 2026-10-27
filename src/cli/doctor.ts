#!/usr/bin/env node
/**
 * Install and dependency diagnostics. Prints names, paths and versions only (never
 * a configuration value) and downloads nothing.
 *   --json   machine-readable output
 * Exit codes: 0 = the server can start and file tools have their required tools;
 *             1 = something the MCP server needs to start is missing;
 *             2 = the server can start, but a tool required by the file tools is missing.
 */
import { doctor as fileToolDeps } from '../files/exec.js';
import { SUPPORTED_FORMATS, UNSUPPORTED_FORMATS, capabilities } from '../files/formats.js';
import { installChecks } from './install-checks.js';

const json = process.argv.includes('--json');
const checks = await installChecks();
const deps = await fileToolDeps();
const coreMissing = checks.filter((c) => c.required && c.status === 'missing').length;
const fileMissing = deps.filter((d) => !d.installed && d.required === 'required').length;
process.exitCode = coreMissing ? 1 : fileMissing ? 2 : 0;

if (json) {
  console.log(JSON.stringify({ checks, fileTools: deps.map(({ name, required, installed, version }) => ({ name, required, installed, version })), coreMissing, fileMissing }, null, 2));
} else {
  const label = { ok: 'ok     ', missing: 'MISSING', warn: 'warn   ', info: 'info   ' } as const;
  let section = '';
  for (const c of checks) {
    if (c.section !== section) {
      section = c.section;
      console.log(`\n[${section}]${section === 'local-mode' ? ' (optional; only for execution mode local)' : ''}`);
    }
    console.log(`${label[c.status]}  ${c.name.padEnd(28)} ${c.detail}`);
  }
  console.log('\n[file tools] (only for file_import / media_* / portal_upload)');
  for (const d of deps) {
    const status = d.installed ? 'ok     ' : d.required === 'required' ? 'MISSING' : 'absent ';
    console.log(`${status}  ${d.name.padEnd(28)} ${d.required.padEnd(8)} ${d.installed ? d.version : `install: ${d.install}`}`);
    console.log(`         ${''.padEnd(28)} ${d.purpose}`);
  }
  console.log('\nSupported formats (inspect + sanitize + verify):', SUPPORTED_FORMATS.join(', '));
  for (const f of UNSUPPORTED_FORMATS) console.log(`Unsupported: ${f.padEnd(5)} ${capabilities(f).unsupportedReason}`);
  console.log(`\n${coreMissing ? `${coreMissing} problem(s) prevent the MCP server from starting.` : 'The MCP server can start.'}${fileMissing ? ` ${fileMissing} tool(s) required by the file tools are missing.` : ''}`);
}
