import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { monthKey, nowIso, type Db } from './db.js';
import { RbaError } from './errors.js';
import type { BrowserProvider, RunInfo } from '../providers/types.js';

/**
 * basis (what the evidence is, not a claim that a charge is final):
 *  - provider_preliminary: Apify's figure while the run is active or less than
 *    10 min after it finished. Observed to rise afterwards ($0.00005 -> $0.00507).
 *  - provider_reconciled: Apify's figure as last re-read at least 10 min after the
 *    run finished. `detail.reconciledAt` records when. Apify gives no "final"
 *    signal, so it can still change: reconciled runs of the current billing
 *    cycle are re-read every RECHECK_MS, and changes are kept in `detail.history`.
 *  - estimate: computed locally (runtime x memory x RBA_APIFY_CU_PRICE_USD).
 *  - counted: a local count of an event (inbox created, email received).
 */
export type UsageBasis = 'provider_reconciled' | 'provider_preliminary' | 'estimate' | 'counted';

/** Re-read already-reconciled runs of the current cycle at most this often. */
const RECHECK_MS = 6 * 3600_000;
const MAX_RECONCILE_PER_CALL = 100;

export interface AccountUsage {
  usd: number;
  /** Start of the provider's billing cycle (ISO), when known. */
  cycleStart: string | null;
}

export interface SessionEstimate {
  /** Compute at the configured CU price for the whole run timeout (session minutes + 1). Bounded by Apify's run timeout and fixed memory. */
  computeUsd: number;
  /** Residential bandwidth RESERVED for the session (RBA_RESIDENTIAL_RESERVE_GB x price). Not a hard cap: enforced by a 60 s sweep on Apify's lagging figure. */
  residentialReserveUsd: number;
  /** Planning estimate used by the budget gate. Not a worst-case bound (residential traffic, data transfer and storage ops are not hard-capped). */
  totalUsd: number;
}

interface ActiveSession {
  id: string;
  provider: string;
  proxy_mode: string;
  provider_run_id: string | null;
  memory_mb: number;
  max_minutes: number;
  created_at: string;
}

