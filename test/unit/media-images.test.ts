import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectImage, parseJpeg, pngChunk } from '../../src/files/images.js';
import { defaultEnv, imageHandler } from '../../src/files/media.js';
import { inspectFile, sanitizeFile, serviceHooks, verifyFile } from '../../src/files/service.js';
import { testCtx } from '../helpers/ctx.js';
import { ALL_SECRETS, FAKE_ICC, HAVE_FFMPEG, SECRET_VALUES, makeJpeg, makePng, makeWebp } from '../fixtures/media.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function setup(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rba-media-'));
  const ctx = testCtx({ RBA_IMPORT_ROOTS: root, ...extra });
  return { ctx, root };
}

const run = (ctx: ReturnType<typeof setup>['ctx'], id: string, opts = {}) => sanitizeFile(ctx, 'test', id, opts, new AbortController().signal);

describe.skipIf(!HAVE_FFMPEG)('images: inspect, sanitize, verify', () => {
  for (const [name, make, orientation] of [
    ['JPEG', makeJpeg, 6],
    ['PNG', makePng, 3],
    ['WebP', makeWebp, 8],
  ] as const) {
    it(`${name}: inspection reports names/counts only; detailed shows values`, async () => {
      const { ctx, root } = setup();
      const v = ctx.files.importPath(make(root));
      const r = await inspectFile(ctx, v.artifactId, false);
      const counts = r.identifyingFieldCounts as Record<string, number>;
      expect(counts.gps).toBeGreaterThan(0);
      expect(counts.device).toBeGreaterThan(0);
      expect(counts.author).toBeGreaterThan(0);
      const text = JSON.stringify(r);
      for (const s of ALL_SECRETS) expect(text, s).not.toContain(s);
      expect(text).not.toMatch(/48\/1|2\/1 17\/1/); // no GPS coordinates
      expect((r.retainedByPolicy as any).orientation).toBe(orientation);
      const d = JSON.stringify(await inspectFile(ctx, v.artifactId, true));
      expect(d).toContain(SECRET_VALUES.artist);
    });

    it(`${name}: sanitized copy has no targeted metadata, same pixels, orientation and ICC kept, original untouched`, async () => {
      const { ctx, root } = setup();
      const path = make(root);
      const original = readFileSync(path);
      const v = ctx.files.importPath(path);
      const res = await run(ctx, v.artifactId);
      expect(res.verdict, JSON.stringify(res.verification, null, 1)).toBe('verified_for_policy');
      expect(res.output).not.toBeNull();
      const out = readFileSync(ctx.files.absPath(ctx.files.row(res.output!.artifactId)));
      for (const s of ALL_SECRETS) expect(out.includes(Buffer.from(s, 'latin1')), s).toBe(false);
      const after = inspectImage(name.toLowerCase() === 'jpeg' ? 'jpeg' : (name.toLowerCase() as 'png' | 'webp'), out, true);
      expect(after.fields).toEqual(name === 'JPEG' ? [] : []);
      expect(after.orientation).toBe(orientation);
      expect(after.iccProfileSha256).not.toBeNull();
      const checks = Object.fromEntries(res.verification.checks.map((c) => [c.name, c.ok]));
      expect(checks.decoded_pixels_identical).toBe(true);
      expect(checks.icc_profile_unchanged).toBe(true);
      expect(checks.source_unchanged).toBe(true);
      expect(res.verification.methods).toEqual(expect.arrayContaining(['rba-container-parser', 'byte-signature-scan', 'ffmpeg-decode']));
      // the user's original file and the imported copy are unchanged
      expect(readFileSync(path).equals(original)).toBe(true);
      expect(ctx.files.rehash(ctx.files.row(v.artifactId))).toBe(sha(original));
      expect(readdirSync(ctx.files.tmpDir)).toEqual([]);
      // re-verification
      const again = await verifyFile(ctx, res.output!.artifactId);
      expect(again.verdict).toBe('verified_for_policy');
    });
  }

  it('JPEG ICC bytes and APP14 preserved exactly; MPF previews removed', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(makeJpeg(root));
    const res = await run(ctx, v.artifactId);
    const out = readFileSync(ctx.files.absPath(ctx.files.row(res.output!.artifactId)));
    expect(out.includes(FAKE_ICC)).toBe(true);
    expect(out.includes(Buffer.from('MPF\0', 'latin1'))).toBe(false);
  });

  it('JPEG data after the image end is retained and reported unless removal is requested', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(makeJpeg(root, { trailing: true }));
    const keep = await run(ctx, v.artifactId);
    expect(JSON.stringify(keep.sanitize)).toMatch(/bytes after the image end/);
    expect(keep.verdict).toBe('partial'); // retained, uninspected bytes never yield "verified"
    expect(readFileSync(ctx.files.absPath(ctx.files.row(keep.output!.artifactId))).includes(Buffer.from('MOTIONPHOTO'))).toBe(true);
    const drop = await run(ctx, v.artifactId, { removeTrailingData: true });
    expect(readFileSync(ctx.files.absPath(ctx.files.row(drop.output!.artifactId))).includes(Buffer.from('MOTIONPHOTO'))).toBe(false);
    expect(drop.verdict).toBe('verified_for_policy');
  });

  it('PNG: unknown ancillary chunks are removed and named; unknown critical chunks are refused; C2PA needs a decision', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(makePng(root));
    const r = await inspectFile(ctx, v.artifactId, false);
    expect((r.retainedByPolicy as any).unknownChunks).toContain('prVt');
    const res = await run(ctx, v.artifactId);
    expect(res.verdict).toBe('verified_for_policy');
    expect(JSON.stringify(res.sanitize)).toMatch(/Unknown ancillary chunks removed.*prVt/);
    expect(readFileSync(ctx.files.absPath(ctx.files.row(res.output!.artifactId))).includes(Buffer.from('prVt'))).toBe(false);
    // C2PA (caBX) content credentials and an unknown CRITICAL chunk
    const b = readFileSync(makePng(root));
    const withC2pa = Buffer.concat([b.subarray(0, 33), pngChunk('caBX', Buffer.from('jumb c2pa creator John Fixture-C2PA')), b.subarray(33)]);
    writeFileSync(join(root, 'c2pa.png'), withC2pa);
    const c = ctx.files.importPath(join(root, 'c2pa.png'));
    expect(JSON.stringify(await inspectFile(ctx, c.artifactId, false))).toMatch(/contentCredentials/);
    await expect(run(ctx, c.artifactId)).rejects.toMatchObject({ details: { needsDecision: 'allowRemoveContentCredentials' } });
    const ok = await run(ctx, c.artifactId, { allowRemoveContentCredentials: true });
    expect(readFileSync(ctx.files.absPath(ctx.files.row(ok.output!.artifactId))).includes(Buffer.from('John Fixture-C2PA'))).toBe(false);
    writeFileSync(join(root, 'crit.png'), Buffer.concat([b.subarray(0, 33), pngChunk('ABCD', Buffer.from('x')), b.subarray(33)]));
    await expect(run(ctx, ctx.files.importPath(join(root, 'crit.png')).artifactId)).rejects.toThrow(/unknown critical chunk/);
  });

  it('JPEG: COM/APP segments placed after the image data are found and removed (not copied through)', async () => {
    const { ctx, root } = setup();
    const b = readFileSync(makeJpeg(root));
    const seg = (m: number, payload: string) => {
      const p = Buffer.from(payload, 'latin1');
      const h = Buffer.from([0xff, m, 0, 0]);
      h.writeUInt16BE(p.length + 2, 2);
      return Buffer.concat([h, p]);
    };
    const eoi = b.length - 2;
    const late = Buffer.concat([b.subarray(0, eoi), seg(0xfe, 'Photographer Late Fixture, 51 Elm Street'), seg(0xeb, 'JP\0\x01jumbc2pa Late Credential Fixture'), b.subarray(eoi)]);
    writeFileSync(join(root, 'late.jpg'), late);
    const v = ctx.files.importPath(join(root, 'late.jpg'));
    const ins = JSON.stringify(await inspectFile(ctx, v.artifactId, false));
    expect(ins).toMatch(/contentCredentials/);
    await expect(run(ctx, v.artifactId)).rejects.toMatchObject({ details: { needsDecision: 'allowRemoveContentCredentials' } });
    const res = await run(ctx, v.artifactId, { allowRemoveContentCredentials: true });
    expect(res.verdict, JSON.stringify(res.verification.residual)).toBe('verified_for_policy');
    const out = readFileSync(ctx.files.absPath(ctx.files.row(res.output!.artifactId)));
    expect(out.includes(Buffer.from('Late Fixture'))).toBe(false);
    expect(out.includes(Buffer.from('Late Credential'))).toBe(false);
    expect(res.verification.checks.find((c) => c.name === 'decoded_pixels_identical')!.ok).toBe(true);
  });

  it('corrupt and truncated images fail cleanly with no output and no temp files', async () => {
    const { ctx, root } = setup();
    const p = makeJpeg(root);
    const b = readFileSync(p);
    writeFileSync(join(root, 'trunc.jpg'), b.subarray(0, Math.floor(b.length / 2)));
    const v = ctx.files.importPath(join(root, 'trunc.jpg'));
    await expect(run(ctx, v.artifactId)).rejects.toThrow(/corrupt|truncated/i);
    writeFileSync(join(root, 'bad.png'), Buffer.concat([readFileSync(makePng(root)).subarray(0, 40), Buffer.from('garbage')]));
    const v2 = ctx.files.importPath(join(root, 'bad.png'));
    await expect(run(ctx, v2.artifactId)).rejects.toThrow(/corrupt|CRC/i);
    expect(ctx.files.list().filter((f) => f.origin === 'sanitized')).toEqual([]);
    expect(readdirSync(ctx.files.tmpDir)).toEqual([]);
    expect(ctx.files.row(v.artifactId).locked_by).toBeNull();
  });

  it('refuses images above the pixel cap before decoding', async () => {
    const { ctx, root } = setup({ RBA_MAX_IMAGE_MEGAPIXELS: '1' });
    const v = ctx.files.importPath(makePng(root, '1100x1000'));
    await expect(run(ctx, v.artifactId)).rejects.toThrow(/RBA_MAX_IMAGE_MEGAPIXELS/);
  });

  it('unsupported formats are reported as unsupported (TIFF)', async () => {
    const { ctx, root } = setup();
    writeFileSync(join(root, 'scan.tiff'), Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.alloc(100)]));
    const v = ctx.files.importPath(join(root, 'scan.tiff'));
    expect(v.capabilities).toMatchObject({ sanitize: false });
    expect(await inspectFile(ctx, v.artifactId, false)).toMatchObject({ verdict: 'unsupported' });
    await expect(run(ctx, v.artifactId)).rejects.toMatchObject({ details: { verdict: 'unsupported' } });
  });

  it('cancellation kills the external tool and leaves no temp file or lock behind', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(makeJpeg(root));
    serviceHooks.run = (_bin, _args, o) =>
      new Promise((_, reject) => o.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))));
    try {
      const job = ctx.jobs.create('sanitize', { artifactId: v.artifactId });
      ctx.jobs.start(job, (signal) => sanitizeFile(ctx, job, v.artifactId, {}, signal).then(() => undefined));
      await new Promise((r) => setTimeout(r, 300));
      expect(ctx.files.row(v.artifactId).locked_by).toBe(job);
      ctx.jobs.cancel(job);
      const done = await ctx.jobs.settle(job);
      expect(done.status).toBe('cancelled');
      expect(readdirSync(ctx.files.tmpDir)).toEqual([]);
      expect(ctx.files.row(v.artifactId).locked_by).toBeNull();
      expect(ctx.files.list().filter((f) => f.origin === 'sanitized')).toEqual([]);
    } finally {
      serviceHooks.run = undefined;
    }
  });

  it('the verifier is not vacuous: changed pixels give "failed", a leftover field gives "partial"', async () => {
    const { ctx, root } = setup();
    const src = makeJpeg(root);
    const v = ctx.files.importPath(src);
    const res = await run(ctx, v.artifactId);
    const clean = readFileSync(ctx.files.absPath(ctx.files.row(res.output!.artifactId)));
    const env = defaultEnv({ timeoutMs: 30_000, maxImagePixels: 1e8, tmp: (e) => ctx.files.tmpPath(e) });
    // flip one byte in the entropy-coded data (not a marker)
    const j = parseJpeg(clean);
    const pixels = Buffer.from(clean);
    let i = j.sosStart + 40;
    while (pixels[i] === 0xff || pixels[i - 1] === 0xff) i++;
    pixels[i] = pixels[i]! ^ 0x55;
    writeFileSync(join(root, 'pix.jpg'), pixels);
    const bad = await imageHandler.verify(ctx.files.absPath(ctx.files.row(v.artifactId)), join(root, 'pix.jpg'), env);
    expect(bad.verdict).toBe('failed');
    expect(bad.checks.find((c) => c.name === 'decoded_pixels_identical')!.ok).toBe(false);
    // re-insert a COM segment with a source value into the clean copy
    const withCom = Buffer.concat([clean.subarray(0, 2), Buffer.from([0xff, 0xfe, 0x00, 2 + SECRET_VALUES.comment.length]), Buffer.from(SECRET_VALUES.comment), clean.subarray(2)]);
    writeFileSync(join(root, 'com.jpg'), withCom);
    const part = await imageHandler.verify(ctx.files.absPath(ctx.files.row(v.artifactId)), join(root, 'com.jpg'), env);
    expect(part.verdict).toBe('partial');
    expect(part.residual.length).toBeGreaterThan(0);
  });

  it('sanitizing an already-sanitized output is allowed and stays verified', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(makePng(root));
    const first = await run(ctx, v.artifactId);
    const second = await run(ctx, first.output!.artifactId);
    expect(second.verdict).toBe('verified_for_policy');
    expect(second.output!.sha256).toBe(first.output!.sha256); // nothing left to remove: identical bytes
    expect(second.output!.sourceArtifactId).toBe(first.output!.artifactId);
  });

    it('media_verify refuses a tampered output and reports a deleted source', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(makePng(root));
    const res = await run(ctx, v.artifactId);
    const outPath = ctx.files.absPath(ctx.files.row(res.output!.artifactId));
    writeFileSync(outPath, Buffer.concat([readFileSync(outPath), Buffer.from('x')]));
    await expect(verifyFile(ctx, res.output!.artifactId)).rejects.toThrow(/changed/);
    const res2 = await run(ctx, v.artifactId);
    ctx.files.delete(v.artifactId);
    await expect(verifyFile(ctx, res2.output!.artifactId)).rejects.toThrow(/source artifact .* was deleted/);
  });
});

