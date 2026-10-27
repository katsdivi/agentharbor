/**
 * Email modes for account inboxes (docs/CLAUDE-ACC-PLUGIN.md §4, decision D13).
 *
 *  - Every inbox is bound to its account's site(s): only mail whose sender domain
 *    belongs to the target (or a configured auth origin) is ever surfaced.
 *  - kept: persists until the user deletes it; the last KEPT_CAP messages are kept.
 *  - disposable: open for DISPOSABLE_OPEN_MS from creation, extendable once up to
 *    MAX_OPEN_MS after creation; then closed and its messages deleted. The same
 *    account may reopen it for another DISPOSABLE_OPEN_MS within REOPEN_WINDOW_MS of
 *    the first close; after that it is retired (provider inbox deleted).
 *  - Retired or deleted addresses keep only a salted one-way hash (inbox_tombstones).
 *
 * Every function takes `now` (epoch ms) so the lifecycle can be tested with a fake clock.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AccountRow } from '../core/accounts.js';
import type { Ctx } from '../core/context.js';
import { nowIso } from '../core/db.js';
import { RbaError } from '../core/errors.js';
import { drainCleanupFor, enqueueCleanup } from '../core/recovery.js';
import type { MailSlurpClient } from './mailslurp.js';
import { senderSite, siteKey } from './verification.js';

export { senderSite, siteKey };

export type EmailMode = 'kept' | 'disposable';
export type InboxStatus = 'open' | 'closed' | 'retired' | 'deleted';

export const DISPOSABLE_OPEN_MS = 60 * 60_000;
export const MAX_OPEN_MS = 24 * 60 * 60_000;
export const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const KEPT_CAP = 100;
/** Provider-side expiry for disposable inboxes: outlives every reopen window (retirement deletes it earlier). */
export const DISPOSABLE_PROVIDER_EXPIRY_MS = REOPEN_WINDOW_MS + MAX_OPEN_MS + 60 * 60_000;
const TRIM_EVERY_MS = 60 * 60_000;

export interface InboxMetaRow {
  account_id: string;
  inbox_id: string | null;
  address: string | null;
  mode: EmailMode;
  bound_sites_json: string;
  status: InboxStatus;
  created_at: number;
  open_until: number | null;
  extended: number;
  closed_at: number | null;
  retire_at: number | null;
  reopen_count: number;
  last_trim_at: number | null;
  updated_at: number;
}

type MailLike = Pick<MailSlurpClient, 'listAllEmails' | 'deleteEmail'>;

/** Sites an account's inbox is bound to: its target plus configured auth origins. */
export function boundSitesFor(origins: string[]): string[] {
  const out = new Set<string>();
  for (const o of origins) {
    try {
      out.add(siteKey(new URL(o).hostname));
    } catch {
      /* not an origin */
    }
  }
  return [...out];
}

export function senderAllowed(from: string | null | undefined, sites: string[]): boolean {
  const s = senderSite(from);
  return s !== '' && sites.includes(s);
}

