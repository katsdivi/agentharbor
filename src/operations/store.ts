/**
 * Storage of saved read operations (migration v3).
 *
 * The stored spec (`spec_json`) is an envelope around the vendored api-anything
 * Operation with references only: cookie:/session: slots, no example args, no
 * captured values. Private parts (the two example arg sets, values of session:
 * refs, account constants) are vault-encrypted in `operation_private`, bound
 * to the operation id, its scope (account or public) and its bound origin and
 * route (privacy version 1, migration v6; see privacy.ts).
 */
import { createHash } from 'node:crypto';
import type { Vault } from '../core/crypto.js';
import { newId, nowIso, type Db } from '../core/db.js';
import { RbaError } from '../core/errors.js';
import type { ExecutionMode } from '../core/modes.js';
import { asText, setAt, walk } from '../vendor/api-anything/codec.js';
import { OperationSchema, type Operation } from '../vendor/api-anything/spec.js';
import { PRIVACY_VERSION, registerSecrets } from './privacy.js';

export const UPSTREAM_REV = '4a785e8d9e72a00e2dddc0dc56569a86826df07b';

/** Bounds for stored operations, call logs and repair. */
export const LIMITS = {
  callLogPerOperation: 200,
  repairCooldownMs: 30 * 60_000,
  repairsPerDay: 3,
  outputChars: 20_000,
  previewChars: 2_000,
  operationsPerScope: 200,
} as const;

export type OperationStatus = 'draft' | 'reviewed' | 'needs_review' | 'disabled';

export interface OperationRow {
  id: string;
  name: string;
  account_id: string | null;
  target_origin: string;
  spec_json: string;
  spec_sha256: string;
  upstream_rev: string;
  read_only_declared: number;
  status: OperationStatus;
  reviewed_at: string | null;
  reviewed_sha256: string | null;
  min_tier: number;
  learned_mode: ExecutionMode;
  /** Proxy of the learning session (remote_proxy only), reused as the default route. */
  learned_proxy_json: string | null;
  repair_count: number;
  last_repair_at: string | null;
  last_ok_at: string | null;
  /** Privacy rules version (v6); NULL = saved before them, never callable. */
  privacy_version: number | null;
  /** Account target origin at learn time (account operations). */
  bound_origin: string | null;
  /** {mode, proxyKind} of the learning route (BoundRoute). */
  bound_route_json: string | null;
  created_at: string;
  updated_at: string;
}

/** What is stored as spec_json. */
export interface SpecEnvelope {
  v: 1;
  operation: Operation;
  /** inferShape of the data the operation returned at learn time (key paths and types only). */
  resultShape: Record<string, string>;
}

export type Args = Record<string, string | number | boolean>;

/** The route an operation is bound to (operations.bound_route_json). */
export interface BoundRoute {
  mode: ExecutionMode;
  proxyKind: string | null;
}

export interface OperationPrivate {
  examples: [Args, Args];
  /** Values of session: refs, keyed like the slot ref after "session:" (account constants included). */
  sessionValues: Record<string, string>;
}

/**
 * Encryption binding of the private record. From privacy version 1 it names
 * the scope, the bound origin and the bound route, so a record copied to
 * another operation, or a row whose account, origin or route was edited,
 * does not decrypt.
 */
function privateAad(r: Pick<OperationRow, 'id' | 'account_id' | 'privacy_version' | 'bound_origin' | 'bound_route_json'>): string {
  if (r.privacy_version === null || r.privacy_version === undefined) return `operation:${r.id}:private`;
  return `operation:${r.id}:private:v${r.privacy_version}:${r.account_id ?? 'public'}:${r.bound_origin ?? ''}:${r.bound_route_json ?? ''}`;
}

export function canonicalSpec(env: SpecEnvelope): string {
  return JSON.stringify(env);
}