describe.skipIf(!HAVE_FFMPEG)('retained image structures are inspected', () => {
  it('a personal ICC profile is kept for rendering but reported as retained findings; a standard-NAMED synthetic one is not trusted', async () => {
    const { PERSONAL_ICC } = await import('../fixtures/media.js');
    const { ctx, root } = setup();
    const b = readFileSync(makeJpeg(root));
    // replace the standard profile with a personal one
    const i = b.indexOf(FAKE_ICC);
    const seg = Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), PERSONAL_ICC]);
    const start = b.lastIndexOf(Buffer.from('ICC_PROFILE\0', 'latin1'), i) - 4;
    const len = b.readUInt16BE(start + 2);
    const head = Buffer.from([0xff, 0xe2, 0, 0]);
    head.writeUInt16BE(seg.length + 2, 2);
    writeFileSync(join(root, 'icc.jpg'), Buffer.concat([b.subarray(0, start), head, seg, b.subarray(start + 2 + len)]));
    const v = ctx.files.importPath(join(root, 'icc.jpg'));
    const ins = await inspectFile(ctx, v.artifactId, false);
    expect(JSON.stringify((ins.retainedByPolicy as any).iccProfileInspection)).toMatch(/not in the known-profile list/);
    expect(JSON.stringify(ins)).not.toContain('Jane Fixture'); // names only by default
    const res = await run(ctx, v.artifactId);
    expect(res.verdict, JSON.stringify(res.verification.residual)).toBe('verified_for_policy'); // targeted fields gone...
    expect(res.verification.retainedFindings.map((f) => f.category)).toContain('icc'); // ...but the profile text is reported
    expect(res.verification.checks.find((c) => c.name === 'icc_profile_unchanged')!.ok).toBe(true); // rendering preserved
    expect(res.summary).toMatch(/not a statement that the file contains no identifying information/);
    // a synthetic profile that only CLAIMS a standard name ("sRGB IEC61966-2.1"): not trusted
    const std = await run(ctx, ctx.files.importPath(makeJpeg(root)).artifactId);
    expect(std.verification.retainedFindings.map((f) => f.name).join(' ')).toMatch(/claims a standard name/);
    expect(std.verification.inspectionGaps).toEqual([]);
    expect(std.verification.checks.find((c) => c.name === 'retained_exif_orientation_only')!.ok).toBe(true);
  });

  it('an unparseable ICC profile is an inspection gap, not silently trusted', async () => {
    const { ctx, root } = setup();
    const b = readFileSync(makeJpeg(root));
    const i = b.indexOf(FAKE_ICC);
    const broken = Buffer.from(b);
    broken.write('XXXX', i + 36, 'latin1'); // break the acsp signature (same length)
    writeFileSync(join(root, 'badicc.jpg'), broken);
    const res = await run(ctx, ctx.files.importPath(join(root, 'badicc.jpg')).artifactId);
    expect(res.verification.inspectionGaps.join(' ')).toMatch(/ICC profile could not be parsed/);
  });
});
