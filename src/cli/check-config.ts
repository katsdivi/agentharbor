#!/usr/bin/env node
/** Reports configuration status by variable NAME only; never prints values. */
import { statSync } from 'node:fs';
import { loadConfig, missingByCapability } from '../core/config.js';
import { envSource } from './install-checks.js';

try {
  const c = loadConfig();
  console.log(`.env file: ${c.envFile ? `${c.envFile} [${envSource(c.envFile, process.env)}]` : 'NOT FOUND (run npm run init-env)'}`);
  if (c.envFile) {
    const mode = statSync(c.envFile).mode & 0o777;
    console.log(`.env permissions: ${mode.toString(8)}${mode & 0o077 ? '  WARNING: readable by group/others; run chmod 600 on it' : ' (ok)'}`);
  }
  const missing = missingByCapability(c);
  const labels: Record<string, string> = {
    browser: 'Remote browser (Apify)',
    browse_without_account: 'Navigation for sessions without an account',
    email: 'Receiving email (MailSlurp)',
    storage: 'Encrypted credential/state storage',
    signup: 'Account registration targets',
    dashboard: 'Local dashboard',
  };
  for (const [k, names] of Object.entries(missing)) {
    console.log(`${names.length ? 'MISSING' : 'ok     '}  ${labels[k]}${names.length ? `: set ${names.join(', ')}` : ''}`);
  }
  console.log(`data dir: ${c.dataDir}`);
  console.log(`display name: ${c.displayName}`);
  console.log(`default proxy mode: ${c.proxy.defaultMode}; budget $${c.limits.monthlyBudgetUsd}/month; max ${c.limits.maxConcurrentSessions} concurrent sessions x ${c.limits.maxSessionMinutes} min`);
  console.log(`authorized targets: ${c.targets.length ? c.targets.map((t) => t.origin).join(', ') : 'none'}`);
  process.exitCode = Object.values(missing).some((m) => m.length) ? 2 : 0;
} catch (e) {
  console.error(`configuration error: ${(e as Error).message}`);
  process.exitCode = 1;
}
