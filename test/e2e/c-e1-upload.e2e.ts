/**
 * Scenario C: import -> sanitize -> review findings -> remote upload -> meaningful confirmation.
 * Scenario E1: ambiguous upload submission -> outcome_unknown -> no duplicate.
 * Proof level: local fixture (fixture upload endpoint echoes size + sha256 of
 * the bytes it received). Extraction is not upload proof; this is the upload proof
 * at fixture level only.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAVE_FFMPEG, SECRET_VALUES, makeJpeg, makePng } from '../fixtures/media.js';
import { knownDefectHits, leftoverLocalRuns, liveFakeRuns, reportKnownDefects, startE2E, type E2E } from './stdio-harness.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!HAVE_FFMPEG)('C + E1: sanitized remote upload with confirmation; ambiguous submit', () => {
  let h: E2E;
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rba-e2e-import-'));
    h = await startE2E({ vars: { RBA_IMPORT_ROOTS: root } });
  });
  afterAll(async () => {
    reportKnownDefects('c-e1-upload');
    await h?.close();
    rmSync(root, { recursive: true, force: true });
  });

  let localReportJobId = '';
  const active = () => h.q(`SELECT id FROM sessions WHERE status IN ('starting','ready','closing')`).length;

  for (const mode of ['remote_direct', 'local'] as const) {
    it(`C ${mode}: findings reviewed, sanitized copy uploaded, portal echo matches the sanitized sha256`, async () => {
      const src = makeJpeg(root);
      const originalSha = sha(readFileSync(src));
      const imp = await h.call('file_import', { path: src });
      expect(imp.isError, imp.raw).toBe(false);
      expect(imp.raw).not.toContain(root);

      // Review findings before cleaning: identifying metadata is reported by count, never by value.
      const ins = await h.call('media_inspect', { artifactId: imp.data.artifactId });
      expect(ins.data.untrusted.identifyingFieldCounts.gps).toBeGreaterThan(0);
      expect(ins.raw).not.toContain(SECRET_VALUES.artist);

      const san = await h.call('media_sanitize', { artifactId: imp.data.artifactId, waitSecs: 60 });
      const sj = san.data.status === 'completed' ? san.data : await h.untilDone(san.data.jobId);
      expect(sj.status, JSON.stringify(sj)).toBe('completed');
      expect(sj.result.verdict).toBe('verified_for_policy');
      const out = sj.result.outputArtifact;
      expect(out.sha256).not.toBe(originalSha);
      const ver = await h.call('media_verify', { artifactId: out.artifactId });
      expect(ver.data.verdict).toBe('verified_for_policy');
      const digest = ver.data.acceptanceDigest;
      expect(digest).toMatch(/^acc1:[0-9a-f]{64}$/);

      // Review step: findings the policy keeps by design (the fixture's ICC profile) block the upload until the
      // user accepts exactly this digest. Nothing is selected or sent while the decision is pending.
      const before0 = h.site.state.uploads.length;
      const undecided = await h.call('portal_upload', { mode, artifactId: out.artifactId, targetUrl: h.site.url('/upload'), fileInputSelector: '#file', submitSelector: '#upload-submit', requireSanitized: true });
      expect(undecided.isError).toBe(true);
      expect(undecided.data.error.code).toBe('forbidden');
      expect(undecided.data.error.details).toMatchObject({ needsDecision: 'acceptRetainedFindings', acceptanceDigest: digest });
      expect(undecided.data.error.details.sanitization.retainedFindings.length).toBeGreaterThan(0);
      expect(h.site.state.uploads.length).toBe(before0);

      // Upload, with the original refused under requireSanitized.
      const refused = await h.call('portal_upload', { mode, artifactId: imp.data.artifactId, targetUrl: h.site.url('/upload'), fileInputSelector: '#file', submitSelector: '#upload-submit', requireSanitized: true });
      expect(refused.isError).toBe(true);

      // makeJpeg is deterministic, so the second mode uploads the same sanitized bytes to the same target:
      // the duplicate guard must refuse it unless the repeat is explicit.
      const repeat = mode === 'local';
      if (repeat) {
        const dup = await h.call('portal_upload', { mode, artifactId: out.artifactId, targetUrl: h.site.url('/upload'), fileInputSelector: '#file', submitSelector: '#upload-submit', requireSanitized: true, acceptRetainedFindings: digest });
        expect(dup.isError).toBe(true);
        expect(dup.data.error.code).toBe('conflict');
      }
      const before = h.site.state.uploads.length;
      const r = await h.call('portal_upload', {
        ...(repeat ? { allowRepeat: true } : {}),
        mode,
        artifactId: out.artifactId,
        targetUrl: h.site.url('/upload'),
        fileInputSelector: '#file',
        submitSelector: '#upload-submit',
        confirmation: { selector: '#upload-result', sizeSelector: '#upload-result .size', sha256Selector: '#upload-result .sha256' },
        requireSanitized: true,
        acceptRetainedFindings: digest,
        waitSecs: 90,
      });
      expect(r.isError, r.raw).toBe(false);
      const job = ['completed', 'failed'].includes(r.data.status) ? r.data : await h.untilDone(r.data.jobId);
      expect(job.status, JSON.stringify(job)).toBe('completed');
      // Meaningful confirmation: portal_confirmed with the destination's own hash matching (sent_unconfirmed would fail here).
      expect(job.result.outcome).toBe('portal_confirmed');
      expect(job.result.destination).toMatchObject({ sizeMatches: true, sha256Matches: true });
      expect(h.site.state.uploads.length - before).toBe(1);
      expect(h.site.state.uploads[before]!.sha256).toBe(out.sha256);
      expect(h.site.state.uploads[before]!.sha256).not.toBe(originalSha);

      const jrow = h.q<{ status: string; session_id: string | null }>('SELECT status, session_id FROM jobs WHERE id = ?', job.jobId ?? r.data.jobId)[0]!;
      expect(jrow.status).toBe('completed');
      expect(active()).toBe(0);
      if (jrow.session_id) {
        const srow = h.q<{ provider: string }>('SELECT provider FROM sessions WHERE id = ?', jrow.session_id)[0]!;
        expect(srow.provider === 'local').toBe(mode === 'local');
      }

      // Execution report (W3), snapshotted when the job ended.
      const rr = await h.call('run_report', { jobId: job.jobId ?? r.data.jobId });
      expect(rr.isError, rr.raw).toBe(false);
      expect(rr.data.source).toBe('finalized_snapshot');
      const rep = rr.data.report;
      expect(rep).toMatchObject({ reportVersion: 1, requestedMode: mode, effectiveMode: mode, account: null });
      if (mode === 'local') {
        localReportJobId = job.jobId ?? r.data.jobId;
        expect(rep.route.verification).toBe('not_checked');
      } else {
        expect(rep.route.verification).toBe('not_checked');
      }
      expect(rep.route.proxy).toBeNull();
      expect(rep.files).toHaveLength(1);
      expect(rep.files[0]).toMatchObject({ artifactId: out.artifactId, sha256: out.sha256 });
      expect(rep.files[0].sanitization).toMatch(/verified_for_policy .*accepted by digest/);
      expect(rep.confirmation.kind).toBe('portal_confirmed');
      expect(rep.confirmation.evidence).toMatch(/SHA-256/);
      expect(rep.cleanup.pending).toEqual([]);
      expect(rep.cleanup.done.join(' ')).toMatch(/closed/);
      expect(typeof rep.cost.basis).toBe('string');
      if (mode === 'local') {
        expect(rep.cost.basis).toMatch(/local.*no provider charge/);
        expect(rep.cost.providerReportedUsd ?? 0).toBe(0);
      } else {
        expect(rep.cost.basis).toMatch(/provider|estimate/);
      }
      expect(Array.isArray(rep.uncertain)).toBe(true);
      expect(rr.raw).not.toContain(SECRET_VALUES.artist);
      expect(rr.raw).not.toContain(root);
      expect(JSON.stringify(rep)).not.toMatch(/\banonymous\b/i);
    });
  }

  it('run_report for a local job reports route.verification not_checked, like the session view (REPORT-LOCAL-VERIFICATION regression)', async () => {
    expect(localReportJobId).not.toBe('');
    const rr = await h.call('run_report', { jobId: localReportJobId });
    expect(rr.data.report.route.verification).toBe('not_checked');
  });

  it('E1: a submit that times out is outcome_unknown, not retried, a repeat is refused, and the destination never gets a duplicate', async () => {
    const imp = await h.call('file_import', { path: makePng(root, '22x11') });
    const artifactSha = imp.data.sha256 ?? h.q<{ sha256: string }>('SELECT sha256 FROM files WHERE id = ?', imp.data.artifactId)[0]?.sha256;
    expect(artifactSha).toMatch(/^[a-f0-9]{64}$/);
    const args = { mode: 'remote_direct', artifactId: imp.data.artifactId, targetUrl: h.site.url('/upload-slow'), fileInputSelector: '#file', submitSelector: '#upload-submit', confirmation: { selector: '#upload-result' } };
    const r = await h.call('portal_upload', { ...args, submitTimeoutSecs: 5, waitSecs: 90 });
    const job = ['failed', 'completed'].includes(r.data.status) ? r.data : await h.untilDone(r.data.jobId);
    expect(job.result.outcome).toBe('outcome_unknown');
    expect(job.status).not.toBe('completed');
    expect(job.result.stages).toMatchObject({ transferredToWorker: true, selectedInBrowser: true, sentToDestination: 'unknown', portalConfirmed: false });

    const runsBefore = h.apify!.state.runStarts;
    const again = await h.call('portal_upload', args);
    expect(again.isError).toBe(true);
    expect(again.data.error.code).toBe('conflict');
    expect(h.apify!.state.runStarts).toBe(runsBefore); // refused before any worker

    // Let the slow endpoint finish whatever it received; the destination holds at most ONE copy.
    await new Promise((x) => setTimeout(x, 14_000));
    // The fixture reads the body before its delay, so the ambiguous submit DID reach it once: exactly one copy, no duplicate.
    const copies = h.site.state.uploads.filter((u) => u.sha256 === artifactSha);
    expect(copies.length).toBe(1);
    expect(active()).toBe(0);
  }, 180_000);

  it('teardown: no orphaned workers or active sessions', async () => {
    expect(await h.stopServer()).toBe(0);
    expect(liveFakeRuns(h.apify)).toEqual([]);
    expect(leftoverLocalRuns(h.dataDir)).toEqual([]);
    for (const s of h.secrets) expect(h.stderr()).not.toContain(s);
  });
});