function salt(ctx: Pick<Ctx, 'db'>): string {
  const r = ctx.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'inbox_tombstone_salt'`);
  if (r) return r.value;
  const v = randomBytes(32).toString('hex');
  ctx.db.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('inbox_tombstone_salt', ?)`, v);
  return ctx.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'inbox_tombstone_salt'`)!.value;
}

export function addressHash(ctx: Pick<Ctx, 'db'>, address: string): string {
  return createHash('sha256').update(`${salt(ctx)}:${address.trim().toLowerCase()}`).digest('hex');
}

export function isTombstoned(ctx: Pick<Ctx, 'db'>, address: string): boolean {
  return !!ctx.db.get('SELECT 1 FROM inbox_tombstones WHERE hash = ?', addressHash(ctx, address));
}

function tombstone(ctx: Pick<Ctx, 'db'>, address: string, reason: 'retired' | 'deleted'): void {
  ctx.db.run('INSERT OR IGNORE INTO inbox_tombstones (hash, reason, created_at) VALUES (?, ?, ?)', addressHash(ctx, address), reason, nowIso());
}

/** Record the mode of a freshly created inbox. */
export function recordInbox(ctx: Pick<Ctx, 'db'>, o: { accountId: string; inboxId: string; address: string; mode: EmailMode; boundSites: string[] }, now = Date.now()): void {
  ctx.db.run(
    `INSERT INTO inbox_meta (account_id, inbox_id, address, mode, bound_sites_json, status, created_at, open_until, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET inbox_id = excluded.inbox_id, address = excluded.address, mode = excluded.mode,
       bound_sites_json = excluded.bound_sites_json, status = 'open', created_at = excluded.created_at, open_until = excluded.open_until,
       extended = 0, closed_at = NULL, retire_at = NULL, reopen_count = 0, last_trim_at = NULL, updated_at = excluded.updated_at`,
    o.accountId,
    o.inboxId,
    o.address,
    o.mode,
    JSON.stringify(o.boundSites),
    now,
    o.mode === 'disposable' ? now + DISPOSABLE_OPEN_MS : null,
    now,
  );
}

/** The inbox row for an account; accounts created before email modes are adopted as kept. */
export function inboxMeta(ctx: Pick<Ctx, 'db' | 'sessions'>, acct: AccountRow, now = Date.now()): InboxMetaRow | null {
  const r = ctx.db.get<InboxMetaRow>('SELECT * FROM inbox_meta WHERE account_id = ?', acct.id);
  if (r) return r;
  if (!acct.inbox_id || !acct.email) return null;
  recordInbox(ctx, { accountId: acct.id, inboxId: acct.inbox_id, address: acct.email, mode: 'kept', boundSites: boundSitesFor(ctx.sessions.originsFor(acct)) }, now);
  return ctx.db.get<InboxMetaRow>('SELECT * FROM inbox_meta WHERE account_id = ?', acct.id)!;
}

export function boundSites(m: InboxMetaRow): string[] {
  return JSON.parse(m.bound_sites_json) as string[];
}

/** Throws unless the inbox may be read now (kept, or disposable inside its open window). */
export function assertReadable(ctx: Pick<Ctx, 'db' | 'sessions'>, acct: AccountRow, now = Date.now()): InboxMetaRow {
  const m = inboxMeta(ctx, acct, now);
  if (!m || !m.inbox_id || !m.address) throw new RbaError('invalid_input', 'account has no inbox (deleted, retired, or never created)');
  if (m.status === 'deleted' || m.status === 'retired') throw new RbaError('invalid_input', `this inbox was ${m.status}; its address can never be used again`);
  if (m.mode === 'disposable' && (m.status !== 'open' || (m.open_until ?? 0) <= now)) {
    const until = m.retire_at ?? (m.open_until ?? now) + REOPEN_WINDOW_MS;
    throw new RbaError(
      'conflict',
      now < until
        ? `disposable inbox is closed; reopen it with email_inbox_reopen (possible until ${new Date(until).toISOString()})`
        : 'disposable inbox is closed and past its reopen window',
    );
  }
  return m;
}

/** Extend a disposable inbox once, to at most MAX_OPEN_MS after creation. */
export function extendInbox(ctx: Pick<Ctx, 'db' | 'sessions'>, acct: AccountRow, hoursFromCreation: number, now = Date.now()): InboxMetaRow {
  const m = assertReadable(ctx, acct, now);
  if (m.mode !== 'disposable') throw new RbaError('invalid_input', 'only disposable inboxes have an open window');
  if (m.extended) throw new RbaError('conflict', 'this disposable inbox was already extended once');
  if (m.reopen_count > 0) throw new RbaError('conflict', 'a reopened disposable inbox cannot be extended');
  const until = m.created_at + Math.min(Math.max(1, hoursFromCreation) * 3600_000, MAX_OPEN_MS);
  if (until <= (m.open_until ?? 0)) throw new RbaError('invalid_input', 'the new end must be later than the current one');
  ctx.db.run('UPDATE inbox_meta SET open_until = ?, extended = 1, updated_at = ? WHERE account_id = ?', until, now, acct.id);
  return ctx.db.get<InboxMetaRow>('SELECT * FROM inbox_meta WHERE account_id = ?', acct.id)!;
}

async function purgeMessages(mail: MailLike, inboxId: string, keepNewest = 0): Promise<number> {
  const all = await mail.listAllEmails(inboxId);
  const drop = keepNewest > 0 ? all.slice(0, Math.max(0, all.length - keepNewest)) : all;
  for (const e of drop) {
    try {
      await mail.deleteEmail(e.id);
    } catch (err) {
      if (!/\b404\b|not found/i.test((err as Error).message)) throw err;
    }
  }
  return drop.length;
}

/** Reopen a closed disposable inbox (same account only) for another DISPOSABLE_OPEN_MS. */
export async function reopenInbox(ctx: Pick<Ctx, 'db' | 'sessions'>, mail: MailLike, acct: AccountRow, now = Date.now()): Promise<InboxMetaRow> {
  const m = inboxMeta(ctx, acct, now);
  if (!m || !m.inbox_id) throw new RbaError('invalid_input', 'account has no inbox');
  if (m.mode !== 'disposable') throw new RbaError('invalid_input', 'only disposable inboxes can be reopened');
  if (m.status === 'open' && (m.open_until ?? 0) > now) throw new RbaError('conflict', 'inbox is already open');
  if (m.status === 'retired' || m.status === 'deleted') throw new RbaError('invalid_input', `this inbox was ${m.status}; it cannot be reopened`);
  const retireAt = m.retire_at ?? (m.open_until ?? now) + REOPEN_WINDOW_MS;
  if (now >= retireAt) throw new RbaError('conflict', 'the 7-day reopen window has passed');
  // Mail that arrived while closed is never surfaced.
  await purgeMessages(mail, m.inbox_id);
  ctx.db.run(
    `UPDATE inbox_meta SET status = 'open', open_until = ?, closed_at = COALESCE(closed_at, ?), retire_at = ?, reopen_count = reopen_count + 1, updated_at = ? WHERE account_id = ?`,
    now + DISPOSABLE_OPEN_MS,
    now,
    retireAt,
    now,
    acct.id,
  );
  return ctx.db.get<InboxMetaRow>('SELECT * FROM inbox_meta WHERE account_id = ?', acct.id)!;
}

/**
 * Delete an inbox completely: messages and provider inbox (queued and retried if the
 * provider call fails), the account's link to it, and every readable trace locally.
 * Only a salted hash of the address remains, so it is never reused.
 */
export async function deleteInbox(ctx: Ctx, acct: AccountRow, o: { forgetAddress?: boolean } = {}, now = Date.now()): Promise<{ provider: 'deleted' | 'cleanup_pending'; error?: string }> {
  const m = inboxMeta(ctx, acct, now);
  const inboxId = m?.inbox_id ?? acct.inbox_id;
  const address = m?.address ?? acct.email;
  if (!inboxId && !address) throw new RbaError('invalid_input', 'account has no inbox');
  if (address) tombstone(ctx, address, 'deleted');
  let provider: 'deleted' | 'cleanup_pending' = 'deleted';
  let error: string | undefined;
  if (inboxId) {
    enqueueCleanup(ctx.db, { kind: 'mailslurp_inbox', ref: inboxId, accountId: acct.id });
    const r = ctx.mail ? await drainCleanupFor(ctx, 'mailslurp_inbox', inboxId) : 'MailSlurp not configured in this process';
    if (r !== true) {
      provider = 'cleanup_pending';
      error = r;
    }
  }
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE inbox_meta SET status = 'deleted', inbox_id = NULL, address = NULL, bound_sites_json = '[]', open_until = NULL, updated_at = ? WHERE account_id = ?`, now, acct.id);
    if (o.forgetAddress) ctx.db.run('UPDATE accounts SET inbox_id = NULL, email = NULL, updated_at = ? WHERE id = ?', nowIso(), acct.id);
    else ctx.db.run('UPDATE accounts SET inbox_id = NULL, updated_at = ? WHERE id = ?', nowIso(), acct.id);
  });
  return { provider, ...(error ? { error } : {}) };
}

