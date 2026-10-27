/**
 * W2 failure cases end to end (fake Apify, fixture site, fake MailSlurp; no live runs).
 * Faults are injected with wrappers defined here: a fetch wrapper between the
 * orchestrator and the worker, and wrapped provider methods.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCrawlRequest } from '../../src/core/crawl.js';
import { isTerminal } from '../../src/core/jobs.js';
import { drainCleanup, recoverJobs } from '../../src/core/recovery.js';
import { HAVE_FFMPEG, makePng } from '../fixtures/media.js';
import { startHarness, type Harness } from '../helpers/harness.js';

async function untilDone(h: Harness, jobId: string) {
  for (let i = 0; i < 120; i++) {
    const j = await h.call('job_status', { jobId, waitSecs: 1 });
    if (isTerminal(j.data.status)) return j.data;
  }
  throw new Error('job did not finish');
}

async function until(fn: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('condition not reached');
}

const route = (url: string) => new URL(url).pathname;

/** Fetch wrapper between the orchestrator and the worker. */
function faultyFetch(rules: { [path: string]: 'fail_before' | 'drop_after' }) {
  const hits: string[] = [];
  let dropped = false;
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const p = route(String(input));
    hits.push(p);
    const rule = rules[p];
    if (dropped && (p === '/extract' || p === '/inspect')) throw new TypeError('fetch failed (simulated: connection lost)');
    if (rule === 'fail_before') {
      delete rules[p];
      throw new TypeError('fetch failed (simulated: worker died)');
    }
    const res = await fetch(input, init);
    if (rule === 'drop_after') {
      delete rules[p];
      await res.arrayBuffer(); // the worker DID run the command
      dropped = true;
      throw new TypeError('fetch failed (simulated: connection dropped before the answer)');
    }
    return res;
  }) as typeof fetch;
  return { f, hits };
}

describe.skipIf(!HAVE_FFMPEG)('portal_upload failure cases', () => {
  let h: Harness;
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rba-recovery-'));
    h = await startHarness({ vars: { RBA_IMPORT_ROOTS: root } });
  });
  afterAll(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (artifactId: string, extra: Record<string, unknown> = {}) =>
    h.call('portal_upload', { artifactId, targetUrl: h.site.url('/upload'), mode: 'remote_direct', fileInputSelector: '#file', submitSelector: '#upload-submit', confirmation: { selector: '#upload-result' }, waitSecs: 0, ...extra });

  it('worker dies before submit: failed, nothing sent, safe to retry (and the retry is allowed)', async () => {
    const imp = await h.call('file_import', { path: makePng(root, '30x10') });
    const before = h.site.state.uploads.length;
    const ff = faultyFetch({ '/navigate': 'fail_before' });
    h.ctx.sessions.fetchImpl = ff.f;
    const done = await untilDone(h, (await upload(imp.data.artifactId)).data.jobId);
    h.ctx.sessions.fetchImpl = fetch;
    expect(done.status, JSON.stringify(done)).toBe('failed');
    expect(done.outcome).toBe('not_sent');
    expect(done.submittedAt).toBeNull();
    expect(done.safeToRetry.safe).toBe(true);
    expect(done.error).toMatch(/worker unreachable/);
    expect(h.site.state.uploads.length).toBe(before);
    const retry = await untilDone(h, (await upload(imp.data.artifactId)).data.jobId);
    expect(retry.status, JSON.stringify(retry)).toBe('completed');
    expect(retry.outcome).toBe('confirmed');
    expect(retry.steps.map((s: any) => s.step)).toEqual(expect.arrayContaining(['session_ready', 'file_transferred', 'file_selected', 'form_submitted', 'confirmation_observed']));
  });

  it('connection drops after submit, before the confirmation: outcome_unknown, evidence kept, never repeated', async () => {
    const imp = await h.call('file_import', { path: makePng(root, '32x10') });
    const before = h.site.state.uploads.length;
    const ff = faultyFetch({ '/click': 'drop_after' });
    h.ctx.sessions.fetchImpl = ff.f;
    const done = await untilDone(h, (await upload(imp.data.artifactId)).data.jobId);
    h.ctx.sessions.fetchImpl = fetch;
    expect(done.status, JSON.stringify(done)).toBe('outcome_unknown');
    expect(done.outcome).toBe('outcome_unknown');
    expect(done.sideEffectsPossible).toBe(true);
    expect(done.safeToRetry.safe).toBe(false);
    expect(done.nextAction).toMatch(/Check the portal/);
    expect(h.site.state.uploads.length).toBe(before + 1); // the portal did receive it
    const sub = done.steps.filter((s: any) => s.step === 'form_submitted').pop();
    expect(sub.status).toBe('failed');
    expect(sub.evidence.error).toMatch(/connection dropped/);
    const conf = done.steps.find((s: any) => s.step === 'confirmation_missing');
    expect(conf.evidence.readError).toBeTruthy();
    expect(done.result.outcome).toBe('outcome_unknown');
    // never repeated automatically, and a manual repeat is refused
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.site.state.uploads.length).toBe(before + 1);
    const again = await upload(imp.data.artifactId);
    expect(again.data.error.code).toBe('conflict');
  });

  it('cancel races the submit: cancelled, but the result says the file may have been received', async () => {
    const imp = await h.call('file_import', { path: makePng(root, '34x10') });
    const r = await upload(imp.data.artifactId, { targetUrl: h.site.url('/upload-slow'), submitTimeoutSecs: 30 });
    const jobId = r.data.jobId;
    await until(async () => (await h.call('job_status', { jobId })).data.steps.some((s: any) => s.step === 'form_submitted'));
    const c = await h.call('job_cancel', { jobId });
    const done = c.data.terminal ? c.data : await untilDone(h, jobId);
    expect(done.status).toBe('cancelled');
    expect(done.outcome).toBe('outcome_unknown');
    expect(done.sideEffectsPossible).toBe(true);
    expect(done.error).toMatch(/may have taken effect/);
    expect(c.data.cancel.sideEffectsPossible).toBe(true);
    const again = await h.call('portal_upload', { artifactId: imp.data.artifactId, targetUrl: h.site.url('/upload-slow'), mode: 'remote_direct', fileInputSelector: '#file', submitSelector: '#upload-submit' });
    expect(again.data.error.code).toBe('conflict');
    await until(() => h.ctx.files.row(imp.data.artifactId).locked_by === null);
  }, 90_000);
});