export function specSha(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

/**
 * The operation without its example values (they are private samples): the
 * params' `example` fields are dropped and every place a param fills is blanked
 * in the request template (keeping the leaf's JSON type). Every call fills those
 * places again, so the template never needs the sample.
 */
export function stripExamples(op: Operation): Operation {
  const types = new Map(walk(op.request).map((l) => [JSON.stringify(l.at), l.type]));
  let request = op.request;
  for (const slot of op.slots) {
    if (slot.param === undefined) continue;
    const t = types.get(JSON.stringify(slot.at));
    request = setAt(request, slot.at, t === 'number' ? 0 : t === 'boolean' ? false : '');
  }
  return { ...op, request, params: op.params.map(({ example: _e, ...p }) => p) };
}

/** Example values (3+ chars) still present in the stored request template, by param name. */
export function exampleLeaks(op: Operation, examples: Args[]): string[] {
  const hay = [op.request.url, op.request.body ?? '', ...Object.values(op.request.headers)]
    .map((x) => {
      let t = x;
      for (let i = 0; i < 3; i++) {
        try {
          const d = decodeURIComponent(t.replace(/\+/g, ' '));
          if (d === t) break;
          t = d;
        } catch {
          break;
        }
      }
      return t.toLowerCase();
    })
    .join('\n');
  const out = new Set<string>();
  for (const ex of examples) for (const [k, v] of Object.entries(ex)) if (asText(v).length >= 3 && hay.includes(asText(v).toLowerCase())) out.add(k);
  return [...out];
}

export class OperationStore {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  row(id: string): OperationRow {
    const r = this.db.get<OperationRow>('SELECT * FROM operations WHERE id = ?', id);
    if (!r) throw new RbaError('not_found', `operation ${id} not found`);
    return r;
  }

  envelope(r: OperationRow): SpecEnvelope {
    const raw = JSON.parse(r.spec_json) as SpecEnvelope;
    return { v: 1, operation: OperationSchema.parse(raw.operation), resultShape: raw.resultShape ?? {} };
  }

  list(o: { accountId?: string; includePublic?: boolean }): OperationRow[] {
    if (o.accountId) {
      return o.includePublic
        ? this.db.all<OperationRow>('SELECT * FROM operations WHERE account_id = ? OR account_id IS NULL ORDER BY created_at', o.accountId)
        : this.db.all<OperationRow>('SELECT * FROM operations WHERE account_id = ? ORDER BY created_at', o.accountId);
    }
    return o.includePublic === false
      ? this.db.all<OperationRow>('SELECT * FROM operations WHERE account_id IS NOT NULL ORDER BY created_at')
      : this.db.all<OperationRow>('SELECT * FROM operations ORDER BY created_at');
  }

  insert(o: {
    name: string;
    accountId: string | null;
    targetOrigin: string;
    envelope: SpecEnvelope;
    learnedMode: ExecutionMode;
    learnedProxy?: { kind: string; country?: string } | null;
    /** Account target origin at learn time (account operations; ignored for public). */
    boundOrigin?: string | null;
    priv: OperationPrivate;
  }): OperationRow {
    const id = newId('op');
    const json = canonicalSpec(o.envelope);
    const boundRoute: BoundRoute = { mode: o.learnedMode, proxyKind: o.learnedMode === 'remote_proxy' ? (o.learnedProxy?.kind ?? null) : null };
    const now = nowIso();
    this.db.tx(() => {
      const n = this.db.get<{ n: number }>("SELECT COUNT(*) n FROM operations WHERE COALESCE(account_id, '') = ?", o.accountId ?? '')!.n;
      if (n >= LIMITS.operationsPerScope) throw new RbaError('conflict', `at most ${LIMITS.operationsPerScope} operations per account (or public); delete some first`);
      if (this.db.get("SELECT 1 FROM operations WHERE COALESCE(account_id, '') = ? AND name = ?", o.accountId ?? '', o.name)) {
        throw new RbaError('conflict', `an operation named "${o.name}" already exists ${o.accountId ? `for account ${o.accountId}` : 'in the public scope'}`);
      }
      this.db.run(
        `INSERT INTO operations (id, name, account_id, target_origin, spec_json, spec_sha256, upstream_rev, read_only_declared, status, min_tier, learned_mode, learned_proxy_json, privacy_version, bound_origin, bound_route_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        o.name,
        o.accountId,
        o.targetOrigin,
        json,
        specSha(json),
        UPSTREAM_REV,
        o.envelope.operation.minTier,
        o.learnedMode,
        o.learnedProxy ? JSON.stringify(o.learnedProxy) : null,
        PRIVACY_VERSION,
        o.accountId ? (o.boundOrigin ?? null) : null,
        JSON.stringify(boundRoute),
        now,
        now,
      );
      this.setPrivateInTx(this.row(id), o.priv);
    });
    return this.row(id);
  }

  /** Replace the spec (repair). The new spec always needs a fresh review. */
  replaceSpec(id: string, env: SpecEnvelope, priv?: OperationPrivate): OperationRow {
    const json = canonicalSpec(env);
    this.db.tx(() => {
      this.db.run(
        `UPDATE operations SET spec_json = ?, spec_sha256 = ?, status = 'needs_review', min_tier = ?, updated_at = ? WHERE id = ?`,
        json,
        specSha(json),
        env.operation.minTier,
        nowIso(),
        id,
      );
      if (priv) this.setPrivateInTx(this.row(id), priv);
    });
    return this.row(id);
  }

  markReviewed(id: string, sha: string): OperationRow {
    const r = this.row(id);
    if (r.spec_sha256 !== sha) throw new RbaError('conflict', 'specSha256 does not match the current spec (it changed since it was shown); review the current spec');
    if (r.status === 'disabled') throw new RbaError('conflict', 'operation is disabled');
    this.db.run(`UPDATE operations SET status = 'reviewed', reviewed_at = ?, reviewed_sha256 = ?, updated_at = ? WHERE id = ?`, nowIso(), sha, nowIso(), id);
    return this.row(id);
  }

  private setPrivateInTx(r: OperationRow, p: OperationPrivate): void {
    const id = r.id;
    const blob = this.vault.encrypt(JSON.stringify(p), privateAad(r));
    this.db.run(
      `INSERT INTO operation_private (operation_id, blob, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
      id,
      blob,
      nowIso(),
    );
  }

  private(id: string): OperationPrivate {
    const row = this.row(id);
    const r = this.db.get<{ blob: string }>('SELECT blob FROM operation_private WHERE operation_id = ?', id);
    if (!r) throw new RbaError('internal', `operation ${id} has no private record`);
    let plain: Buffer;
    try {
      plain = this.vault.decrypt(r.blob, privateAad(row));
    } catch (e) {
      if (e instanceof RbaError && /failed authentication/.test(e.message)) {
        throw new RbaError(
          'forbidden',
          `operation ${id}'s private data is bound to another account, origin or route than its record now names; refusing to use it. Delete the operation and learn it again in the intended account.`,
        );
      }
      throw e;
    }
    const p = JSON.parse(plain.toString('utf8')) as OperationPrivate;
    registerSecrets(Object.values(p.sessionValues));
    return p;
  }

  noteOk(id: string): void {
    this.db.run('UPDATE operations SET last_ok_at = ? WHERE id = ?', nowIso(), id);
  }

  /** Repair budget: cooldown since the last repair and a daily cap. Throws when exhausted. */
  takeRepair(id: string, now = Date.now()): void {
    this.db.tx(() => {
      const r = this.row(id);
      if (r.last_repair_at && now - Date.parse(r.last_repair_at) < LIMITS.repairCooldownMs) {
        throw new RbaError('conflict', `repaired less than ${LIMITS.repairCooldownMs / 60_000} minutes ago; not repairing again yet`);
      }
      const sameDay = r.last_repair_at && now - Date.parse(r.last_repair_at) < 24 * 3600_000;
      const count = sameDay ? r.repair_count : 0;
      if (count >= LIMITS.repairsPerDay) throw new RbaError('conflict', `repair limit reached (${LIMITS.repairsPerDay} per 24 h)`);
      this.db.run('UPDATE operations SET repair_count = ?, last_repair_at = ? WHERE id = ?', count + 1, new Date(now).toISOString(), id);
    });
  }

  logCall(o: { operationId: string; mode: string; tier: number | null; cls: string; ms: number; errorCode?: string | null }): void {
    this.db.run(
      'INSERT INTO operation_calls (id, operation_id, at, mode, tier, class, ms, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId('opcall'),
      o.operationId,
      nowIso(),
      o.mode,
      o.tier,
      o.cls,
      Math.round(o.ms),
      o.errorCode ?? null,
    );
    this.db.run(
      `DELETE FROM operation_calls WHERE operation_id = ? AND id NOT IN (SELECT id FROM operation_calls WHERE operation_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
      o.operationId,
      o.operationId,
      LIMITS.callLogPerOperation,
    );
  }

  recentCalls(id: string, limit = 5): Array<{ at: string; mode: string; tier: number | null; class: string; ms: number | null; error_code: string | null }> {
    return this.db.all('SELECT at, mode, tier, class, ms, error_code FROM operation_calls WHERE operation_id = ? ORDER BY at DESC, rowid DESC LIMIT ?', id, limit);
  }

  delete(id: string): void {
    this.row(id);
    this.db.run('DELETE FROM operations WHERE id = ?', id);
  }

  /** Captures are not kept in this version; drop any expired rows defensively. */
  purgeExpiredCaptures(): number {
    return this.db.run('DELETE FROM operation_captures WHERE expires_at <= ?', nowIso()).changes;
  }
}
