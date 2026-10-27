#!/usr/bin/env node
/**
 * MailSlurp inbox helper for the demo agent. The API key is read from the plugin's
 * .env (RBA config folder, then ./.env) and never printed.
 *
 *   node inbox.mjs create            -> {"id","emailAddress"}
 *   node inbox.mjs wait <id> [secs]  -> {"subject","code","link"} of the newest unread email
 *   node inbox.mjs delete <id>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function apiKey() {
  if (process.env.MAILSLURP_API_KEY) return process.env.MAILSLURP_API_KEY;
  for (const f of [path.join(os.homedir(), '.config/remote-browser-accounts/.env'), path.resolve('.env'), path.resolve('../.env')]) {
    if (!fs.existsSync(f)) continue;
    const m = /^MAILSLURP_API_KEY=(.*)$/m.exec(fs.readFileSync(f, 'utf8'));
    if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('MAILSLURP_API_KEY not found');
}

const API = 'https://api.mailslurp.com';
async function call(method, url) {
  const r = await fetch(`${API}${url}`, { method, headers: { 'x-api-key': apiKey(), accept: 'application/json' } });
  if (!r.ok) throw new Error(`MailSlurp ${method} ${url.split('?')[0]} -> HTTP ${r.status}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

const [cmd, id, secs] = process.argv.slice(2);
if (cmd === 'create') {
  const i = await call('POST', '/inboxes');
  console.log(JSON.stringify({ id: i.id, emailAddress: i.emailAddress }));
} else if (cmd === 'wait' && id) {
  const timeout = Math.min(Number(secs || 90), 300) * 1000;
  const e = await call('GET', `/waitForLatestEmail?inboxId=${id}&timeout=${timeout}&unreadOnly=true`);
  const body = e.body || '';
  console.log(JSON.stringify({ subject: e.subject, code: (/\b(\d{6})\b/.exec(`${e.subject} ${body}`) || [])[1] || null, link: (/href="([^"]*\/verify\?token=[^"]+)"/.exec(body) || [])[1] || null }));
} else if (cmd === 'delete' && id) {
  await call('DELETE', `/inboxes/${id}`);
  console.log(JSON.stringify({ deleted: id }));
} else {
  console.error('usage: node inbox.mjs create | wait <id> [secs] | delete <id>');
  process.exit(2);
}
