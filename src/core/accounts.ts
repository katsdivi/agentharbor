import type { ProxyMode, StorageState } from '../../actor/src/protocol.js';
import type { Vault } from './crypto.js';
import { newId, nowIso, type Db } from './db.js';
import { RbaError } from './errors.js';
import { modeFromLegacy, type ExecutionMode } from './modes.js';
import { registerSecret } from './redact.js';

export type AccountStatus =
  | 'pending' // record created, signup not yet submitted
  | 'registering' // signup form submission in progress
  | 'awaiting_verification' // submitted, waiting for / following verification email
  | 'unknown' // submission outcome unknown (e.g. timeout after submit); never auto-resubmitted
  | 'active'
  | 'quarantined'
  | 'blocked';

export interface AccountRow {
  id: string;
  target_origin: string;
  label: string | null;
  email: string | null;
  inbox_id: string | null;
  credential_blob: string | null;
  state_blob: string | null;
  state_saved_at: string | null;
  proxy_mode: ProxyMode;
  execution_mode: ExecutionMode | null;
  proxy_country: string | null;
  proxy_session_key: string | null;
  status: AccountStatus;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  last_login_check_at: string | null;
  synthetic: number;
}

/** What Claude sees: references, never secret material. */
export interface AccountView {
  accountId: string;
  targetOrigin: string;
  label: string | null;
  email: string | null;
  inboxRef: string | null;
  credentialRef: string | null;
  browserStateRef: string | null;
  browserStateSavedAt: string | null;
  /** Execution mode this account is bound to (its cookies were created on this route). */
  executionMode: ExecutionMode;
  proxyProfile: { mode: ProxyMode; country: string | null; stickySessionKey: string | null };
  status: AccountStatus;
  statusReason: string | null;
  verifiedAt: string | null;
  createdAt: string;
  lease: { leaseId: string; holder: string; expiresAt: string } | null;
  synthetic: boolean;
  note: string;
}

export interface Credentials {
  password: string;
  username?: string;
}

/** `registering` is included so an interrupted attempt can be resumed (the lease still guarantees exclusivity). */
const ACQUIRABLE: AccountStatus[] = ['pending', 'registering', 'awaiting_verification', 'unknown', 'active'];