export class Usage {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly provider: BrowserProvider | null,
  ) {
    // Older rows used 'measured' / 'measured_preliminary'.
    this.db.run(`UPDATE usage SET basis = 'provider_reconciled' WHERE basis = 'measured'`);
    this.db.run(`UPDATE usage SET basis = 'provider_preliminary' WHERE basis = 'measured_preliminary'`);
  }

  /**
   * Planning estimate for one session (see SessionEstimate). Compute is bounded:
   * the Apify run timeout is session minutes + 1 and memory is fixed, so at the
   * configured CU price compute cannot exceed `computeUsd`. Residential traffic is
   * only reserved; external data transfer ($0.20/GB observed) and storage
   * operations are small but not capped.
   */
  sessionEstimate(memoryMb: number, minutes: number, proxyMode: string = 'direct'): SessionEstimate {
    const computeUsd = (memoryMb / 1024) * ((minutes + 1) / 60) * this.cfg.apify.cuPriceUsd;
    const residentialReserveUsd = proxyMode === 'residential' ? this.cfg.apify.residentialReserveGb * this.cfg.apify.residentialGbPriceUsd : 0;
    return { computeUsd, residentialReserveUsd, totalUsd: computeUsd + residentialReserveUsd };
  }

  record(kind: string, ref: string, quantity: number, unit: string, usd: number | null, basis: UsageBasis, detail?: unknown): void {
    this.db.run(
      `INSERT INTO usage (ts, month, provider, kind, ref, quantity, unit, usd, basis, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, kind, ref) DO UPDATE SET ts = excluded.ts, quantity = excluded.quantity, usd = excluded.usd, basis = excluded.basis, detail_json = excluded.detail_json`,
      nowIso(),
      monthKey(),
      kind.startsWith('mailslurp') ? 'mailslurp' : 'apify',
      kind,
      ref,
      quantity,
      unit,
      usd,
      basis,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }

  /** Store provider-reported run usage (or a local estimate if the provider gave none). Keeps a history of changed figures. */
  recordRun(info: RunInfo, memoryMb: number, startedAtIso: string): void {
    if (info.usageUsd !== null) {
      const prev = this.db.get<{ usd: number | null; basis: string; detail_json: string | null }>(`SELECT usd, basis, detail_json FROM usage WHERE kind = 'apify_browser_run' AND ref = ?`, info.runId);
      let history: Array<{ usd: number | null; basis: string; readAt: string | null }> = [];
      let prevReadAt: string | null = null;
      try {
        const d = JSON.parse(prev?.detail_json ?? '{}') as { history?: typeof history; reconciledAt?: string; readAt?: string };
        history = d.history ?? [];
        prevReadAt = d.readAt ?? d.reconciledAt ?? null;
      } catch {
        /* keep empty */
      }
      if (prev && prev.usd !== null && prev.basis !== 'estimate' && Math.abs((prev.usd ?? 0) - info.usageUsd) > 1e-9) {
        history = [...history, { usd: prev.usd, basis: prev.basis, readAt: prevReadAt }].slice(-10);
      }
      const now = nowIso();
      this.record('apify_browser_run', info.runId, info.computeUnits ?? 0, 'compute_units', info.usageUsd, info.preliminary ? 'provider_preliminary' : 'provider_reconciled', {
        runtimeSecs: info.runtimeSecs,
        state: info.state,
        startedAt: startedAtIso,
        finishedAt: info.finishedAt,
        readAt: now,
        ...(info.preliminary ? {} : { reconciledAt: now }),
        ...(history.length ? { history } : {}),
      });
    } else {
      const secs = info.runtimeSecs ?? (Date.now() - Date.parse(startedAtIso)) / 1000;
      const cu = (memoryMb / 1024) * (secs / 3600);
      this.record('apify_browser_run', info.runId, cu, 'compute_units', cu * this.cfg.apify.cuPriceUsd, 'estimate', { runtimeSecs: secs, state: info.state });
    }
    if (info.residentialProxyGb) {
      this.record('apify_residential_proxy', info.runId, info.residentialProxyGb, 'GB', null, info.preliminary ? 'provider_preliminary' : 'provider_reconciled', {
        note: 'included in the run figure (usageTotalUsd); not added again',
      });
    }
  }

  monthTotals(month = monthKey()): Record<string, { quantity: number; usd: number; bases: string[] }> {
    const rows = this.db.all<{ kind: string; q: number; usd: number | null; bases: string }>(
      `SELECT kind, SUM(quantity) q, SUM(usd) usd, GROUP_CONCAT(DISTINCT basis) bases FROM usage WHERE month = ? GROUP BY kind`,
      month,
    );
    return Object.fromEntries(rows.map((r) => [r.kind, { quantity: r.q, usd: r.usd ?? 0, bases: r.bases.split(',') }]));
  }

  count(kind: string, month = monthKey()): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) n FROM usage WHERE month = ? AND kind = ?', month, kind)?.n ?? 0;
  }

  /** Throws concurrency_limit when RBA_MAX_CONCURRENT_SESSIONS active sessions exist (any mode). */
  assertConcurrency(): ActiveSession[] {
    const active = this.activeSessions();
    if (active.length >= this.cfg.limits.maxConcurrentSessions) {
      throw new RbaError('concurrency_limit', `max concurrent sessions (${this.cfg.limits.maxConcurrentSessions}) reached; close a session first`);
    }
    return active;
  }

  activeSessions(): ActiveSession[] {
    return this.db.all<ActiveSession>(`SELECT id, provider, proxy_mode, provider_run_id, memory_mb, max_minutes, created_at FROM sessions WHERE status IN ('starting', 'ready', 'closing')`);
  }

  /**
   * Whole-account usage for the current Apify billing cycle (includes builds,
   * other Actors and usage outside this plugin; lags behind running work).
   * Throws quota_exhausted at the account's own limit.
   */
  async providerAccount(): Promise<AccountUsage | null> {
    if (!this.provider) return null;
    try {
      const acct = await this.provider.accountUsage();
      if (acct.monthlyLimitUsd !== null && acct.monthlyUsageUsd !== null && acct.monthlyUsageUsd >= acct.monthlyLimitUsd) {
        throw new RbaError('quota_exhausted', 'Apify monthly usage limit reached; work is stopped until the next cycle (no paid upgrade is attempted)');
      }
      return acct.monthlyUsageUsd === null ? null : { usd: acct.monthlyUsageUsd, cycleStart: acct.cycleStart };
    } catch (e) {
      if (e instanceof RbaError && e.code === 'quota_exhausted') throw e;
      return null; // usage endpoint unavailable: local figures only
    }
  }

  /** Kept for callers that only need the account figure. */
  async providerMonthlyUsd(): Promise<number | null> {
    return (await this.providerAccount())?.usd ?? null;
  }

  /** Start of the current window: the provider's billing-cycle start when known, else the calendar month. */
  windowStart(cycleStart: string | null): string {
    if (cycleStart && !Number.isNaN(Date.parse(cycleStart))) return new Date(cycleStart).toISOString();
    return `${monthKey()}-01T00:00:00.000Z`;
  }

  /**
   * This plugin's Apify run spend since `sinceIso` (by run start), split by basis.
   * For budgeting, a preliminary run counts as the LARGER of the provider's
   * figure and a local estimate (runtime x memory x CU price), because early
   * figures were observed to be too low.
   */
  runSpend(sinceIso = this.windowStart(null)): {
    reconciledUsd: number;
    reconciledRuns: number;
    preliminaryReportedUsd: number;
    preliminaryCountedForBudgetUsd: number;
    preliminaryRuns: number;
    countedForBudgetUsd: number;
    lastReconciledAt: string | null;
  } {
    const rows = this.db.all<{ ref: string; usd: number | null; basis: UsageBasis; detail_json: string | null; memory_mb: number | null }>(
      `SELECT u.ref, u.usd, u.basis, u.detail_json, s.memory_mb FROM usage u LEFT JOIN sessions s ON s.provider_run_id = u.ref
       WHERE u.kind = 'apify_browser_run' AND COALESCE(s.created_at, u.ts) >= ?`,
      sinceIso,
    );
    const out = { reconciledUsd: 0, reconciledRuns: 0, preliminaryReportedUsd: 0, preliminaryCountedForBudgetUsd: 0, preliminaryRuns: 0, countedForBudgetUsd: 0, lastReconciledAt: null as string | null };
    for (const r of rows) {
      const usd = r.usd ?? 0;
      let d: { runtimeSecs?: number; reconciledAt?: string } = {};
      try {
        d = JSON.parse(r.detail_json ?? '{}');
      } catch {
        d = {};
      }
      if (r.basis === 'provider_reconciled') {
        out.reconciledUsd += usd;
        out.reconciledRuns++;
        if (d.reconciledAt && (!out.lastReconciledAt || d.reconciledAt > out.lastReconciledAt)) out.lastReconciledAt = d.reconciledAt;
        continue;
      }
      const secs = Number(d.runtimeSecs ?? 0) || 0;
      const est = ((r.memory_mb ?? this.cfg.apify.workerMemoryMb) / 1024) * (secs / 3600) * this.cfg.apify.cuPriceUsd;
      out.preliminaryReportedUsd += usd;
      out.preliminaryCountedForBudgetUsd += Math.max(usd, est);
      out.preliminaryRuns++;
    }
    out.countedForBudgetUsd = out.reconciledUsd + out.preliminaryCountedForBudgetUsd;
    return out;
  }

  /**
   * Budget + concurrency gate. SCOPE: RBA_MONTHLY_BUDGET_USD caps the WHOLE Apify
   * account for the current billing cycle (builds, other Actors and runs outside
   * this plugin count via the account figure), not only this plugin. Synchronous
   * so the caller can run it in the IMMEDIATE transaction that inserts the session
   * row. Projected = max(account figure, this plugin's runs since the cycle start)
   * + the remaining planning estimate of every active plugin session + this
   * session's planning estimate. Taking the max (not the sum) avoids counting
   * plugin runs twice: once the account figure includes them, it is the larger
   * term; until it catches up, the local records cover the lag.
   */
  assertBudget(memoryMb: number, minutes: number, proxyMode: string, account: AccountUsage | number | null): { projectedUsd: number; budgetUsd: number } {
    const acct: AccountUsage | null = typeof account === 'number' ? { usd: account, cycleStart: null } : account;
    // Local sessions count toward concurrency but have no provider bill.
    const active = this.assertConcurrency().filter((x) => x.provider !== 'local');
    const local = this.runSpend(this.windowStart(acct?.cycleStart ?? null)).countedForBudgetUsd;
    let reserved = 0;
    for (const s of active) {
      const spent = s.provider_run_id
        ? this.db.get<{ usd: number | null }>(`SELECT usd FROM usage WHERE kind = 'apify_browser_run' AND ref = ?`, s.provider_run_id)?.usd ?? 0
        : 0;
      reserved += Math.max(0, this.sessionEstimate(s.memory_mb, s.max_minutes, s.proxy_mode).totalUsd - spent);
    }
    const base = Math.max(local, acct?.usd ?? 0);
    const est = this.sessionEstimate(memoryMb, minutes, proxyMode);
    const projectedUsd = base + reserved + est.totalUsd;
    const budgetUsd = this.cfg.limits.monthlyBudgetUsd;
    if (projectedUsd > budgetUsd) {
      throw new RbaError(
        'budget_exceeded',
        `starting this session could exceed RBA_MONTHLY_BUDGET_USD (whole Apify account, current cycle): used ~$${base.toFixed(3)} + reserved for running sessions $${reserved.toFixed(3)} + this session's planning estimate $${est.totalUsd.toFixed(3)} (compute $${est.computeUsd.toFixed(3)}${est.residentialReserveUsd ? `, residential reserve $${est.residentialReserveUsd.toFixed(3)}` : ''}) > $${budgetUsd.toFixed(2)}. Close sessions, lower RBA_MAX_SESSION_MINUTES, or wait for the next cycle.`,
        { projectedUsd, budgetUsd },
      );
    }
    return { projectedUsd, budgetUsd };
  }

  async assertCanStart(memoryMb: number, minutes: number, proxyMode = 'direct'): Promise<{ projectedUsd: number; budgetUsd: number; providerReportedUsd: number | null }> {
    const account = await this.providerAccount();
    return { ...this.assertBudget(memoryMb, minutes, proxyMode, account), providerReportedUsd: account?.usd ?? null };
  }

  /**
   * Local MailSlurp quotas (RBA_MAILSLURP_MAX_*): a conservative LOCAL cap, set
   * below the provider's plan. The provider enforces its own limits separately
   * (HTTP 402/429 -> quota_exhausted with details.source = 'provider').
   *
   * Received email: counts UNIQUE messages by MailSlurp email id, the unit the
   * provider bills ("emails received"), not reads. Re-reading a counted message
   * never counts again and is always allowed. The local count is a lower bound
   * of provider usage: messages that arrive but are never listed by this plugin
   * are not seen.
   */
  admitEmail(emailId: string): void {
    this.db.tx(() => {
      const month = monthKey();
      if (this.db.get('SELECT 1 FROM usage WHERE provider = ? AND kind = ? AND ref = ?', 'mailslurp', 'mailslurp_email_received', emailId)) return;
      const n = this.count('mailslurp_email_received', month);
      if (n >= this.cfg.mailslurp.maxEmailsPerMonth) {
        throw new RbaError('quota_exhausted', `local received-email cap reached (${n}/${this.cfg.mailslurp.maxEmailsPerMonth}, RBA_MAILSLURP_MAX_EMAILS_PER_MONTH); new messages are not read this month`, { source: 'local', variable: 'RBA_MAILSLURP_MAX_EMAILS_PER_MONTH' });
      }
      this.record('mailslurp_email_received', emailId, 1, 'email', null, 'counted');
    });
  }

  /** Provider-side tag that links an inbox to its reservation (for crash recovery). */
  static reservationTag(reservation: string): string {
    return `rba-res-${reservation.replace(/^reserved:/, '')}`;
  }

  /**
   * Reserve one inbox creation atomically before calling the provider. Returns the
   * reservation ref; pass `Usage.reservationTag(ref)` as a tag of the new inbox.
   */
  reserveInbox(): string {
    return this.db.tx(() => {
      const n = this.count('mailslurp_inbox_created');
      if (n >= this.cfg.mailslurp.maxInboxesPerMonth) {
        throw new RbaError('quota_exhausted', `local inbox-creation cap reached (${n}/${this.cfg.mailslurp.maxInboxesPerMonth}, RBA_MAILSLURP_MAX_INBOXES_PER_MONTH)`, { source: 'local', variable: 'RBA_MAILSLURP_MAX_INBOXES_PER_MONTH' });
      }
      const ref = `reserved:${randomUUID()}`;
      this.record('mailslurp_inbox_created', ref, 1, 'inbox', null, 'counted', { reserved: true });
      return ref;
    });
  }

  /** Turn a reservation into the created inbox's id (or drop it if creation failed). */
  settleInbox(reservation: string, inboxId: string | null): void {
    if (inboxId) this.db.run(`UPDATE usage SET ref = ?, detail_json = NULL WHERE kind = 'mailslurp_inbox_created' AND ref = ?`, inboxId, reservation);
    else this.db.run(`DELETE FROM usage WHERE kind = 'mailslurp_inbox_created' AND ref = ?`, reservation);
  }

  /**
   * Recover inbox reservations left by a process that died mid-creation. For each
   * stale reservation the provider is asked for an inbox carrying its tag:
   *  - found: the inbox was created but never recorded -> it is deleted at the
   *    provider, and the slot stays counted (the provider counted the creation);
   *  - not found: the creation never happened -> the slot is released;
   *  - provider unreachable / no client: the reservation is kept for the next sweep.
   * Never releases a slot while a provider-side inbox might exist.
   */
  async recoverInboxReservations(
    mail: { findInboxesByTag(tag: string): Promise<Array<{ id: string }>>; deleteInbox(id: string): Promise<void> } | null,
    maxAgeMs = 10 * 60_000,
  ): Promise<{ released: number; orphansDeleted: number; orphansKept: number; deferred: number }> {
    const out = { released: 0, orphansDeleted: 0, orphansKept: 0, deferred: 0 };
    const stale = this.db.all<{ ref: string }>(
      `SELECT ref FROM usage WHERE kind = 'mailslurp_inbox_created' AND ref LIKE 'reserved:%' AND ts < ?`,
      new Date(Date.now() - maxAgeMs).toISOString(),
    );
    for (const { ref } of stale) {
      if (!mail) {
        out.deferred++;
        continue;
      }
      let found: Array<{ id: string }>;
      try {
        found = await mail.findInboxesByTag(Usage.reservationTag(ref));
      } catch {
        out.deferred++;
        continue;
      }
      if (found.length === 0) {
        this.settleInbox(ref, null);
        out.released++;
        continue;
      }
      for (const [i, inbox] of found.entries()) {
        let deleted = false;
        try {
          await mail.deleteInbox(inbox.id);
          deleted = true;
        } catch {
          deleted = false;
        }
        if (i === 0) {
          this.db.run(
            `UPDATE usage SET ref = ?, detail_json = ? WHERE kind = 'mailslurp_inbox_created' AND ref = ?`,
            inbox.id,
            JSON.stringify({ orphanRecovered: true, providerInboxDeleted: deleted, recoveredAt: nowIso() }),
            ref,
          );
        }
        if (deleted) out.orphansDeleted++;
        else out.orphansKept++;
      }
    }
    return out;
  }

  /** Read-only check (no reservation), e.g. before spending browser budget on a signup. */
  assertInboxQuota(): void {
    const n = this.count('mailslurp_inbox_created');
    if (n >= this.cfg.mailslurp.maxInboxesPerMonth) {
      throw new RbaError('quota_exhausted', `local inbox-creation cap reached (${n}/${this.cfg.mailslurp.maxInboxesPerMonth}, RBA_MAILSLURP_MAX_INBOXES_PER_MONTH)`, { source: 'local', variable: 'RBA_MAILSLURP_MAX_INBOXES_PER_MONTH' });
    }
  }

  /**
   * Re-read provider figures: every preliminary/estimated run, plus reconciled
   * runs of the current window whose last reconciliation is older than
   * RECHECK_MS (Apify can still change them). Bounded per call.
   */
  async reconcile(sinceIso = this.windowStart(null)): Promise<{ reread: number; changed: number }> {
    if (!this.provider) return { reread: 0, changed: 0 };
    const rows = this.db.all<{ ref: string; usd: number | null; basis: string; detail_json: string | null }>(
      `SELECT u.ref, u.usd, u.basis, u.detail_json FROM usage u LEFT JOIN sessions s ON s.provider_run_id = u.ref
       WHERE u.kind = 'apify_browser_run' AND COALESCE(s.created_at, u.ts) >= ?`,
      sinceIso,
    );
    const due = rows.filter((r) => {
      if (r.basis !== 'provider_reconciled') return true;
      try {
        const at = (JSON.parse(r.detail_json ?? '{}') as { reconciledAt?: string }).reconciledAt;
        return !at || Date.now() - Date.parse(at) > RECHECK_MS;
      } catch {
        return true;
      }
    });
    let reread = 0;
    let changed = 0;
    for (const r of due.slice(0, MAX_RECONCILE_PER_CALL)) {
      const s = this.db.get<{ memory_mb: number; created_at: string }>('SELECT memory_mb, created_at FROM sessions WHERE provider_run_id = ?', r.ref);
      if (!s) continue;
      try {
        const info = await this.provider.getRun(r.ref);
        this.recordRun(info, s.memory_mb, s.created_at);
        reread++;
        if (info.usageUsd !== null && Math.abs((r.usd ?? 0) - info.usageUsd) > 1e-9) changed++;
      } catch {
        /* keep previous figure */
      }
    }
    return { reread, changed };
  }

  /** @deprecated name kept for callers; same as reconcile(). */
  async refreshPreliminary(): Promise<number> {
    return (await this.reconcile()).reread;
  }

  async report(): Promise<Record<string, unknown>> {
    let account: AccountUsage | null = null;
    let provider: unknown = 'unavailable';
    if (this.provider) {
      try {
        const a = await this.provider.accountUsage();
        provider = a;
        account = a.monthlyUsageUsd === null ? null : { usd: a.monthlyUsageUsd, cycleStart: a.cycleStart };
      } catch (e) {
        provider = `unavailable: ${(e as Error).message}`;
      }
    }
    const since = this.windowStart(account?.cycleStart ?? null);
    const rec = await this.reconcile(since);
    const spend = this.runSpend(since);
    const direct = this.sessionEstimate(this.cfg.apify.workerMemoryMb, this.cfg.limits.maxSessionMinutes, 'direct');
    const resi = this.sessionEstimate(this.cfg.apify.workerMemoryMb, this.cfg.limits.maxSessionMinutes, 'residential');
    return {
      window: { since, basis: account?.cycleStart ? 'Apify billing cycle' : 'calendar month (UTC)' },
      pluginApifyRuns: { ...spend, rereadNow: rec.reread, changedOnReread: rec.changed },
      apifyAccountReported: provider,
      budget: {
        monthlyBudgetUsd: this.cfg.limits.monthlyBudgetUsd,
        scope: 'whole Apify account, current billing cycle',
        usedForGateUsd: Math.max(spend.countedForBudgetUsd, account?.usd ?? 0),
        notPluginUsd: account ? Math.max(0, account.usd - spend.countedForBudgetUsd) : null,
      },
      sessionPlanningEstimate: {
        cuPriceUsd: this.cfg.apify.cuPriceUsd,
        memoryMb: this.cfg.apify.workerMemoryMb,
        maxSessionMinutes: this.cfg.limits.maxSessionMinutes,
        directOrDatacenter: direct,
        residential: resi,
      },
      totals: this.monthTotals(),
      limits: {
        maxConcurrentSessions: this.cfg.limits.maxConcurrentSessions,
        mailslurpInboxesPerMonth: this.cfg.mailslurp.maxInboxesPerMonth,
        mailslurpEmailsPerMonth: this.cfg.mailslurp.maxEmailsPerMonth,
      },
      activeSessions: this.activeSessions().length,
      notes: [
        "'provider_preliminary': Apify's figure while a run is active or <10 min after it ended; observed to rise later.",
        "'provider_reconciled': Apify's figure last re-read >=10 min after the run ended (see reconciledAt). Not a final bill: reconciled runs of this cycle are re-read every 6 h and changes are kept in detail.history.",
        'Budget scope is the whole Apify account (builds, other Actors included via the account figure). notPluginUsd = account figure minus this plugin\'s tracked runs (builds, test fixtures, other Actors, provider lag).',
        `Session planning estimate: compute at $${this.cfg.apify.cuPriceUsd}/CU for the run timeout (minutes + 1) is bounded; the residential reserve is a reservation enforced by a 60 s sweep on Apify\'s lagging figure, not a hard cap; data transfer and storage operations are not capped.`,
        'Residential proxy charges are included in each run\'s figure (apify_residential_proxy rows record GB only).',
        'MailSlurp figures are local counts of API events; MailSlurp does not expose spend via this integration.',
      ],
    };
  }
}
