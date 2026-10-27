import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { avHandler } from '../../src/files/av.js';
import { which } from '../../src/files/exec.js';
import { detectFormat } from '../../src/files/formats.js';
import { defaultEnv } from '../../src/files/media.js';
import { execFileSync as exec } from 'node:child_process';
import { defaultRunner } from '../../src/files/exec.js';
import { inspectFile, sanitizeFile, serviceHooks } from '../../src/files/service.js';
import { testCtx } from '../helpers/ctx.js';
import { AV_SECRETS, HAVE_FFMPEG, ffmpeg, makeFlac, makeM4a, makeMp3, makeVideo, makeWav } from '../fixtures/media.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'rba-av-'));
  return { ctx: testCtx({ RBA_IMPORT_ROOTS: root }), root };
}
const run = (ctx: ReturnType<typeof setup>['ctx'], id: string, opts = {}) => sanitizeFile(ctx, 'test', id, opts, new AbortController().signal);
const probe = (p: string) => JSON.parse(execFileSync(which('ffprobe')!, ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', p]).toString());
const SECRETS = [AV_SECRETS.artist, AV_SECRETS.title, AV_SECRETS.comment, AV_SECRETS.handler, AV_SECRETS.location, 'Fixture Recorder', 'Fixture Originator'];

describe.skipIf(!HAVE_FFMPEG)('audio/video: container tags policy', () => {
  const cases = [
    ['mp4', (d: string) => makeVideo(d, 'mp4')],
    ['mov', (d: string) => makeVideo(d, 'mov')],
    ['m4a', makeM4a],
    ['mp3', makeMp3],
    ['flac', makeFlac],
    ['wav', makeWav],
  ] as const;
  for (const [fmt, make] of cases) {
    it(`${fmt}: tags removed, streams/packets/duration/chapters/language/rotation/artwork kept, original untouched`, async () => {
      const { ctx, root } = setup();
      const path = make(root);
      const original = readFileSync(path);
      const v = ctx.files.importPath(path);
      expect(v.format).toBe(fmt);
      const ins = await inspectFile(ctx, v.artifactId, false);
      expect(Object.keys(ins.identifyingFieldCounts as object).length).toBeGreaterThan(0);
      for (const s of SECRETS) expect(JSON.stringify(ins), s).not.toContain(s);
      const res = await run(ctx, v.artifactId);
      expect(res.verdict, JSON.stringify(res.verification, null, 1)).toBe('verified_for_policy');
      const outPath = ctx.files.absPath(ctx.files.row(res.output!.artifactId));
      const out = readFileSync(outPath);
      expect(detectFormat(out.subarray(0, 65536)).format).toBe(fmt);
      for (const s of SECRETS) expect(out.includes(Buffer.from(s, 'latin1')), s).toBe(false);
      const ckeys = Object.fromEntries(res.verification.checks.map((c) => [c.name, c.ok]));
      expect(ckeys).toMatchObject({ output_parses: true, streams_equal: true, duration_equal: true, chapters_equal: true, packets_identical: true, source_unchanged: true });
      expect(res.verification.sameEngine).toBe(true);
      const sp = probe(path);
      const op = probe(outPath);
      expect(op.format.tags?.creation_time).toBeUndefined();
      for (const s of op.streams) expect(s.tags?.creation_time).toBeUndefined();
      expect(op.streams.filter((s: any) => s.codec_type !== 'data').length).toBe(sp.streams.filter((s: any) => s.codec_type !== 'data').length);
      if (fmt === 'mp4' || fmt === 'mov') {
        // language is kept exactly (ffmpeg's MOV writer does not record "deu" in the fixture source)
        const lang = (p: any) => p.streams.find((s: any) => s.codec_type === 'audio').tags?.language;
        expect(lang(op)).toBe(lang(sp));
        if (fmt === 'mp4') expect(lang(op)).toBe('deu');
        expect(JSON.stringify(op.streams[0].side_data_list ?? [])).toMatch(/"rotation":-?90/);
        expect(op.streams.some((s: any) => s.codec_type === 'subtitle')).toBe(true);
      }
      if (fmt === 'mp4' || fmt === 'mov' || fmt === 'm4a') expect(op.chapters.map((c: any) => c.tags?.title)).toEqual([AV_SECRETS.chapter, 'Second Chapter']);
      // kept by design, but reported: chapter titles, artwork; subtitles are an inspection gap
      const cats = res.verification.retainedFindings.map((f) => f.category);
      if (fmt === 'mp4' || fmt === 'mov' || fmt === 'm4a') expect(cats).toContain('chapter-titles');
      if (fmt === 'mp3' || fmt === 'flac') expect(cats).toContain('artwork');
      if (fmt === 'mp4' || fmt === 'mov') expect(res.verification.inspectionGaps.join(' ')).toMatch(/subtitle/);
      if (fmt === 'wav') expect(res.verification.retainedFindings).toEqual([]);
      if (fmt === 'mp3' || fmt === 'flac') expect(op.streams.some((s: any) => s.disposition?.attached_pic === 1)).toBe(true);
      if (fmt === 'mp3') expect(out.subarray(out.length - 128, out.length - 125).toString()).not.toBe('TAG');
      if (fmt === 'flac') expect(ckeys.flac_streaminfo_md5_equal).toBe(true);
      if (fmt === 'wav') expect(ckeys.riff_chunks_clean).toBe(true);
      expect(readFileSync(path).equals(original)).toBe(true);
      expect(readdirSync(ctx.files.tmpDir)).toEqual([]);
    });
  }

  it('artwork carrying EXIF makes the verdict partial (it is kept unmodified, but not hidden)', async () => {
    const { ctx, root } = setup();
    const { makeJpeg } = await import('../fixtures/media.js');
    const cover = makeJpeg(root);
    const p = join(root, 'art.mp3');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', '-i', cover, '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-id3v2_version', '3', p]);
    const v = ctx.files.importPath(p);
    const res = await run(ctx, v.artifactId);
    expect(res.verdict).toBe('partial');
    expect(res.verification.residual.some((r) => r.category.startsWith('artwork:gps'))).toBe(true);
  });

  it('data streams (timecode/telemetry) need an explicit decision; dropping them is reported', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(makeVideo(root, 'mp4', { timecode: true }));
    const ins = await inspectFile(ctx, v.artifactId, false);
    expect((ins.needsDecision as unknown[]).length).toBeGreaterThan(0);
    await expect(run(ctx, v.artifactId)).rejects.toMatchObject({ details: { needsDecision: 'dropDataStreams' } });
    const ok = await run(ctx, v.artifactId, { dropDataStreams: true });
    expect(ok.verdict).toBe('verified_for_policy');
    expect(JSON.stringify(ok.sanitize)).toMatch(/data stream\(s\) dropped/);
  });

  it('cancelling a sanitize job kills the REAL running ffmpeg process and cleans up', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(makeWav(root));
    // Argument unique to THIS run: pgrep must not see the same test's ffmpeg from a
    // concurrent run (another worktree or vitest instance), or "no process left" fails.
    const marker = `rba_cancel_marker=${randomBytes(8).toString('hex')}`;
    serviceHooks.run = (bin, args, o) => (bin === 'ffmpeg' && args.includes('-f') && args[args.length - 1]!.startsWith('file:') ? defaultRunner('ffmpeg', ['-v', 'error', '-nostdin', '-re', '-f', 'lavfi', '-i', 'testsrc=size=97x53:rate=7', '-t', '120', '-metadata', marker, '-f', 'null', '-'], o) : defaultRunner(bin, args, o));
    try {
      const job = ctx.jobs.create('sanitize', { artifactId: v.artifactId });
      ctx.jobs.start(job, (signal) => sanitizeFile(ctx, job, v.artifactId, {}, signal).then(() => undefined));
      for (let i = 0; i < 50; i++) {
        let running = '';
        try {
          running = exec('pgrep', ['-f', marker]).toString();
        } catch {
          running = '';
        }
        if (running.trim()) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(exec('pgrep', ['-f', marker]).toString().trim()).not.toBe('');
      const t0 = Date.now();
      ctx.jobs.cancel(job);
      const done = await ctx.jobs.settle(job);
      expect(done.status).toBe('cancelled');
      expect(Date.now() - t0).toBeLessThan(2000);
      await new Promise((r) => setTimeout(r, 200));
      expect(() => exec('pgrep', ['-f', marker])).toThrow(); // no process left (pgrep exits 1)
      expect(readdirSync(ctx.files.tmpDir)).toEqual([]);
      expect(ctx.files.row(v.artifactId).locked_by).toBeNull();
    } finally {
      serviceHooks.run = undefined;
    }
  });

  it('the verifier is not vacuous: re-encoded output fails, a re-added tag is partial', async () => {
    const { ctx, root } = setup();
    const src = makeVideo(root, 'mp4');
    const env = defaultEnv({ timeoutMs: 60_000, maxImagePixels: 1e8, tmp: (e) => join(root, `t.${e}`) });
    const reenc = join(root, 'reenc.mp4');
    ffmpeg(['-i', src, '-map', '0:v', '-map', '0:a', '-map', '0:s', '-map_chapters', '0', '-c:v', 'libx264', '-crf', '40', '-c:a', 'aac', '-c:s', 'copy', '-map_metadata', '-1', '-fflags', '+bitexact', '-metadata:s:a:0', 'language=deu', reenc]);
    expect((await avHandler.verify(src, reenc, env)).verdict).toBe('failed');
    const tagged = join(root, 'tagged.mp4');
    const v = ctx.files.importPath(src);
    const res = await run(ctx, v.artifactId);
    ffmpeg(['-i', ctx.files.absPath(ctx.files.row(res.output!.artifactId)), '-map', '0:v', '-map', '0:a', '-map', '0:s', '-c', 'copy', '-map_chapters', '0', '-metadata', `artist=${AV_SECRETS.artist}`, '-metadata:s:a:0', 'language=deu', '-fflags', '+bitexact', tagged]);
    const part = await avHandler.verify(src, tagged, env);
    expect(part.verdict).toBe('partial');
    expect(part.residual.some((r) => r.name === 'artist')).toBe(true);
  });
});