export class Accounts {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  create(a: {
    targetOrigin: string;
    label?: string | null;
    email?: string | null;
    inboxId?: string | null;
    proxyMode: ProxyMode;
    /** Defaults to the legacy derivation from proxyMode (remote_direct / remote_proxy). */
    executionMode?: ExecutionMode;
    proxyCountry?: string | null;
    status: AccountStatus;
    synthetic?: boolean;
  }): AccountRow {
    const id = newId('acct');
    const t = nowIso();
    const executionMode = a.executionMode ?? modeFromLegacy(a.proxyMode);
    if ((executionMode === 'remote_proxy') !== (a.proxyMode !== 'direct')) {
      throw new RbaError('invalid_input', `execution mode ${executionMode} does not match proxy ${a.proxyMode}`);
    }
    this.db.run(
      `INSERT INTO accounts (id, target_origin, label, email, inbox_id, proxy_mode, execution_mode, proxy_country, proxy_session_key, status, created_at, updated_at, synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      a.targetOrigin,
      a.label ?? null,
      a.email ?? null,
      a.inboxId ?? null,
      a.proxyMode,
      executionMode,
      a.proxyCountry ? a.proxyCountry.toUpperCase() : null,
      a.proxyMode === 'direct' ? null : `rba${id.slice(5, 17)}`,
      a.status,
      t,
      t,
      a.synthetic ? 1 : 0,
    );
    return this.row(id);
  }

  row(id: string): AccountRow {
    const r = this.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', id);
    if (!r) throw new RbaError('not_found', `account ${id} not found`);
    return r;
  }

  view(r: AccountRow): AccountView {
    const lease = this.db.get<{ lease_id: string; holder: string; expires_at: number }>(
      'SELECT lease_id, holder, expires_at FROM leases WHERE account_id = ? AND expires_at > ?',
      r.id,
      Date.now(),
    );
    return {
      accountId: r.id,
      targetOrigin: r.target_origin,
      label: r.label,
      email: r.email,
      inboxRef: r.inbox_id ? `inbox:${r.id}` : null,
      credentialRef: r.credential_blob ? `cred:${r.id}` : null,
      browserStateRef: r.state_blob ? `state:${r.id}` : null,
      browserStateSavedAt: r.state_saved_at,
      executionMode: r.execution_mode ?? modeFromLegacy(r.proxy_mode),
      proxyProfile: { mode: r.proxy_mode, country: r.proxy_country, stickySessionKey: r.proxy_session_key },
      status: r.status,
      statusReason: r.status_reason,
      verifiedAt: r.verified_at,
      createdAt: r.created_at,
      lease: lease ? { leaseId: lease.lease_id, holder: lease.holder, expiresAt: new Date(lease.expires_at).toISOString() } : null,
      synthetic: !!r.synthetic,
      note: 'Saved browser state is a snapshot of cookies/localStorage; it does not guarantee the site still considers the login valid. Sticky proxy keys request, but do not guarantee, the same exit IP.',
    };
  }

  list(filter: { targetOrigin?: string; status?: AccountStatus } = {}): AccountView[] {
    const rows = this.db.all<AccountRow>(
      `SELECT * FROM accounts WHERE (? IS NULL OR target_origin = ?) AND (? IS NULL OR status = ?) ORDER BY created_at`,
      filter.targetOrigin ?? null,
      filter.targetOrigin ?? null,
      filter.status ?? null,
      filter.status ?? null,
    );
    return rows.map((r) => this.view(r));
  }

  setStatus(id: string, status: AccountStatus, reason: string | null = null, extra: { verified?: boolean } = {}): void {
    const t = nowIso();
    this.db.run(
      `UPDATE accounts SET status = ?, status_reason = ?, updated_at = ?, verified_at = CASE WHEN ? THEN ? ELSE verified_at END WHERE id = ?`,
      status,
      reason,
      t,
      extra.verified ? 1 : 0,
      t,
      id,
    );
  }

  update(id: string, fields: { email?: string; inboxId?: string; label?: string }): void {
    const r = this.row(id);
    this.db.run(
      'UPDATE accounts SET email = ?, inbox_id = ?, label = ?, updated_at = ? WHERE id = ?',
      fields.email ?? r.email,
      fields.inboxId ?? r.inbox_id,
      fields.label ?? r.label,
      nowIso(),
      id,
    );
  }

  setCredentials(id: string, c: Credentials): void {
    registerSecret(c.password);
    const blob = this.vault.encrypt(JSON.stringify(c), `account:${id}:credential`);
    this.db.run('UPDATE accounts SET credential_blob = ?, updated_at = ? WHERE id = ?', blob, nowIso(), id);
  }

  getCredentials(id: string): Credentials | null {
    const r = this.row(id);
    if (!r.credential_blob) return null;
    const c = JSON.parse(this.vault.decrypt(r.credential_blob, `account:${id}:credential`).toString('utf8')) as Credentials;
    registerSecret(c.password);
    return c;
  }

  saveState(id: string, state: StorageState): void {
    const blob = this.vault.encrypt(JSON.stringify(state), `account:${id}:state`);
    const t = nowIso();
    this.db.run('UPDATE accounts SET state_blob = ?, state_saved_at = ?, updated_at = ? WHERE id = ?', blob, t, t, id);
  }

  loadState(id: string): StorageState | null {
    const r = this.row(id);
    if (!r.state_blob) return null;
    return JSON.parse(this.vault.decrypt(r.state_blob, `account:${id}:state`).toString('utf8')) as StorageState;
  }

  quarantine(id: string, reason: string): void {
    this.row(id);
    this.setStatus(id, 'quarantined', reason);
  }

  liftQuarantine(id: string): void {
    const r = this.row(id);
    if (r.status !== 'quarantined' && r.status !== 'blocked') throw new RbaError('conflict', `account is ${r.status}, not quarantined`);
    this.setStatus(id, r.verified_at ? 'active' : 'unknown', 'quarantine lifted by user');
  }

  /** User-requested deletion: removes secrets, state and the row itself. */
  delete(id: string): AccountRow {
    const r = this.row(id);
    this.db.tx(() => {
      const l = this.db.get<{ expires_at: number }>('SELECT expires_at FROM leases WHERE account_id = ?', id);
      if (l && l.expires_at > Date.now()) throw new RbaError('lease_conflict', 'account is leased; release it (close its session) before deleting');
      this.db.run('DELETE FROM leases WHERE account_id = ?', id);
      this.db.run('DELETE FROM accounts WHERE id = ?', id);
    });
    return r;
  }

  /** Throws unless the account may be used (not quarantined/blocked). */
  assertUsable(id: string): void {
    const r = this.row(id);
    if (!ACQUIRABLE.includes(r.status)) {
      throw new RbaError('forbidden', `account ${id} is ${r.status}${r.status_reason ? ` (${r.status_reason})` : ''}; stop and report to the user`);
    }
  }

  // ---- leases -------------------------------------------------------------

  /**
   * Exclusive lease. A lease whose expiry passed (crashed holder, lost
   * heartbeat) is reclaimed; the caller is told so it can treat saved state
   * with suspicion.
   */
  acquire(id: string, holder: string, ttlSecs: number): { leaseId: string; expiresAt: number; reclaimedStale: boolean } {
    return this.db.tx(() => {
      const r = this.row(id);
      if (!ACQUIRABLE.includes(r.status)) {
        throw new RbaError('forbidden', `account ${id} is ${r.status}${r.status_reason ? ` (${r.status_reason})` : ''}; not leasable`);
      }
      const existing = this.db.get<{ lease_id: string; holder: string; expires_at: number }>('SELECT * FROM leases WHERE account_id = ?', id);
      const now = Date.now();
      if (existing && existing.expires_at > now) {
        throw new RbaError('lease_conflict', `account ${id} is leased by ${existing.holder} until ${new Date(existing.expires_at).toISOString()}`);
      }
      if (existing) this.db.run('DELETE FROM leases WHERE account_id = ?', id);
      const leaseId = newId('lease');
      const expiresAt = now + ttlSecs * 1000;
      this.db.run('INSERT INTO leases (account_id, lease_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)', id, leaseId, holder, nowIso(), expiresAt);
      if (existing) this.db.log('warn', `reclaimed stale lease ${existing.lease_id} on ${id} from ${existing.holder}`);
      return { leaseId, expiresAt, reclaimedStale: !!existing };
    });
  }

  /** Extends a lease; throws lease_lost if it expired and was taken over. */
  renew(leaseId: string, ttlSecs: number): void {
    const n = this.db.run('UPDATE leases SET expires_at = ? WHERE lease_id = ?', Date.now() + ttlSecs * 1000, leaseId).changes;
    if (n === 0) throw new RbaError('lease_lost', `lease ${leaseId} no longer held`);
  }

  assertLease(accountId: string, leaseId: string): void {
    const l = this.db.get<{ lease_id: string; expires_at: number }>('SELECT lease_id, expires_at FROM leases WHERE account_id = ?', accountId);
    if (!l || l.lease_id !== leaseId) throw new RbaError('lease_lost', `lease ${leaseId} is not the current lease for ${accountId}`);
  }

  release(leaseId: string): boolean {
    return this.db.run('DELETE FROM leases WHERE lease_id = ?', leaseId).changes > 0;
  }

  leaseFor(accountId: string): { lease_id: string; holder: string; expires_at: number } | undefined {
    return this.db.get('SELECT lease_id, holder, expires_at FROM leases WHERE account_id = ?', accountId);
  }
}
