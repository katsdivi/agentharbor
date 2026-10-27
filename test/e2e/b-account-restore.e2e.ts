/**
 * Scenario B: account workflow -> restored session in a NEW worker -> result -> cleanup.
 * Proof level: local fixture (fixture site + fake MailSlurp; remote_direct via the
 * fake Apify, local via the real LocalProvider). Not evidence for any live site.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alive, leftoverLocalRuns, liveFakeRuns, navigate, reportKnownDefects, startE2E, waitFor, type E2E } from './stdio-harness.js';

const signup = (h: E2E, mode: string) => ({
  mode,
  targetOrigin: h.site.origin,
  signupUrl: h.site.url('/signup'),
  fields: [
    { selector: '#email', value: { secret: 'email' } },
    { selector: '#password', value: { secret: 'password' } },
    { selector: '#name', value: 'E2E Persona' },
  ],
  submitSelector: '#submit',
  successText: 'Check your email',
  rejectionTexts: ['Email domain not allowed'],
  synthetic: true,
  verification: { linkContains: '/verify', timeoutSecs: 15, successText: 'Logged in as' },
  waitSecs: 90,
});

describe('B: account workflow -> restore in a new worker -> result -> cleanup', () => {
  let h: E2E;
  beforeAll(async () => {
    h = await startE2E();
  });
  afterAll(async () => {
    reportKnownDefects('b-account-restore');
    await h?.close();
  });

  for (const mode of ['remote_direct', 'local'] as const) {
    it(`${mode}: register + verify, then restore the saved login without filling any field`, async () => {
      const subsBefore = h.site.state.signupSubmissions;
      const r = await h.call('account_register', signup(h, mode));
      expect(r.isError, r.raw).toBe(false);
      const job = ['completed', 'failed'].includes(r.data.status) ? r.data : await h.untilDone(r.data.jobId);
      expect(job.status, JSON.stringify(job)).toBe('completed');
      const accountId = job.result.accountId;
      expect(h.site.state.signupSubmissions - subsBefore).toBe(1);

      const acct = h.q<{ status: string; verified_at: string | null; state_blob: string | null; execution_mode: string; email: string; password_blob?: string }>('SELECT * FROM accounts WHERE id = ?', accountId)[0]!;
      expect(acct.status).toBe('active');
      expect(acct.verified_at).toBeTruthy();
      expect(acct.state_blob).toBeTruthy();
      expect(acct.execution_mode).toBe(mode);
      // The registration session is closed and its worker is gone.
      const regSessions = h.q<{ id: string; provider_run_id: string; status: string }>('SELECT id, provider_run_id, status FROM sessions WHERE account_id = ?', accountId);
      expect(regSessions.length).toBeGreaterThan(0);
      for (const s of regSessions) expect(s.status).toBe('closed');

      // Restore: a new session, a new worker run, no fill/click.
      const hitsBefore = h.site.state.requests.length;
      const s = await h.call('session_start', { accountId });
      expect(s.isError, s.raw).toBe(false);
      expect(s.data.restoredBrowserState).toBe(true);
      expect(s.data.executionMode ?? s.data.route?.mode).toBe(mode);
      const row = h.q<{ provider: string; provider_run_id: string }>('SELECT provider, provider_run_id FROM sessions WHERE id = ?', s.data.sessionId)[0]!;
      expect(regSessions.map((x) => x.provider_run_id)).not.toContain(row.provider_run_id);
      expect(row.provider === 'local').toBe(mode === 'local');

      const nav = await navigate(h, s.data.sessionId, h.site.url('/account'));
      expect(nav.isError, nav.raw).toBe(false);
      expect(nav.data.page.url).toContain('/account');
      const ins = await h.call('browser_inspect', { sessionId: s.data.sessionId });
      expect(ins.data.untrusted.text).toContain(`Logged in as ${acct.email}`);
      // Restored, not re-logged-in: the site saw no login or signup POST in this session.
      expect(h.site.state.requests.slice(hitsBefore).filter((x) => x.startsWith('POST '))).toEqual([]);

      // A second session for the same account is refused while leased.
      const other = await h.call('session_start', { accountId });
      expect(other.data.error?.code).toBe('lease_conflict');

      const c = await h.call('session_close', { sessionId: s.data.sessionId, saveState: true });
      expect(c.data.status).toBe('closed');
      expect(h.q('SELECT * FROM leases WHERE account_id = ?', accountId)).toEqual([]);
      if (mode === 'local') {
        const pid = Number(row.provider_run_id.split(':')[1]);
        expect(await waitFor(() => !alive(pid), 15_000)).toBe(true);
      } else {
        expect(await waitFor(() => liveFakeRuns(h.apify).length === 0, 15_000)).toBe(true);
      }

      // The bound route is enforced (lease free now): switching modes is refused, never silently applied.
      const sessionsBefore = h.q('SELECT id FROM sessions').length;
      const switched = await h.call('session_start', { accountId, mode: mode === 'local' ? 'remote_direct' : 'local' });
      expect(switched.isError).toBe(true);
      expect(switched.data.error.code).toBe('invalid_input');
      expect(switched.data.error.message).toMatch(/bound to execution mode/);
      expect(h.q('SELECT id FROM sessions').length).toBe(sessionsBefore);

      // Cleanup: local record, encrypted state and inbox removed; the website account is NOT claimed deleted.
      const d = await h.call('account_delete', { accountId, confirmAccountId: accountId, deleteInbox: true });
      expect(d.isError, d.raw).toBe(false);
      expect(JSON.stringify(d.data)).toMatch(/still exists|not_deleted/);
      expect(h.q('SELECT id FROM accounts WHERE id = ?', accountId)).toEqual([]);
    });
  }

  it('bound-mode refusal is checked before any worker starts', async () => {
    const runs = h.apify!.state.runStarts;
    const r = await h.call('account_register', { ...signup(h, 'remote_direct'), proxyMode: 'residential' });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('invalid_input');
    expect(h.apify!.state.runStarts).toBe(runs);
  });

  it('teardown: no orphaned workers, no active sessions or leases, no secrets in server output', async () => {
    expect(await h.stopServer()).toBe(0);
    expect(liveFakeRuns(h.apify)).toEqual([]);
    expect(leftoverLocalRuns(h.dataDir)).toEqual([]);
    expect(h.q(`SELECT id FROM sessions WHERE status IN ('starting','ready','closing')`)).toEqual([]);
    expect(h.q('SELECT * FROM leases')).toEqual([]);
    for (const s of h.secrets) expect(h.stderr()).not.toContain(s);
  });
});
