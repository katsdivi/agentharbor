/**
 * Scenario E2: ambiguous SIGNUP submission -> outcome_unknown -> never submitted twice,
 * including a real orchestrator crash (SIGKILL of the MCP server process) and restart.
 * Proof level: local fixture (fixture site's server-side `signupSubmissions` counter,
 * fake MailSlurp, fake Apify).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveFakeRuns, reportKnownDefects, startE2E, waitFor, type E2E } from './stdio-harness.js';

const signup = (h: E2E, extra: Record<string, unknown> = {}) => ({
  mode: 'remote_direct',
  targetOrigin: h.site.origin,
  signupUrl: h.site.url('/signup'),
  fields: [
    { selector: '#email', value: { secret: 'email' } },
    { selector: '#password', value: { secret: 'password' } },
    { selector: '#name', value: 'E2E Ambiguous' },
  ],
  submitSelector: '#submit',
  successText: 'Check your email',
  rejectionTexts: ['Email domain not allowed'],
  synthetic: true,
  verification: { linkContains: '/verify', timeoutSecs: 5, successText: 'Logged in as' },
  waitSecs: 0,
  ...extra,
});

describe('E2: ambiguous signup is never submitted twice', () => {
  let h: E2E;
  beforeAll(async () => {
    h = await startE2E({ autoVerifyEmail: false, vars: { RBA_MAX_CONCURRENT_SESSIONS: '3' } });
  });
  afterAll(async () => {
    reportKnownDefects('e2-signup-recovery');
    await h?.close();
  });

  const status = async (jobId: string) => (await h.call('job_status', { jobId })).data;

  it('no verification email arrives: outcome_unknown, not safe to retry; the same idempotencyKey joins the same job (one inbox, one submission)', async () => {
    const subs = h.site.state.signupSubmissions;
    const inboxes = h.mail.state.createdInboxes;
    const args = signup(h, { idempotencyKey: 'e2e-signup-key-0001' });
    const [a, b] = await Promise.all([h.call('account_register', args), h.call('account_register', args)]);
    expect(a.isError, a.raw).toBe(false);
    expect(a.data.jobId).toBe(b.data.jobId);
    expect([a.data.deduplicated, b.data.deduplicated].filter(Boolean)).toHaveLength(1);
    const done = await h.untilDone(a.data.jobId, 60).catch(async (e) => { throw new Error(e.message + " " + JSON.stringify(await status(a.data.jobId)).slice(0, 2500)); });
    expect(done.status, JSON.stringify(done)).toBe('outcome_unknown');
    expect(done.outcome).toBe('outcome_unknown');
    expect(done.safeToRetry.safe).toBe(false);
    expect(done.error).toMatch(/do not resubmit/);
    const after = await h.call('account_register', args);
    expect(after.data).toMatchObject({ jobId: a.data.jobId, deduplicated: true });
    expect(h.site.state.signupSubmissions - subs).toBe(1);
    expect(h.mail.state.createdInboxes - inboxes).toBe(1);
    expect(h.q<{ status: string }>('SELECT status FROM jobs WHERE id = ?', a.data.jobId)[0]!.status).toBe('outcome_unknown');
  });

  it('the MCP server is killed after the submit: on restart the job is outcome_unknown, the orphaned run is stopped, and a resume checks the inbox without resubmitting', async () => {
    const subs = h.site.state.signupSubmissions;
    const r = await h.call('account_register', signup(h, { verification: { linkContains: '/verify', timeoutSecs: 60, successText: 'Logged in as' } }));
    expect(r.isError, r.raw).toBe(false);
    const jobId = r.data.jobId;
    expect(await waitFor(() => h.site.state.signupSubmissions - subs === 1, 60_000)).toBe(true);
    let st: any;
    for (let i = 0; i < 120; i++) {
      st = await status(jobId);
      if (st.status === 'awaiting_email') break;
      await new Promise((x) => setTimeout(x, 250));
    }
    expect(st.status).toBe('awaiting_email');
    const accountId = st.accountId;
    const runId = h.q<{ provider_run_id: string }>('SELECT provider_run_id FROM sessions WHERE id = ?', st.sessionId)[0]!.provider_run_id;

    // Crash: no shutdown handler runs, so the remote run is left behind.
    await h.killServer();
    expect(h.apify!.runs.get(runId)!.status).toBe('RUNNING');

    await h.restartServer();
    const rec = await h.untilDone(jobId, 60);
    expect(rec.status, JSON.stringify(rec)).toBe('outcome_unknown');
    expect(rec.outcome).toBe('outcome_unknown');
    expect(rec.safeToRetry.safe).toBe(false);
    expect(String(rec.error)).toMatch(/interrupted/);
    // Recovery stops the orphaned run and frees the lease.
    expect(await waitFor(() => h.apify!.runs.get(runId)!.status !== 'RUNNING', 90_000, 500)).toBe(true);
    expect(await waitFor(() => h.q('SELECT * FROM leases WHERE account_id = ?', accountId).length === 0, 30_000)).toBe(true);
    expect(h.q<{ status: string }>('SELECT status FROM accounts WHERE id = ?', accountId)[0]!.status).not.toBe('active');

    // The email arrives late; resuming on the same account checks the inbox and never resubmits.
    const email = h.q<{ email: string }>('SELECT email FROM accounts WHERE id = ?', accountId)[0]!.email;
    const token = h.site.state.tokens.get(email);
    h.mail.deliver(email, { from: 'no-reply@127.0.0.1', subject: 'Verify', body: `<a href="${h.site.origin}/verify?token=${token}">Verify</a>` });
    const r2 = await h.call('account_register', signup(h, { accountId, verification: { linkContains: '/verify', timeoutSecs: 20, successText: 'Logged in as' } }));
    expect(r2.isError, r2.raw).toBe(false);
    const d2 = await h.untilDone(r2.data.jobId);
    expect(d2.status, JSON.stringify(d2)).toBe('completed');
    expect(d2.outcome).toBe('confirmed');
    expect(h.site.state.signupSubmissions - subs).toBe(1);
    expect(h.q<{ status: string }>('SELECT status FROM accounts WHERE id = ?', accountId)[0]!.status).toBe('active');
  }, 300_000);

  it('teardown: no orphaned workers', async () => {
    expect(await h.stopServer()).toBe(0);
    expect(await waitFor(() => liveFakeRuns(h.apify).length === 0, 15_000)).toBe(true);
    expect(h.q(`SELECT id FROM sessions WHERE status IN ('starting','ready','closing')`)).toEqual([]);
    for (const s of h.secrets) expect(h.stderr()).not.toContain(s);
  });
});