/** Local side of an inbox deletion done elsewhere (account_delete with deleteInbox): tombstone and forget. */
export function forgetInbox(ctx: Pick<Ctx, 'db'>, accountId: string, address: string | null, now = Date.now()): void {
  if (address) tombstone(ctx, address, 'deleted');
  ctx.db.run(`UPDATE inbox_meta SET status = 'deleted', inbox_id = NULL, address = NULL, bound_sites_json = '[]', open_until = NULL, updated_at = ? WHERE account_id = ?`, now, accountId);
}

/** Trim a kept inbox to its newest KEPT_CAP messages (at most once per TRIM_EVERY_MS unless forced). */
export async function trimKept(ctx: Pick<Ctx, 'db'>, mail: MailLike, m: InboxMetaRow, now = Date.now(), force = false): Promise<number> {
  if (m.mode !== 'kept' || m.status !== 'open' || !m.inbox_id) return 0;
  if (!force && m.last_trim_at && now - m.last_trim_at < TRIM_EVERY_MS) return 0;
  const n = await purgeMessages(mail, m.inbox_id, KEPT_CAP);
  ctx.db.run('UPDATE inbox_meta SET last_trim_at = ? WHERE account_id = ?', now, m.account_id);
  return n;
}

export interface SweepReport {
  closed: number;
  retired: number;
  trimmed: number;
  failed: number;
}

