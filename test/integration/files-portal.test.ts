import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTerminal } from '../../src/core/jobs.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { HAVE_FFMPEG, SECRET_VALUES, makeJpeg, makePng } from '../fixtures/media.js';

/** Copy a stored artifact into the import root (simulates the user importing the same bytes again). */
function ctx2path(h: Harness, id: string): string {
  const { copyFileSync } = require('node:fs') as typeof import('node:fs');
  const dst = join(h.ctx.cfg.files.importRoots[0]!, `twin-${id}.jpg`);
  copyFileSync(h.ctx.files.absPath(h.ctx.files.row(id)), dst);
  return dst;
}

async function untilDone(h: Harness, jobId: string) {
  for (let i = 0; i < 120; i++) {
    const j = await h.call('job_status', { jobId, waitSecs: 1 });
    if (isTerminal(j.data.status)) return j.data;
  }
  throw new Error('job did not finish');
}

describe.skipIf(!HAVE_FFMPEG)('file artifacts + portal_upload (fixture portal)', () => {
  let h: Harness;
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rba-portal-'));
    h = await startHarness({ vars: { RBA_IMPORT_ROOTS: root, RBA_MAX_CONCURRENT_SESSIONS: '1' } });
  });
  afterAll(() => h.close());

  const activeSessions = () => h.ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM sessions WHERE status IN ('starting','ready','closing')`)!.n;

  it('without selectors: inspects the page and returns needs_input; nothing is selected or sent', async () => {
    const imp = await h.call('file_import', { path: makePng(root) });
    expect(imp.isError, imp.raw).toBe(false);
    expect(imp.raw).not.toContain(root); // no absolute paths
    const r = await h.call('portal_upload', { artifactId: imp.data.artifactId, targetUrl: h.site.url('/upload'), proxyMode: 'direct', waitSecs: 60 });
    const job = r.data.status === 'completed' ? r.data : await untilDone(h, r.data.jobId);
    expect(job.result?.outcome, JSON.stringify(job)).toBe("needs_input");
    expect(job.result.untrusted.observed.fileInputs.map((x: any) => x.selector)).toContain('#file');
    expect(job.result.untrusted.observed.submitButtons.map((x: any) => x.selector)).toContain('#upload-submit');
    expect(job.result.stages).toMatchObject({ transferredToWorker: false, selectedInBrowser: false });
    expect(h.site.state.uploads).toEqual([]);
    expect(activeSessions()).toBe(0);
  });

  it('import -> inspect -> sanitize -> verify -> upload: destination receives the sanitized bytes', async () => {
    const src = makeJpeg(root);
    const original = readFileSync(src);
    const imp = await h.call('file_import', { path: src });
    const ins = await h.call('media_inspect', { artifactId: imp.data.artifactId });
    expect(ins.data.untrusted.identifyingFieldCounts.gps).toBeGreaterThan(0);
    expect(ins.raw).not.toContain(SECRET_VALUES.artist);
    const san = await h.call('media_sanitize', { artifactId: imp.data.artifactId, waitSecs: 60 });
    const sj = san.data.status === 'completed' ? san.data : await untilDone(h, san.data.jobId);
    expect(sj.status, JSON.stringify(sj)).toBe('completed');
    const out = sj.result.outputArtifact;
    expect(sj.result.verdict).toBe('verified_for_policy');
    const ver = await h.call('media_verify', { artifactId: out.artifactId });
    expect(ver.data.verdict).toBe('verified_for_policy');
    expect(ver.data.policyVersion).toBe(2);
    // The fixture's ICC profile only CLAIMS a standard name: it is a retained finding that needs a decision,
    // and the digest from the sanitize run is no longer valid after the re-verification.
    expect(ver.data.acceptanceDigest).toMatch(/^acc1:[0-9a-f]{64}$/);
    expect(ver.data.acceptanceDigest).not.toBe(sj.result.acceptanceDigest);
    const before = h.site.state.uploads.length;
    const r = await h.call('portal_upload', {
      artifactId: out.artifactId,
      targetUrl: h.site.url('/upload'),
      proxyMode: 'direct',
      fileInputSelector: '#file',
      submitSelector: '#upload-submit',
      confirmation: { selector: '#upload-result', sizeSelector: '#upload-result .size', sha256Selector: '#upload-result .sha256' },
      requireSanitized: true,
      acceptRetainedFindings: ver.data.acceptanceDigest,
      waitSecs: 90,
    });
    const job = r.data.status === 'completed' ? r.data : await untilDone(h, r.data.jobId);
    expect(job.status, JSON.stringify(job)).toBe('completed');
    expect(job.result.outcome).toBe('portal_confirmed');
    expect(job.result.artifact.uploadedFileName).toBe('upload.jpg'); // neutral name under requireSanitized
    expect(h.site.state.uploads[before]!.filename).toBe('upload.jpg');
    // execution report: derived from stored state, then snapshotted
    const live = await h.call('run_report', { jobId: job.jobId ?? r.data.jobId });
    expect(live.isError, live.raw).toBe(false);
    // The job's terminal transition snapshots the report (Jobs.onTerminal -> reports.finalizeJob).
    expect(live.data.source).toBe('finalized_snapshot');
    const rep = live.data.report;
    expect(rep).toMatchObject({ reportVersion: 1, effectiveMode: 'remote_direct', requestedMode: 'remote_direct', account: null });
    expect(rep.route.verification).toBe('not_checked');
    expect(rep.files).toHaveLength(1);
    expect(rep.files[0]).toMatchObject({ artifactId: out.artifactId, sha256: out.sha256 });
    expect(rep.files[0].sanitization).toMatch(/verified_for_policy under image_metadata@2; .*accepted by digest/);
    expect(rep.files[0].detail).toMatchObject({ fileName: 'upload.jpg', policyVersion: 2, acceptanceDigest: ver.data.acceptanceDigest });
    expect(rep.confirmation.kind).toBe('portal_confirmed');
    expect(rep.confirmation.evidence).toMatch(/SHA-256 shown by the portal equals the artifact/);
    expect(rep.cleanup.done.join(' ')).toMatch(/closed/);
    expect(rep.cost.basis).toMatch(/provider|estimate/);
    expect(live.raw).not.toContain(SECRET_VALUES.artist);
    await h.ctx.reports.finalizeJob(job.jobId ?? r.data.jobId);
    const snap = await h.call('run_report', { runId: rep.runId });
    expect(snap.data.source).toBe('finalized_snapshot');
    expect(snap.data.report.files[0].artifactId).toBe(out.artifactId);
    expect(job.result.stages).toEqual({ transferredToWorker: true, selectedInBrowser: true, sentToDestination: true, portalConfirmed: true });
    expect(job.result.destination).toMatchObject({ sizeMatches: true, sha256Matches: true });
    const received = h.site.state.uploads[before]!;
    expect(received.sha256).toBe(out.sha256); // the destination got the SANITIZED copy
    expect(received.sha256).not.toBe((await import('node:crypto')).createHash('sha256').update(original).digest('hex'));
    expect(readFileSync(src).equals(original)).toBe(true);
    expect(activeSessions()).toBe(0);
    expect(h.ctx.files.row(out.artifactId).locked_by).toBeNull();
    // same file to the same target again: refused before any session
    const runs = h.apify.state.runStarts;
    const again = await h.call('portal_upload', { artifactId: out.artifactId, targetUrl: h.site.url('/upload'), proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit' });
    expect(again.data.error.code).toBe('conflict');
    // a second import of the same bytes is recognised as identical content, naming the earlier artifact
    const twin = await h.call('file_import', { path: ctx2path(h, out.artifactId) });
    const tw = await h.call('portal_upload', { artifactId: twin.data.artifactId, targetUrl: h.site.url('/upload'), proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit' });
    expect(tw.data.error.message).toMatch(/different artifact with identical content/);
    expect(tw.data.error.details.priorArtifactId).toBe(out.artifactId);
    expect(h.apify.state.runStarts).toBe(runs);
    // deleting the plugin copy says what it does not do
    const del = await h.call('file_delete', { artifactId: out.artifactId, confirmArtifactId: out.artifactId });
    expect(del.data.note).toMatch(/not forensically erased/);
  });

  it('never uploads the original in place of a sanitized copy (original, partial, or failed cleaning)', async () => {
    const runs = h.apify.state.runStarts;
    const imp = await h.call('file_import', { path: makePng(root) });
    const orig = await h.call('portal_upload', { artifactId: imp.data.artifactId, targetUrl: h.site.url('/upload'), proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit', requireSanitized: true });
    expect(orig.data.error.code).toBe('forbidden');
    // a "partial" output is refused too
    const san = await h.call('media_sanitize', { artifactId: imp.data.artifactId, waitSecs: 60 });
    const sj = san.data.status === 'completed' ? san.data : await untilDone(h, san.data.jobId);
    h.ctx.db.run(`UPDATE files SET verdict = 'partial' WHERE id = ?`, sj.result.outputArtifact.artifactId);
    const part = await h.call('portal_upload', { artifactId: sj.result.outputArtifact.artifactId, targetUrl: h.site.url('/upload'), proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit', requireSanitized: true });
    expect(part.data.error.code).toBe('forbidden');
    // cleaning fails (corrupt file): there is no output, and the original is refused
    const bad = join(root, 'corrupt.jpg');
    writeFileSync(bad, readFileSync(makeJpeg(root)).subarray(0, 300));
    const bimp = await h.call('file_import', { path: bad });
    const bs = await h.call('media_sanitize', { artifactId: bimp.data.artifactId, waitSecs: 60 });
    const bj = bs.data.status === 'failed' ? bs.data : await untilDone(h, bs.data.jobId);
    expect(bj.status).toBe('failed');
    const refuse = await h.call('portal_upload', { artifactId: bimp.data.artifactId, targetUrl: h.site.url('/upload'), proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit', requireSanitized: true });
    expect(refuse.data.error.code).toBe('forbidden');
    expect(h.apify.state.runStarts).toBe(runs); // no remote session was started for any refusal
  });

  it('a worker refusal before selection (wrong selector) is not counted as sent; a retry is allowed', async () => {
    const imp = await h.call('file_import', { path: makePng(root, '26x14') });
    const r = await h.call('portal_upload', { artifactId: imp.data.artifactId, targetUrl: h.site.url('/upload'), proxyMode: 'direct', fileInputSelector: '#upload-submit', submitSelector: '#upload-submit', waitSecs: 60 });
    const job = ['completed', 'failed'].includes(r.data.status) ? r.data : await untilDone(h, r.data.jobId);
    expect(job.status).toBe('failed');
    expect(job.submittedAt).toBeNull();
    const retry = await h.call('portal_upload', { artifactId: imp.data.artifactId, targetUrl: h.site.url('/upload'), proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit', confirmation: { selector: '#upload-result' }, waitSecs: 60 });
    const rj = retry.data.status === 'completed' ? retry.data : await untilDone(h, retry.data.jobId);
    expect(rj.result?.outcome, JSON.stringify(rj)).toBe('portal_confirmed');
  });

  it('requireSanitized: retained findings are shown and need an explicit decision; nothing is deleted', async () => {
    const { makePdf } = await import('../fixtures/media.js');
    const runs = h.apify.state.runStarts;
    const imp = await h.call('file_import', { path: await makePdf(root, { name: 'form-upload.pdf', formValue: 'Jane Applicant Fixture' }) });
    const san = await h.call('media_sanitize', { artifactId: imp.data.artifactId, waitSecs: 60 });
    const sj = san.data.status === 'completed' ? san.data : await untilDone(h, san.data.jobId);
    expect(sj.result.verdict).toBe('verified_for_policy');
    const out = sj.result.outputArtifact.artifactId;
    const args = { artifactId: out, targetUrl: h.site.url('/upload'), proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit', confirmation: { selector: '#upload-result', sha256Selector: '#upload-result .sha256' }, requireSanitized: true, waitSecs: 90 };
    const refused = await h.call('portal_upload', args);
    expect(refused.data.error.code).toBe('forbidden');
    expect(refused.data.error.details.needsDecision).toBe('acceptRetainedFindings');
    const s = refused.data.error.details.sanitization;
    expect(s).toMatchObject({ policy: 'pdf_document_properties', verdict: 'verified_for_policy' });
    expect(s.retainedFindings.map((f: any) => f.category)).toEqual(expect.arrayContaining(['annotation-authors', 'form-values', 'embedded-files']));
    expect(s.summary).toMatch(/kept by design/);
    expect(h.apify.state.runStarts).toBe(runs); // refused before any session
    // the old boolean is refused with instructions
    const bool = await h.call('portal_upload', { ...args, acceptRetainedFindings: true });
    expect(bool.data.error.code).toBe('invalid_input');
    expect(bool.data.error.message).toMatch(/acceptanceDigest/);
    const digest = refused.data.error.details.acceptanceDigest;
    expect(digest).toMatch(/^acc1:[0-9a-f]{64}$/);
    // a digest of another artifact, or of an earlier verification run, does not carry over
    const reverify = await h.call('media_verify', { artifactId: out });
    expect(reverify.data.acceptanceDigest).not.toBe(digest);
    const stale = await h.call('portal_upload', { ...args, acceptRetainedFindings: digest });
    expect(stale.data.error.code).toBe('forbidden');
    expect(stale.data.error.message).toMatch(/does not match/);
    expect(h.apify.state.runStarts).toBe(runs);
    const ok = await h.call('portal_upload', { ...args, acceptRetainedFindings: reverify.data.acceptanceDigest });
    const job = ok.data.status === 'completed' ? ok.data : await untilDone(h, ok.data.jobId);
    expect(job.result.outcome).toBe('portal_confirmed');
    expect(job.result.sanitization.retainedFindings.length).toBeGreaterThan(0); // reported with the upload too
    expect(job.result.destination.sha256Matches).toBe(true);
  });

    it('targets outside the allowed origins are refused before any session', async () => {
    const runs = h.apify.state.runStarts;
    const imp = await h.call('file_import', { path: makePng(root) });
    const r = await h.call('portal_upload', { artifactId: imp.data.artifactId, targetUrl: 'https://portal.example.net/upload', proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit' });
    expect(r.data.error.code).toBe('unauthorized_target');
    expect(h.apify.state.runStarts).toBe(runs);
  });

  it('a submit that times out is outcome_unknown, inspected, not retried, and a repeat is refused', async () => {
    const imp = await h.call('file_import', { path: makePng(root, '20x10') });
    const r = await h.call('portal_upload', {
      artifactId: imp.data.artifactId,
      targetUrl: h.site.url('/upload-slow'),
      proxyMode: 'direct',
      fileInputSelector: '#file',
      submitSelector: '#upload-submit',
      confirmation: { selector: '#upload-result' },
      submitTimeoutSecs: 5,
      waitSecs: 90,
    });
    const job = r.data.status === 'outcome_unknown' ? r.data : await untilDone(h, r.data.jobId);
    expect(job.status).toBe('outcome_unknown');
    expect(job.outcome).toBe('outcome_unknown');
    expect(job.result.outcome).toBe('outcome_unknown');
    expect(job.result.stages).toMatchObject({ transferredToWorker: true, selectedInBrowser: true, sentToDestination: 'unknown', portalConfirmed: false });
    expect(job.submittedAt).toBeTruthy();
    const again = await h.call('portal_upload', { artifactId: imp.data.artifactId, targetUrl: h.site.url('/upload-slow'), proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit' });
    expect(again.data.error.code).toBe('conflict');
    expect(activeSessions()).toBe(0);
  }, 120_000);

  it('cancellation before the submit: no upload, session closed, artifact unlocked', async () => {
    const before = h.site.state.uploads.length;
    const imp = await h.call('file_import', { path: makePng(root, '24x12') });
    const r = await h.call('portal_upload', { artifactId: imp.data.artifactId, targetUrl: h.site.url('/upload'), proxyMode: 'direct', fileInputSelector: '#file', submitSelector: '#upload-submit', waitSecs: 0 });
    await h.call('job_cancel', { jobId: r.data.jobId });
    const job = await untilDone(h, r.data.jobId);
    expect(job.status).toBe('cancelled');
    await new Promise((x) => setTimeout(x, 500));
    expect(h.site.state.uploads.length).toBe(before);
    expect(activeSessions()).toBe(0);
    expect(h.ctx.files.row(imp.data.artifactId).locked_by).toBeNull();
  });

  it('browser_upload accepts an artifact id (compatible with filePath)', async () => {
    const imp = await h.call('file_import', { path: makePng(root, '30x10') });
    const s = await h.call('session_start', {});
    await h.call('browser_navigate', { sessionId: s.data.sessionId, url: h.site.url('/upload') });
    const up = await h.call('browser_upload', { sessionId: s.data.sessionId, selector: '#file', artifactId: imp.data.artifactId });
    expect(up.data).toMatchObject({ verified: true, bytes: imp.data.size, sha256: imp.data.sha256 });
    const both = await h.call('browser_upload', { sessionId: s.data.sessionId, selector: '#file', artifactId: imp.data.artifactId, filePath: '/etc/hosts' });
    expect(both.data.error.code).toBe('invalid_input');
    // the artifact path has the same gate as portal_upload: an original is refused under requireSanitized
    const gated = await h.call('browser_upload', { sessionId: s.data.sessionId, selector: '#file', artifactId: imp.data.artifactId, requireSanitized: true });
    expect(gated.data.error.code).toBe('forbidden');
    expect(gated.data.error.message).toMatch(/original/);
    // ...a boolean acceptance is refused, and the artifact is not left locked
    const boolAcc = await h.call('browser_upload', { sessionId: s.data.sessionId, selector: '#file', artifactId: imp.data.artifactId, acceptRetainedFindings: true });
    expect(boolAcc.data.error.code).toBe('invalid_input');
    expect(h.ctx.files.row(imp.data.artifactId).locked_by).toBeNull();
    // a stored copy changed behind the plugin's back is refused
    const row = h.ctx.files.row(imp.data.artifactId);
    const { appendFileSync } = await import('node:fs');
    appendFileSync(h.ctx.files.absPath(row), Buffer.from([0]));
    const tampered = await h.call('browser_upload', { sessionId: s.data.sessionId, selector: '#file', artifactId: imp.data.artifactId });
    expect(tampered.data.error.code).toBe('conflict');
    await h.call('session_close', { sessionId: s.data.sessionId });
  });
});
