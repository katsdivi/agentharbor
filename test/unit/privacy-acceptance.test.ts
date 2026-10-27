import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertSanitizedForUpload, recordAcceptance, reportDigest, sanitizationStatus, type DigestInput } from '../../src/files/acceptance.js';
import { runPortalUpload } from '../../src/files/portal.js';
import { verifyFile } from '../../src/files/service.js';
import { testCtx } from '../helpers/ctx.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4790000000049454e44ae426082', 'hex');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const ctx = testCtx({ RBA_ALLOWED_ORIGINS: 'https://portal.example' });
  dirs.push(join(ctx.cfg.dataDir, '..'));
  const src = ctx.files.importBuffer(PNG, 'CANARY_FN_source.png');
  const output = (verification: Record<string, unknown> | null, bytes = Buffer.concat([PNG, Buffer.from([0])])) => {
    const tmp = ctx.files.tmpPath('png');
    writeFileSync(tmp, bytes);
    const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    return ctx.files.commit(tmp, bytes, bytes.length, sha, 'out.png', 'sanitized', src.artifactId, 'image_metadata', 'verified_for_policy', verification === null ? null : { verification, sourceSha256: src.sha256 });
  };
  const current = (extra: Record<string, unknown> = {}) => ({ verdict: 'verified_for_policy', policy: 'image_metadata', residual: [], retainedFindings: [], inspectionGaps: [], policyVersion: 2, verificationId: `ver_${Math.random().toString(16).slice(2)}`, verifiedAt: new Date().toISOString(), ...extra });
  return { ctx, src, output, current };
}

describe('acceptance digest', () => {
  const base: DigestInput = {
    artifactId: 'file_a',
    artifactSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64),
    policy: 'image_metadata',
    policyVersion: 2,
    verdict: 'verified_for_policy',
    residual: [],
    retainedFindings: [
      { category: 'icc', name: 'x', where: 'ICC' },
      { category: 'icc', name: 'y', where: 'ICC' },
    ],
    inspectionGaps: ['g1', 'g2'],
    verificationId: 'ver_1',
  };
  it('is stable under reordering and changes with every bound field', () => {
    const d = reportDigest(base);
    expect(reportDigest({ ...base, retainedFindings: [...base.retainedFindings].reverse(), inspectionGaps: ['g2', 'g1'] })).toBe(d);
    for (const change of [{ artifactId: 'file_b' }, { artifactSha256: 'c'.repeat(64) }, { policyVersion: 3 }, { verificationId: 'ver_2' }, { inspectionGaps: ['g1'] }, { verdict: 'partial' }]) {
      expect(reportDigest({ ...base, ...change } as DigestInput)).not.toBe(d);
    }
  });

  it('no findings and no gaps: no decision needed', () => {
    const { ctx, output, current } = setup();
    const o = output(current());
    const s = assertSanitizedForUpload(ctx, ctx.files.row(o.artifactId), { requireSanitized: true });
    expect(s.acceptanceDigest).toBeNull();
    expect(s.stale).toBe(false);
  });

  it('findings: refused without the digest, refused with another artifact\'s digest, accepted with its own, and recorded', () => {
    const { ctx, output, current } = setup();
    const findings = { retainedFindings: [{ category: 'icc', name: 'ICC text', where: 'ICC' }] };
    const a = output(current(findings));
    const b = output(current(findings), Buffer.concat([PNG, Buffer.from([1])]));
    const rowA = ctx.files.row(a.artifactId);
    let digest = '';
    try {
      assertSanitizedForUpload(ctx, rowA, { requireSanitized: true });
      throw new Error('not refused');
    } catch (e: any) {
      expect(e.code).toBe('forbidden');
      expect(e.details.needsDecision).toBe('acceptRetainedFindings');
      digest = e.details.acceptanceDigest;
    }
    const digestB = sanitizationStatus(ctx, b.artifactId).acceptanceDigest!;
    expect(digestB).not.toBe(digest);
    expect(() => assertSanitizedForUpload(ctx, rowA, { requireSanitized: true, acceptRetainedFindings: digestB })).toThrow(/does not match/);
    expect(() => assertSanitizedForUpload(ctx, rowA, { requireSanitized: true, acceptRetainedFindings: true })).toThrow(/no longer a boolean/);
    const s = assertSanitizedForUpload(ctx, rowA, { requireSanitized: true, acceptRetainedFindings: digest });
    recordAcceptance(ctx, rowA, s, 'job_test');
    const rec = ctx.db.get<{ artifact_sha256: string; findings: number; policy_version: number }>('SELECT * FROM file_acceptances WHERE artifact_id = ?', a.artifactId)!;
    expect(rec).toMatchObject({ artifact_sha256: rowA.sha256, findings: 1, policy_version: 2 });
  });

  it('a stale (pre-version) report must be re-verified; it cannot be accepted', () => {
    const { ctx, output } = setup();
    // shape written by the previous release: findings/gaps present but no policy version or verification id
    const o = output({ verdict: 'verified_for_policy', policy: 'image_metadata', residual: [], retainedFindings: [], inspectionGaps: [] });
    const st = sanitizationStatus(ctx, o.artifactId);
    expect(st.stale).toBe(true);
    expect(st.policyVersion).toBeNull();
    expect(st.inspectionGaps.join(' ')).toMatch(/before policy versions existed; .*run media_verify/);
    try {
      assertSanitizedForUpload(ctx, ctx.files.row(o.artifactId), { requireSanitized: true, acceptRetainedFindings: st.acceptanceDigest! });
      throw new Error('not refused');
    } catch (e: any) {
      expect(e.details.needsDecision).toBe('reverify');
    }
  });

  it('a stale report whose source was deleted is frozen: accepted only with an explicit digest that names the gap', () => {
    const { ctx, src, output } = setup();
    const o = output({ verdict: 'verified_for_policy', policy: 'image_metadata', residual: [], retainedFindings: [], inspectionGaps: [] });
    ctx.files.delete(src.artifactId);
    const st = sanitizationStatus(ctx, o.artifactId);
    expect(st.frozen).toBe(true);
    expect(st.inspectionGaps.join(' ')).toMatch(/cannot be re-run because the source artifact was deleted/);
    expect(() => assertSanitizedForUpload(ctx, ctx.files.row(o.artifactId), { requireSanitized: true })).toThrow(/explicitly accept/);
    expect(assertSanitizedForUpload(ctx, ctx.files.row(o.artifactId), { requireSanitized: true, acceptRetainedFindings: st.acceptanceDigest! }).frozen).toBe(true);
  });
});

describe('locking order', () => {
  it('media_verify refuses while the artifact is locked by an upload', async () => {
    const { ctx, output, current } = setup();
    const o = output(current());
    ctx.files.lock(o.artifactId, 'job_upload');
    await expect(verifyFile(ctx, o.artifactId)).rejects.toThrow(/in use by job_upload/);
  });

  it('portal upload takes the lock before its checks (a running verify blocks it)', async () => {
    const { ctx, output, current } = setup();
    const o = output(current());
    ctx.files.lock(o.artifactId, 'verify_x');
    await expect(
      runPortalUpload(ctx, 'job_1', { artifactId: o.artifactId, targetUrl: 'https://portal.example/u', mode: 'remote_direct', requireSanitized: true }, new AbortController().signal),
    ).rejects.toThrow(/in use by verify_x/);
    expect(ctx.files.row(o.artifactId).locked_by).toBe('verify_x');
  });
});