/**
 * Enforce the lifecycle (run at startup and periodically): close expired disposable
 * inboxes (delete their messages), retire them after the reopen window, trim kept
 * inboxes. A failed provider call leaves the row as it was, so the next sweep retries.
 */
export async function sweepInboxes(ctx: Ctx, now = Date.now()): Promise<SweepReport> {
  const rep: SweepReport = { closed: 0, retired: 0, trimmed: 0, failed: 0 };
  let rows: InboxMetaRow[];
  try {
    rows = ctx.db.all<InboxMetaRow>(`SELECT * FROM inbox_meta WHERE status IN ('open', 'closed')`);
  } catch {
    return rep; // table missing (database not migrated yet)
  }
  for (const m of rows) {
    try {
      if (m.mode === 'disposable' && m.status === 'open' && (m.open_until ?? 0) <= now) {
        if (!ctx.mail || !m.inbox_id) continue;
        await purgeMessages(ctx.mail, m.inbox_id);
        const closedAt = m.closed_at ?? now;
        ctx.db.run(`UPDATE inbox_meta SET status = 'closed', closed_at = ?, retire_at = COALESCE(retire_at, ?), updated_at = ? WHERE account_id = ?`, closedAt, closedAt + REOPEN_WINDOW_MS, now, m.account_id);
        rep.closed++;
        m.status = 'closed';
        m.retire_at = m.retire_at ?? closedAt + REOPEN_WINDOW_MS;
      }
      if (m.mode === 'disposable' && m.status === 'closed' && (m.retire_at ?? Infinity) <= now) {
        if (m.address) tombstone(ctx, m.address, 'retired');
        if (m.inbox_id) enqueueCleanup(ctx.db, { kind: 'mailslurp_inbox', ref: m.inbox_id, accountId: m.account_id });
        ctx.db.tx(() => {
          ctx.db.run(`UPDATE inbox_meta SET status = 'retired', inbox_id = NULL, address = NULL, updated_at = ? WHERE account_id = ?`, now, m.account_id);
          ctx.db.run('UPDATE accounts SET inbox_id = NULL, updated_at = ? WHERE id = ?', nowIso(), m.account_id);
        });
        rep.retired++;
      }
      if (m.mode === 'kept' && ctx.mail && (await trimKept(ctx, ctx.mail, m, now)) > 0) rep.trimmed++;
    } catch (e) {
      rep.failed++;
      ctx.db.log('warn', `inbox lifecycle for account ${m.account_id} failed: ${(e as Error).message}`);
    }
  }
  return rep;
}

/** Public view of an inbox row (no provider ids). */
export function inboxView(m: InboxMetaRow, now = Date.now()) {
  const reopenUntil = m.mode === 'disposable' ? m.retire_at ?? (m.open_until ? m.open_until + REOPEN_WINDOW_MS : null) : null;
  return {
    accountId: m.account_id,
    address: m.address,
    mode: m.mode,
    status: m.mode === 'disposable' && m.status === 'open' && (m.open_until ?? 0) <= now ? 'closing' : m.status,
    boundSites: boundSites(m),
    openUntil: m.open_until ? new Date(m.open_until).toISOString() : null,
    extended: !!m.extended,
    reopenCount: m.reopen_count,
    reopenableUntil: reopenUntil && m.status !== 'retired' && m.status !== 'deleted' ? new Date(reopenUntil).toISOString() : null,
    createdAt: new Date(m.created_at).toISOString(),
  };
}
