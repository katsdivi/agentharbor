#!/usr/bin/env node
/**
 * Live provider checks. Runs only what is configured and reports each check as
 * passed / failed / skipped (with the reason). Consumes real allowances:
 *   --browser            one direct-mode Apify session (~1-3 minutes of runtime)
 *   --proxy=residential  one proxied session to verify the route (residential is billed per GB)
 *   --email              creates ONE MailSlurp inbox (counts toward the monthly inbox cap) and deletes it
 *   --target=<url>       navigate to an authorised target page in the browser check
 */
import { buildContext } from '../core/context.js';
import { Usage } from '../core/usage.js';
import type { InspectResponse, NavigateResponse, ProxyMode } from '../../actor/src/protocol.js';

const args = new Map(process.argv.slice(2).map((a) => [a.replace(/=.*/, ''), a.includes('=') ? a.slice(a.indexOf('=') + 1) : 'true']));
const ctx = buildContext();
const results: Array<{ check: string; outcome: 'passed' | 'failed' | 'skipped'; detail: string }> = [];
const rec = (check: string, outcome: 'passed' | 'failed' | 'skipped', detail: string) => {
  results.push({ check, outcome, detail });
  console.log(`${outcome.toUpperCase().padEnd(7)} ${check}: ${detail}`);
};

async function browserCheck(mode: ProxyMode): Promise<void> {
  const name = `apify session (${mode})`;
  if (!ctx.provider) return rec(name, 'skipped', 'APIFY_TOKEN / APIFY_ACTOR_ID not set');
  let sid: string | null = null;
  try {
    const s = await ctx.sessions.start({ proxyMode: mode, maxMinutes: 5 });
    sid = s.sessionId;
    rec(`${name} start`, 'passed', `egress ${s.egress?.status} browserIp=${s.egress?.browserIp ?? '?'} directIp=${s.egress?.directIp ?? '?'} (${s.egress?.enforcement})`);
    const target = args.get('--target');
    if (target && target !== 'true') {
      const nav = await ctx.sessions.call<NavigateResponse>(sid, '/navigate', { url: target });
      const ins = await ctx.sessions.call<InspectResponse>(sid, '/inspect', { maxElements: 20, includeText: false });
      rec(`${name} navigate`, 'passed', `status ${nav.page.status}, ${ins.elements.length} elements, blocked=${nav.page.blocked?.kind ?? 'no'}`);
    }
  } catch (e) {
    rec(name, 'failed', (e as Error).message);
  } finally {
    if (sid) {
      const c = await ctx.sessions.close(sid).catch((e) => ({ error: (e as Error).message }));
      rec(`${name} close`, 'passed', JSON.stringify((c as any).usage ?? c));
    }
  }
}

async function main() {
  if (ctx.provider) {
    try {
      const u = await ctx.provider.accountUsage();
      rec('apify account usage API', 'passed', `monthly usage $${u.monthlyUsageUsd} of limit $${u.monthlyLimitUsd}`);
    } catch (e) {
      rec('apify account usage API', 'failed', (e as Error).message);
    }
  } else rec('apify account usage API', 'skipped', 'APIFY_TOKEN not set');

  if (args.has('--browser')) await browserCheck('direct');
  else rec('apify session (direct)', 'skipped', 'pass --browser to run (consumes Apify credit)');
  const pm = args.get('--proxy');
  if (pm && pm !== 'true') await browserCheck(pm as ProxyMode);

  if (args.has('--email')) {
    if (!ctx.mail) rec('mailslurp inbox', 'skipped', 'MAILSLURP_API_KEY not set');
    else {
      try {
        const reservation = ctx.usage.reserveInbox();
        // On failure the reservation is left for the recovery sweep, which checks the
        // provider by tag before releasing the slot.
        const inbox = await ctx.mail.createInbox({ name: 'rba live-check', tags: ['rba', 'live-check', Usage.reservationTag(reservation)], expiresInMs: 3600_000 });
        ctx.usage.settleInbox(reservation, inbox.id);
        const emails = await ctx.mail.listEmails(inbox.id, new Date(Date.now() - 60_000).toISOString());
        rec('mailslurp inbox', 'passed', `created ${inbox.emailAddress}, listed ${emails.length} emails`);
        await ctx.mail.deleteInbox(inbox.id);
        rec('mailslurp delete inbox', 'passed', 'deleted');
      } catch (e) {
        rec('mailslurp inbox', 'failed', (e as Error).message);
      }
    }
  } else rec('mailslurp inbox', 'skipped', 'pass --email to run (uses one inbox creation)');

  const failed = results.filter((r) => r.outcome === 'failed').length;
  console.log(`\n${results.length} checks: ${results.filter((r) => r.outcome === 'passed').length} passed, ${failed} failed, ${results.filter((r) => r.outcome === 'skipped').length} skipped`);
  process.exit(failed ? 1 : 0);
}

void main();