const signupArgs = (h: Harness, extra: Record<string, unknown> = {}) => ({
  targetOrigin: h.site.origin,
  signupUrl: h.site.url('/signup'),
  fields: [
    { selector: '#email', value: { secret: 'email' } },
    { selector: '#password', value: { secret: 'password' } },
    { selector: '#name', value: 'Recovery Persona' },
  ],
  submitSelector: '#submit',
  successText: 'Check your email',
  synthetic: true,
  verification: { linkContains: '/verify', timeoutSecs: 20, successText: 'Logged in as' },
  waitSecs: 0,
  ...extra,
});

describe('signup and session failure cases', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ autoVerifyEmail: false });
  });
  afterAll(() => h.close());

  const awaitEmailStep = async (jobId: string) => until(async () => (await h.call('job_status', { jobId })).data.status === 'awaiting_email');

  it('the session expires while waiting for the email: outcome_unknown, resume advice, lease freed, no resubmit', async () => {
    const before = h.site.state.signupSubmissions;
    const r = await h.call('account_register', signupArgs(h));
    const jobId = r.data.jobId;
    await awaitEmailStep(jobId);
    const st = (await h.call('job_status', { jobId })).data;
    const sess = h.ctx.sessions.row(st.sessionId);
    h.apify.crash(sess.provider_run_id!);
    const email = h.ctx.accounts.row(st.accountId).email!;
    const token = h.site.state.tokens.get(email);
    h.mail.deliver(email, { from: 'no-reply@127.0.0.1', subject: 'Verify', body: `<a href="${h.site.origin}/verify?token=${token}">Verify</a>` });
    const done = await untilDone(h, jobId);
    expect(done.status, JSON.stringify(done)).toBe('outcome_unknown');
    expect(done.nextAction).toMatch(new RegExp(`accountId=${st.accountId}`));
    expect(h.ctx.accounts.row(st.accountId).status).not.toBe('active');
    expect(h.site.state.signupSubmissions - before).toBe(1);
    await until(() => h.ctx.accounts.leaseFor(st.accountId) === undefined);
    // resuming on the same account checks the inbox and never resubmits
    const r2 = await h.call('account_register', signupArgs(h, { accountId: st.accountId }));
    const d2 = await untilDone(h, r2.data.jobId);
    expect(d2.status, JSON.stringify(d2)).toBe('completed');
    expect(d2.outcome).toBe('confirmed');
    expect(h.site.state.signupSubmissions - before).toBe(1);
    expect(h.ctx.accounts.row(st.accountId).status).toBe('active');
  }, 90_000);

  it('email verification times out: outcome_unknown with the wait recorded as evidence', async () => {
    const r = await h.call('account_register', signupArgs(h, { verification: { linkContains: '/verify', timeoutSecs: 5 } }));
    const done = await untilDone(h, r.data.jobId);
    expect(done.status).toBe('outcome_unknown');
    const wait = done.steps.filter((s: any) => s.step === 'verification_pending').pop();
    expect(wait).toMatchObject({ status: 'failed', evidence: { timedOutAfterSecs: 5 } });
    expect(done.error).toMatch(/do not resubmit/);
  });

  it('a followed verification link without a confirmation text is completed_unconfirmed, never active', async () => {
    const r = await h.call('account_register', signupArgs(h, { verification: { linkContains: '/verify', timeoutSecs: 20 } }));
    await awaitEmailStep(r.data.jobId);
    const acctId = (await h.call('job_status', { jobId: r.data.jobId })).data.accountId;
    const email = h.ctx.accounts.row(acctId).email!;
    h.mail.deliver(email, { from: 'no-reply@127.0.0.1', subject: 'Verify', body: `<a href="${h.site.origin}/verify?token=${h.site.state.tokens.get(email)}">Verify</a>` });
    const done = await untilDone(h, r.data.jobId);
    expect(done.status).toBe('completed_unconfirmed');
    expect(done.outcome).toBe('submitted_unconfirmed');
    expect(h.ctx.accounts.row(acctId).status).toBe('awaiting_verification');
  });

  it('duplicate invocation with the same idempotencyKey: one job, one inbox, one submission', async () => {
    const inboxes = h.mail.state.createdInboxes;
    const subs = h.site.state.signupSubmissions;
    const args = signupArgs(h, { idempotencyKey: 'dup-test-key-0001', verification: { timeoutSecs: 5 } });
    const [a, b] = await Promise.all([h.call('account_register', args), h.call('account_register', args)]);
    expect(a.data.jobId).toBe(b.data.jobId);
    expect([a.data.deduplicated, b.data.deduplicated].filter(Boolean)).toHaveLength(1);
    await untilDone(h, a.data.jobId);
    const c = await h.call('account_register', args); // after it ended, still the same job
    expect(c.data).toMatchObject({ jobId: a.data.jobId, deduplicated: true });
    expect(h.mail.state.createdInboxes - inboxes).toBe(1);
    expect(h.site.state.signupSubmissions - subs).toBe(1);
  });

  it('provider cleanup temporarily fails: pending cleanup is reported, retried, then the run stops and the lease is freed', async () => {
    const acct = h.ctx.accounts.create({ targetOrigin: h.site.origin, proxyMode: 'direct', status: 'active' });
    // /shutdown would end the worker on its own; drop it so only the provider abort can stop the run
    h.ctx.sessions.fetchImpl = faultyFetch({ '/shutdown': 'fail_before' }).f;
    const s = await h.call('session_start', { accountId: acct.id });
    const sid = s.data.sessionId;
    const provider = h.ctx.providers.remote!;
    const realAbort = provider.abortRun.bind(provider);
    let failures = 2;
    (provider as { abortRun: (id: string) => Promise<void> }).abortRun = async (id: string) => {
      if (failures-- > 0) throw new Error('Apify API 503 (simulated)');
      return realAbort(id);
    };
    try {
      const closed = await h.call('session_close', { sessionId: sid });
      expect(closed.data.status).toBe('closing');
      expect(h.ctx.accounts.leaseFor(acct.id)).toBeTruthy(); // kept until the stop is confirmed
      const run = h.ctx.sessions.row(sid).provider_run_id!;
      const pend = await drainCleanup(h.ctx, { force: true });
      expect(pend).toMatchObject({ done: 0, failed: 1, pending: 1 });
      const d = await drainCleanup(h.ctx, { force: true });
      expect(d.done).toBe(1);
      expect(h.apify.runs.get(run)!.status).toBe('ABORTED');
      expect(h.ctx.sessions.row(sid).status).toBe('closed');
      expect(h.ctx.accounts.leaseFor(acct.id)).toBeUndefined();
    } finally {
      (provider as { abortRun: (id: string) => Promise<void> }).abortRun = realAbort;
      h.ctx.sessions.fetchImpl = fetch;
    }
  });

  it('persisted step evidence holds no secrets (passwords, verification tokens)', async () => {
    const evidence = h.ctx.db.all<{ evidence_json: string | null }>('SELECT evidence_json FROM job_steps').map((r) => r.evidence_json ?? '').join('\n');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence).not.toMatch(/token=[A-Za-z0-9]/);
    for (const a of h.ctx.db.all<{ id: string }>('SELECT id FROM accounts WHERE credential_blob IS NOT NULL')) {
      const pw = h.ctx.accounts.getCredentials(a.id)?.password;
      if (pw) expect(evidence).not.toContain(pw);
    }
    for (const t of h.site.state.tokens.values()) expect(evidence).not.toContain(t);
  });

  it('after a restart, a re-attached crawl is cancellable with job_cancel', async () => {
    const s = await h.call('session_start', {});
    const sid = s.data.sessionId;
    const p = { startUrls: [h.site.url('/page/1')], maxPages: 50, maxDepth: 5, delayMs: 2000 };
    await h.ctx.sessions.call(sid, '/crawl/start', buildCrawlRequest(h.ctx, p));
    // the job of a process that died while the remote crawl kept running
    const jobId = h.ctx.jobs.create('crawl', p);
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    h.ctx.db.run(`UPDATE jobs SET status = 'running', session_id = ?, owner_pid = ?, owner_instance = ?, heartbeat_at = ? WHERE id = ?`, sid, dead, `${dead}:0000deadbeef`, Date.now() - 3600_000, jobId);
    expect(await recoverJobs(h.ctx)).toContain(jobId);
    expect((await h.call('job_status', { jobId })).data.status).toBe('running');
    await new Promise((r) => setTimeout(r, 1500));
    const c = await h.call('job_cancel', { jobId });
    const done = c.data.terminal ? c.data : await untilDone(h, jobId);
    expect(done.status, JSON.stringify({ error: done.error, events: done.events })).toBe('cancelled');
    await until(() => h.ctx.sessions.row(sid).status === 'closed');
  }, 60_000);
});
