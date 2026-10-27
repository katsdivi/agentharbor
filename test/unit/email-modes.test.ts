/**
 * Email modes (docs/CLAUDE-ACC-PLUGIN.md §4): sender-site binding, the disposable
 * lifecycle (open / extend / close / reopen / retire) on a fake clock, the kept
 * retention cap, and complete deletion with a hash tombstone. Fake MailSlurp only.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContext, type Ctx } from '../../src/core/context.js';
import {
  DISPOSABLE_OPEN_MS,
  KEPT_CAP,
  MAX_OPEN_MS,
  REOPEN_WINDOW_MS,
  addressHash,
  assertReadable,
  boundSitesFor,
  deleteInbox,
  extendInbox,
  inboxMeta,
  isTombstoned,
  recordInbox,
  reopenInbox,
  senderAllowed,
  sweepInboxes,
  trimKept,
} from '../../src/email/inboxes.js';
import { MailSlurpClient } from '../../src/email/mailslurp.js';
import { evaluateEmail } from '../../src/email/verification.js';
import { TOOLS } from '../../src/mcp/tools/index.js';
import { startFakeMailSlurp, type FakeMailSlurp } from '../fakes/mailslurp.js';
import { testConfig } from '../helpers/ctx.js';

const TARGET = 'https://app.example.com';
let fake: FakeMailSlurp;
let ctx: Ctx;

beforeEach(async () => {
  fake = await startFakeMailSlurp();
  ctx = buildContext({
    cfg: testConfig({ RBA_AUTHORIZED_TARGETS: `${TARGET}|https://auth.example-login.com` }),
    provider: null,
    localProvider: null,
    mail: new MailSlurpClient(fake.apiKey, fake.url),
  });
});

afterEach(async () => {
  ctx.sessions.stopHeartbeat();
  ctx.db.close();
  rmSync(join(ctx.cfg.dataDir, '..'), { recursive: true, force: true });
  await fake.close();
});

async function account(mode: 'kept' | 'disposable', now: number) {
  const acct = ctx.accounts.create({ targetOrigin: TARGET, proxyMode: 'direct', status: 'active' });
  const inbox = await ctx.mail!.createInbox({ name: 't', tags: [] });
  ctx.accounts.update(acct.id, { email: inbox.emailAddress, inboxId: inbox.id });
  recordInbox(ctx, { accountId: acct.id, inboxId: inbox.id, address: inbox.emailAddress, mode, boundSites: boundSitesFor(ctx.sessions.originsFor(ctx.accounts.row(acct.id))) }, now);
  return { acct: ctx.accounts.row(acct.id), inbox };
}

const msgsIn = (inboxId: string) => fake.emails.filter((e) => e.inboxId === inboxId).length;

describe('sender-site binding', () => {
  it('binds to the target and its auth origins, by registrable domain', () => {
    expect(boundSitesFor(ctx.sessions.originsFor(ctx.accounts.create({ targetOrigin: TARGET, proxyMode: 'direct', status: 'active' })))).toEqual(['example.com', 'example-login.com']);
    const sites = ['example.com'];
    expect(senderAllowed('no-reply@mail.example.com', sites)).toBe(true);
    expect(senderAllowed('Example <hello@example.com>', sites)).toBe(true);
    expect(senderAllowed('promo@other.test', sites)).toBe(false);
    expect(senderAllowed('no-reply@example.com.evil.test', sites)).toBe(false);
    expect(senderAllowed('', sites)).toBe(false);
    expect(senderAllowed('a@127.0.0.1', ['127.0.0.1'])).toBe(true);
  });

  it('verification ignores mail from other senders, even with a valid link', () => {
    const q = {
      inboxId: 'in1',
      inboxAddress: 'abc@fake-mailslurp.test',
      sinceIso: '2026-10-08T10:00:00.000Z',
      targetOrigin: TARGET,
      allowedLinkOrigins: [TARGET],
      timeoutMs: 1000,
      allowedSenderSites: ['example.com'],
    };
    const email = { id: 'e1', inboxId: 'in1', to: ['abc@fake-mailslurp.test'], subject: 'Verify', createdAt: '2026-10-08T10:01:00.000Z', body: `<a href="${TARGET}/verify?t=1">v</a>` };
    expect(evaluateEmail({ ...email, from: 'attacker@other.test' } as any, q).reason).toMatch(/unrelated: sender not from a site this inbox is bound to/);
    expect(evaluateEmail({ ...email, from: 'no-reply@example.com' } as any, q).result?.link).toBe(`${TARGET}/verify?t=1`);
  });

  it('email_search lists only bound-site mail', async () => {
    const { acct, inbox } = await account('kept', Date.now());
    fake.deliver(inbox.emailAddress, { from: 'promo@other.test', subject: 'Deals', body: 'buy' });
    fake.deliver(inbox.emailAddress, { from: 'no-reply@example.com', subject: 'Welcome', body: 'hello' });
    const tool = TOOLS.find((t) => t.name === 'email_search')!;
    const r = (await tool.handler(ctx, { accountId: acct.id })).data as any;
    expect(r.untrusted.messages.map((m: any) => m.subject)).toEqual(['Welcome']);
    expect(r.ignoredOtherSenders).toBe(1);
    const read = TOOLS.find((t) => t.name === 'email_read')!;
    const promo = fake.emails.find((e) => e.subject === 'Deals')!;
    await expect(read.handler(ctx, { accountId: acct.id, emailId: promo.id })).rejects.toThrow(/not from a site this inbox is bound to/);
  });
});

describe('disposable lifecycle (fake clock)', () => {
  it('open 1 h, extend once to 24 h, close and empty, reopen within 7 days, then retire', async () => {
    const t0 = Date.parse('2026-10-15T10:00:00Z');
    const { acct, inbox } = await account('disposable', t0);
    expect(assertReadable(ctx, acct, t0 + DISPOSABLE_OPEN_MS - 1).mode).toBe('disposable');

    // Extend once, capped at 24 h after creation.
    const ext = extendInbox(ctx, acct, 48, t0 + 10 * 60_000);
    expect(ext.open_until).toBe(t0 + MAX_OPEN_MS);
    expect(() => extendInbox(ctx, acct, 24, t0 + 20 * 60_000)).toThrow(/already extended/);

    // Past the window: unreadable, then the sweep closes it and deletes its messages.
    fake.deliver(inbox.emailAddress, { from: 'no-reply@example.com', subject: 'Code', body: 'code 123456' });
    const closedAt = t0 + MAX_OPEN_MS + 1;
    expect(() => assertReadable(ctx, acct, closedAt)).toThrow(/closed; reopen/);
    expect((await sweepInboxes(ctx, closedAt)).closed).toBe(1);
    expect(msgsIn(inbox.id)).toBe(0);
    expect(inboxMeta(ctx, acct, closedAt)!.status).toBe('closed');

    // Mail that arrives while closed is never shown: reopening deletes it first.
    fake.deliver(inbox.emailAddress, { from: 'no-reply@example.com', subject: 'Late', body: 'late' });
    const reopenAt = closedAt + 3 * 24 * 3600_000;
    const re = await reopenInbox(ctx, ctx.mail!, acct, reopenAt);
    expect(re.status).toBe('open');
    expect(re.open_until).toBe(reopenAt + DISPOSABLE_OPEN_MS);
    expect(re.retire_at).toBe(closedAt + REOPEN_WINDOW_MS);
    expect(msgsIn(inbox.id)).toBe(0);
    expect(() => extendInbox(ctx, acct, 24, reopenAt + 1)).toThrow(/already extended|reopened/);

    // Closes again after the reopened hour; the reopen window stays anchored to the first close.
    await sweepInboxes(ctx, reopenAt + DISPOSABLE_OPEN_MS + 1);
    expect(inboxMeta(ctx, acct)!.status).toBe('closed');
    await expect(reopenInbox(ctx, ctx.mail!, acct, closedAt + REOPEN_WINDOW_MS)).rejects.toThrow(/7-day reopen window/);

    // Retired: provider inbox deleted, address unusable, only a hash kept.
    const address = inbox.emailAddress;
    const rep = await sweepInboxes(ctx, closedAt + REOPEN_WINDOW_MS);
    expect(rep.retired).toBe(1);
    await (await import('../../src/core/recovery.js')).drainCleanup(ctx, { force: true });
    expect(fake.inboxes.has(inbox.id)).toBe(false);
    const m = ctx.db.get<any>('SELECT * FROM inbox_meta WHERE account_id = ?', acct.id);
    expect(m).toMatchObject({ status: 'retired', address: null, inbox_id: null });
    expect(ctx.accounts.row(acct.id).inbox_id).toBeNull();
    expect(isTombstoned(ctx, address)).toBe(true);
    expect(JSON.stringify(ctx.db.all('SELECT * FROM inbox_tombstones'))).not.toContain(address);
  });

  it('a sweep with a failing provider leaves the inbox open and retries next time', async () => {
    const t0 = Date.parse('2026-10-15T10:00:00Z');
    const { acct, inbox } = await account('disposable', t0);
    fake.deliver(inbox.emailAddress, { from: 'no-reply@example.com', subject: 'x', body: 'x' });
    fake.state.failListCalls = 1;
    const r1 = await sweepInboxes(ctx, t0 + DISPOSABLE_OPEN_MS + 1);
    expect(r1).toMatchObject({ closed: 0, failed: 1 });
    expect(inboxMeta(ctx, acct)!.status).toBe('open');
    const r2 = await sweepInboxes(ctx, t0 + DISPOSABLE_OPEN_MS + 2);
    expect(r2.closed).toBe(1);
    expect(msgsIn(inbox.id)).toBe(0);
  });

  it('kept inboxes are never closed by the sweep', async () => {
    const t0 = Date.parse('2026-10-15T10:00:00Z');
    const { acct } = await account('kept', t0);
    await sweepInboxes(ctx, t0 + 30 * 24 * 3600_000);
    expect(assertReadable(ctx, acct, t0 + 30 * 24 * 3600_000).status).toBe('open');
  });
});

describe('kept retention cap', () => {
  it(`keeps only the newest ${KEPT_CAP} messages`, async () => {
    const { acct, inbox } = await account('kept', Date.now());
    const base = Date.parse('2026-10-15T00:00:00Z');
    for (let i = 0; i < KEPT_CAP + 7; i++) {
      fake.deliver(inbox.emailAddress, { from: 'no-reply@example.com', subject: `m${i}`, body: 'x', createdAt: new Date(base + i * 1000).toISOString() });
    }
    const removed = await trimKept(ctx, ctx.mail!, inboxMeta(ctx, acct)!, Date.now(), true);
    expect(removed).toBe(7);
    const left = fake.emails.filter((e) => e.inboxId === inbox.id).map((e) => e.subject);
    expect(left).toHaveLength(KEPT_CAP);
    expect(left).not.toContain('m0');
    expect(left).toContain(`m${KEPT_CAP + 6}`);
    // Throttled: a second unforced trim within the hour does nothing.
    expect(await trimKept(ctx, ctx.mail!, inboxMeta(ctx, acct)!)).toBe(0);
  });
});

describe('deletion and tombstone', () => {
  it('deletes the inbox and messages completely, keeps only a salted hash, and refuses reuse', async () => {
    const { acct, inbox } = await account('kept', Date.now());
    fake.deliver(inbox.emailAddress, { from: 'no-reply@example.com', subject: 'Hi', body: 'x' });
    const r = await deleteInbox(ctx, acct);
    expect(r.provider).toBe('deleted');
    expect(fake.inboxes.has(inbox.id)).toBe(false);
    const after = ctx.accounts.row(acct.id);
    expect(after.inbox_id).toBeNull();
    expect(after.email).toBe(inbox.emailAddress); // still the site login name unless forgetAddress
    const m = ctx.db.get<any>('SELECT * FROM inbox_meta WHERE account_id = ?', acct.id);
    expect(m).toMatchObject({ status: 'deleted', address: null, inbox_id: null, bound_sites_json: '[]' });
    expect(isTombstoned(ctx, inbox.emailAddress)).toBe(true);
    expect(isTombstoned(ctx, inbox.emailAddress.toUpperCase())).toBe(true);
    // Salted: the stored hash is not a plain sha256 of the address.
    const { createHash } = await import('node:crypto');
    expect(addressHash(ctx, inbox.emailAddress)).not.toBe(createHash('sha256').update(inbox.emailAddress).digest('hex'));
    expect(() => assertReadable(ctx, ctx.accounts.row(acct.id))).toThrow(/no inbox/);
  });

  it('forgetAddress also removes the address from the account record', async () => {
    const { acct } = await account('disposable', Date.now());
    await deleteInbox(ctx, acct, { forgetAddress: true });
    expect(ctx.accounts.row(acct.id).email).toBeNull();
  });

  it('a failed provider deletion is queued for retry; nothing readable is kept locally', async () => {
    const { acct, inbox } = await account('kept', Date.now());
    const mail = ctx.mail!;
    const orig = mail.deleteInbox.bind(mail);
    mail.deleteInbox = async () => {
      throw new Error('MailSlurp DELETE /inboxes failed: 500');
    };
    const r = await deleteInbox(ctx, acct);
    expect(r.provider).toBe('cleanup_pending');
    expect(ctx.db.get<any>('SELECT * FROM inbox_meta WHERE account_id = ?', acct.id)).toMatchObject({ status: 'deleted', address: null });
    mail.deleteInbox = orig;
    await (await import('../../src/core/recovery.js')).drainCleanup(ctx, { force: true });
    expect(fake.inboxes.has(inbox.id)).toBe(false);
  });

  it('accounts created before email modes are adopted as kept and bound to their site', async () => {
    const acct = ctx.accounts.create({ targetOrigin: TARGET, proxyMode: 'direct', status: 'active' });
    const inbox = await ctx.mail!.createInbox({ name: 'legacy', tags: [] });
    ctx.accounts.update(acct.id, { email: inbox.emailAddress, inboxId: inbox.id });
    const m = inboxMeta(ctx, ctx.accounts.row(acct.id))!;
    expect(m.mode).toBe('kept');
    expect(JSON.parse(m.bound_sites_json)).toContain('example.com');
  });
});

describe('tool annotations', () => {
  it('every email-mode tool declares annotations and a title', () => {
    for (const name of ['email_inbox_list', 'email_inbox_extend', 'email_inbox_reopen', 'email_inbox_delete', 'email_read', 'email_search', 'email_wait_for_verification', 'account_register', 'account_delete']) {
      const t = TOOLS.find((x) => x.name === name)!;
      expect(t, name).toBeDefined();
      expect(t.title, name).toBeTruthy();
      expect(t.annotations, name).toBeDefined();
    }
    expect(TOOLS.find((t) => t.name === 'email_inbox_delete')!.annotations!.destructiveHint).toBe(true);
    expect(TOOLS.find((t) => t.name === 'email_inbox_list')!.annotations!.readOnlyHint).toBe(true);
  });
});
