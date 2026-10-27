#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { buildContext } from '../core/context.js';
import { startDashboard } from './server.js';

const ctx = buildContext();
const d = await startDashboard(ctx);
process.stdout.write(`Dashboard listening on ${d.url} (loopback only).\n`);
if (process.argv.includes('--open')) {
  // Single-use login link goes straight to the browser; it is not printed.
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [d.oneTimeLoginUrl], { stdio: 'ignore', detached: true }).unref();
  process.stdout.write('Opened a single-use sign-in link in your browser (valid 2 minutes).\n');
} else {
  process.stdout.write(`Sign in at ${d.url}/login with RBA_DASHBOARD_TOKEN from .env, or restart with --open.\n`);
}
