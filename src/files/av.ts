/**
 * Audio/video policy `av_container_tags` (MP3, FLAC, WAV, M4A, MP4, MOV), via
 * ffmpeg STREAM COPY (no re-encoding).
 *
 * Removed: global container tags (title, artist, comment, GPS location ©xyz /
 * ISO6709, make/model/software, dates, encoder, ...), per-stream tags (handler
 * names, encoder, creation_time), creation timestamps (bitexact muxing writes 0),
 * WAV LIST-INFO/bext/iXML chunks, ID3v1 tags.
 * Kept (content / playback): every audio, video and subtitle stream byte-for-byte,
 * stream language codes, dispositions (default, forced, attached_pic artwork),
 * rotation/display matrix, chapters INCLUDING their titles.
 * Needs a decision: data streams other than the chapter text track (timecode,
 * GoPro/drone telemetry which may contain GPS): refused unless dropDataStreams.
 * Embedded artwork is kept as-is and may contain its own metadata (not processed).
 *
 * Verification: ffprobe (tags, streams, chapters, rotation, durations) and the
 * ffmpeg streamhash muxer (per-stream packet hashes identical) are the same
 * project as the writer (sameEngine: true); the byte scan for source tag values
 * and container signatures, the WAV RIFF walk and the FLAC STREAMINFO MD5 are
 * independent of ffmpeg.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { RbaError } from '../core/errors.js';
import { detectFormat, type FileFormat } from './formats.js';
import { inspectImage } from './images.js';
import { decide, type Check, type Handler, type HandlerEnv, type VerifyReport } from './media.js';

const DEMUX: Record<string, string> = { mp3: 'mp3', flac: 'flac', wav: 'wav', m4a: 'mov', mp4: 'mov', mov: 'mov' };
const MUX: Record<string, string> = { mp3: 'mp3', flac: 'flac', wav: 'wav', m4a: 'ipod', mp4: 'mp4', mov: 'mov' };
/** Technical tags that are not identifying (container brand info, default handler names, language). */
const TECHNICAL_GLOBAL = new Set(['major_brand', 'minor_version', 'compatible_brands']);
const DEFAULT_HANDLERS = new Set(['VideoHandler', 'SoundHandler', 'SubtitleHandler', 'DataHandler', 'TimeCodeHandler']);
const PIC_TYPES = ['Other', 'Cover (front)', 'Cover (back)', 'Media (e.g. label side of CD)', 'Leaflet page', 'Artist/performer', 'Band/Orchestra'];

interface Stream {
  index: number;
  codec_type: string;
  codec_name?: string;
  codec_tag_string?: string;
  duration?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}
interface Probe {
  streams: Stream[];
  format: { format_name?: string; duration?: string; tags?: Record<string, string> };
  chapters: Array<{ start: number; end: number; time_base: string; start_time?: string; end_time?: string; tags?: Record<string, string> }>;
}

function fmtOf(b: Buffer): FileFormat {
  return detectFormat(b.subarray(0, 65536)).format;
}

async function probe(path: string, format: FileFormat, env: HandlerEnv): Promise<Probe> {
  const r = await env.run(
    'ffprobe',
    ['-v', 'error', '-protocol_whitelist', 'file', '-f', DEMUX[format]!, '-show_format', '-show_streams', '-show_chapters', '-of', 'json', `file:${path}`],
    { timeoutMs: env.timeoutMs, signal: env.signal },
  );
  const j = JSON.parse(r.stdout.toString('utf8')) as Probe;
  return { streams: j.streams ?? [], format: j.format ?? {}, chapters: j.chapters ?? [] };
}

/** QuickTime chapter text track (rebuilt by the muxer from the chapter list). */
const isChapterTrack = (s: Stream, p: Probe) => s.codec_type === 'data' && s.codec_tag_string === 'text' && p.chapters.length > 0;
const isDataStream = (s: Stream, p: Probe) => s.codec_type === 'data' && !isChapterTrack(s, p);
const rotation = (s: Stream) => s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0;

type Cat = 'gps' | 'author' | 'timestamps' | 'device' | 'software' | 'comments' | 'other';
function categoryOf(key: string): Cat {
  const k = key.toLowerCase();
  if (/location|iso6709|gps|xyz/.test(k)) return 'gps';
  if (/artist|author|composer|copyright|publisher|performer|encoded_by|album_artist|owner|creator/.test(k)) return 'author';
  if (/creation_time|date|year|time/.test(k)) return 'timestamps';
  if (/make|model|serial|camera|device|vendor/.test(k)) return 'device';
  if (/encoder|software|tool|handler/.test(k)) return 'software';
  if (/comment|description|title|album|lyrics|synopsis|keywords|genre|show|episode/.test(k)) return 'comments';
  return 'other';
}

interface TagHit {
  where: string;
  key: string;
  category: Cat;
  value: string;
}

function identifyingTags(p: Probe): TagHit[] {
  const out: TagHit[] = [];
  for (const [k, v] of Object.entries(p.format.tags ?? {})) if (!TECHNICAL_GLOBAL.has(k)) out.push({ where: 'container', key: k, category: categoryOf(k), value: v });
  for (const s of p.streams) {
    if (isChapterTrack(s, p)) continue;
    for (const [k, v] of Object.entries(s.tags ?? {})) {
      if (k === 'language') continue;
      if (k === 'handler_name' && DEFAULT_HANDLERS.has(v)) continue;
      // Codec vendor code: blank, or the muxer's own tool code ("FFMP" written by ffmpeg's
      // MOV muxer, replacing any camera vendor code). Not personal; disclosed in verification.
      if (k === 'vendor_id' && (v === '[0][0][0][0]' || v === 'FFMP')) continue;
      if (k === 'comment' && s.disposition?.attached_pic && PIC_TYPES.includes(v)) continue; // picture type label
      out.push({ where: `stream ${s.index} (${s.codec_type})`, key: k, category: categoryOf(k), value: v });
    }
  }
  return out;
}

// ---------------------------------------------------------------- independent container walks

/** WAV/RIFF top-level chunk ids. */
function riffChunks(b: Buffer): string[] {
  if (b.toString('latin1', 0, 4) !== 'RIFF') return [];
  const ids: string[] = [];
  let p = 12;
  while (p + 8 <= b.length && ids.length < 1000) {
    const id = b.toString('latin1', p, p + 4);
    const len = b.readUInt32LE(p + 4);
    ids.push(id === 'LIST' && p + 12 <= b.length ? `LIST:${b.toString('latin1', p + 8, p + 12)}` : id);
    p += 8 + len + (len % 2);
  }
  return ids;
}

/** FLAC STREAMINFO MD5 of the decoded audio (bytes 18..33 of the STREAMINFO block). */
function flacMd5(b: Buffer): string | null {
  if (b.toString('latin1', 0, 4) !== 'fLaC' || b.length < 8 + 34) return null;
  if ((b[4]! & 0x7f) !== 0) return null; // first block must be STREAMINFO
  return b.subarray(8 + 18, 8 + 34).toString('hex');
}

/** FLAC metadata block types present (4 = VORBIS_COMMENT, 6 = PICTURE, 2 = APPLICATION). */
function flacBlocks(b: Buffer): number[] {
  if (b.toString('latin1', 0, 4) !== 'fLaC') return [];
  const types: number[] = [];
  let p = 4;
  for (;;) {
    if (p + 4 > b.length) break;
    const last = (b[p]! & 0x80) !== 0;
    types.push(b[p]! & 0x7f);
    const len = b.readUIntBE(p + 1, 3);
    p += 4 + len;
    if (last || types.length > 128) break;
  }
  return types;
}

function escapeFfmeta(s: string): string {
  return s.replace(/[=;#\\\n]/g, (c) => (c === '\n' ? '\\\n' : `\\${c}`));
}

// ---------------------------------------------------------------- handler

export const avHandler: Handler = {
  async inspect(path, detailed, env) {
    const b = readFileSync(path);
    const f = fmtOf(b);
    const p = await probe(path, f, env);
    const tags = identifyingTags(p);
    const counts: Record<string, number> = {};
    for (const t of tags) counts[t.category] = (counts[t.category] ?? 0) + 1;
    const extra: Record<string, unknown> = {};
    if (f === 'wav') extra.riffChunks = riffChunks(b);
    if (f === 'flac') extra.flacMetadataBlocks = flacBlocks(b);
    if (f === 'mp3') extra.id3v1 = b.length > 128 && b.toString('latin1', b.length - 128, b.length - 125) === 'TAG';
    return {
      format: f,
      durationSecs: p.format.duration ? Number(p.format.duration) : null,
      streams: p.streams.filter((s) => !isChapterTrack(s, p)).map((s) => ({ index: s.index, type: s.codec_type, codec: s.codec_name, language: s.tags?.language, attachedPicture: !!s.disposition?.attached_pic, rotation: rotation(s) || undefined })),
      identifyingFieldCounts: counts,
      identifyingFieldNames: [...new Set(tags.map((t) => `${t.where}:${t.key}`))],
      ...(detailed ? { detail: tags } : {}),
      retainedByPolicy: {
        chapters: p.chapters.length,
        chapterTitles: detailed ? p.chapters.map((c) => c.tags?.title ?? '') : p.chapters.filter((c) => c.tags?.title).length,
        artwork: p.streams.filter((s) => s.disposition?.attached_pic).length,
        subtitles: p.streams.filter((s) => s.codec_type === 'subtitle').length,
      },
      needsDecision: p.streams.filter((s) => isDataStream(s, p)).map((s) => ({ stream: s.index, codecTag: s.codec_tag_string, note: 'data stream (timecode/telemetry may contain GPS); media_sanitize needs dropDataStreams: true' })),
      ...extra,
    };
  },

  async sanitize(src, out, opts, env) {
    const b = readFileSync(src);
    const f = fmtOf(b);
    if (!MUX[f]) throw new RbaError('invalid_input', `unsupported audio/video format ${f}`, { verdict: 'unsupported' });
    const p = await probe(src, f, env);
    const data = p.streams.filter((s) => isDataStream(s, p));
    if (data.length && !opts.dropDataStreams) {
      throw new RbaError('invalid_input', `the file has ${data.length} data stream(s) (${data.map((s) => s.codec_tag_string).join(', ')}): timecode or telemetry, which can contain GPS. They cannot be cleaned in place. Re-run with dropDataStreams: true to remove them (the audio/video/subtitle streams are kept).`, {
        needsDecision: 'dropDataStreams',
        streams: data.map((s) => ({ index: s.index, codecTag: s.codec_tag_string })),
      });
    }
    const keep = p.streams.filter((s) => !isChapterTrack(s, p) && !isDataStream(s, p));
    if (keep.length === 0) throw new RbaError('invalid_input', 'no audio/video streams found');
    const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-f', DEMUX[f]!, '-i', `file:${src}`];
    let chapFile: string | null = null;
    if (p.chapters.length) {
      // Chapters (with titles) come from a chapters-only metadata file: no global tags.
      chapFile = env.tmp('ffmeta');
      const lines = [';FFMETADATA1'];
      for (const c of p.chapters) {
        lines.push('[CHAPTER]', `TIMEBASE=${c.time_base}`, `START=${c.start}`, `END=${c.end}`);
        if (c.tags?.title) lines.push(`title=${escapeFfmeta(c.tags.title)}`);
      }
      writeFileSync(chapFile, lines.join('\n') + '\n', { mode: 0o600 });
      args.push('-f', 'ffmetadata', '-i', `file:${chapFile}`);
    }
    keep.forEach((s) => args.push('-map', `0:${s.index}`));
    args.push('-c', 'copy', '-map_metadata', chapFile ? '1' : '-1', '-map_metadata:s', '-1', '-map_chapters', chapFile ? '1' : '-1');
    args.push('-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact');
    keep.forEach((s, i) => {
      const lang = s.tags?.language;
      if (lang && lang !== 'und') args.push(`-metadata:s:${i}`, `language=${lang}`);
      if (s.disposition?.attached_pic && s.tags?.comment && PIC_TYPES.includes(s.tags.comment)) args.push(`-metadata:s:${i}`, `comment=${s.tags.comment}`);
    });
    if (f === 'mp3') args.push('-write_id3v1', '0', ...(keep.some((s) => s.disposition?.attached_pic) ? ['-id3v2_version', '3'] : []));
    if (f === 'wav') args.push('-write_bext', '0');
    args.push('-f', MUX[f]!, `file:${out}`);
    try {
      await env.run('ffmpeg', args, { timeoutMs: env.timeoutMs, signal: env.signal });
    } finally {
      if (chapFile) {
        const { rmSync } = await import('node:fs');
        rmSync(chapFile, { force: true });
      }
    }
    const tags = identifyingTags(p);
    const removed: Record<string, number> = {};
    for (const t of tags) removed[t.category] = (removed[t.category] ?? 0) + 1;
    if (data.length) removed.dataStreams = data.length;
    const art = keep.filter((s) => s.disposition?.attached_pic).length;
    return {
      policy: 'av_container_tags',
      removed,
      retained: [
        `${keep.length} stream(s) copied without re-encoding`,
        'stream language codes, dispositions and rotation',
        ...(p.chapters.length ? [`${p.chapters.length} chapter(s) with titles`] : []),
        ...(art ? [`${art} embedded artwork image(s), unprocessed (may contain their own metadata)`] : []),
      ],
      notes: [
        'Muxers may write a short tool/vendor identifier (e.g. "Lavf" in FLAC vendor strings or MP3 Xing headers); reported in verification, not personal.',
        ...(data.length ? [`${data.length} data stream(s) dropped (explicitly allowed).`] : []),
      ],
      tools: {},
    };
  },

  async verify(src, out, env) {
    const sb = readFileSync(src);
    const ob = readFileSync(out);
    const f = fmtOf(sb);
    const checks: Check[] = [];
    const residual: VerifyReport['residual'] = [];
    const limitations: string[] = [];
    const sp = await probe(src, f, env);
    let op: Probe | null = null;
    const of = fmtOf(ob);
    try {
      op = await probe(out, of === 'unknown' ? f : of, env);
      checks.push({ name: 'output_parses', ok: true, method: 'ffprobe' });
    } catch (e) {
      checks.push({ name: 'output_parses', ok: false, detail: (e as Error).message.slice(0, 200), method: 'ffprobe' });
    }
    checks.push({ name: 'format_unchanged', ok: of === f, detail: of, method: 'magic-bytes' });
    if (op) {
      const sKeep = sp.streams.filter((s) => !isChapterTrack(s, sp) && !isDataStream(s, sp));
      const oKeep = op.streams.filter((s) => !isChapterTrack(s, op!));
      const sig = (ss: Stream[]) => ss.map((s) => `${s.codec_type}:${s.codec_name}:${s.tags?.language ?? 'und'}:${s.disposition?.attached_pic ? 'pic' : ''}:${rotation(s)}`).join('|');
      checks.push({ name: 'streams_equal', ok: sig(sKeep) === sig(oKeep), detail: sig(oKeep), method: 'ffprobe' });
      const dur = (p: Probe) => Number(p.format.duration ?? NaN);
      checks.push({ name: 'duration_equal', ok: Math.abs(dur(sp) - dur(op)) < 0.05 || (Number.isNaN(dur(sp)) && Number.isNaN(dur(op))), detail: `${dur(op)} s`, method: 'ffprobe' });
      const ch = (p: Probe) => p.chapters.map((c) => `${c.start_time}-${c.end_time}:${c.tags?.title ?? ''}`).join('|');
      checks.push({ name: 'chapters_equal', ok: ch(sp) === ch(op), detail: `${op.chapters.length} chapter(s)`, method: 'ffprobe' });
      // Packet identity per stream (stream copy => identical packet payloads).
      try {
        const hash = async (path: string, fmt: FileFormat, idx: number[]) => {
          const args = ['-hide_banner', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file', '-f', DEMUX[fmt]!, '-i', `file:${path}`];
          idx.forEach((i) => args.push('-map', `0:${i}`));
          args.push('-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-');
          return (await env.run('ffmpeg', args, { timeoutMs: env.timeoutMs, signal: env.signal })).stdout.toString('utf8').trim().split('\n').map((l) => l.split('=').pop()).join(',');
        };
        const a = await hash(src, f, sKeep.map((s) => s.index));
        const b2 = await hash(out, of === 'unknown' ? f : of, oKeep.map((s) => s.index));
        checks.push({ name: 'packets_identical', ok: a === b2, detail: a === b2 ? 'per-stream packet sha256 equal' : 'packet data differs', method: 'ffmpeg-streamhash' });
      } catch (e) {
        if (e instanceof RbaError && e.code === 'cancelled') throw e;
        checks.push({ name: 'packets_identical', ok: false, detail: (e as Error).message.slice(0, 200), method: 'ffmpeg-streamhash' });
      }
      for (const t of identifyingTags(op)) residual.push({ category: t.category, name: t.key, where: t.where });
      const created = [op.format.tags?.creation_time, ...op.streams.map((s) => s.tags?.creation_time)].filter(Boolean);
      if (created.length) residual.push({ category: 'timestamps', name: 'creation_time', where: 'ffprobe' });
      checks.push({ name: 'tags_absent_ffprobe', ok: residual.length === 0, method: 'ffprobe' });
    }
    // Independent byte/structure checks.
    const scanBefore = residual.length;
    const latin = ob.toString('latin1');
    for (const [sigS, cat, name] of [
      ['©xyz', 'gps', '©xyz location atom'],
      ['ISO6709', 'gps', 'ISO6709 location key'],
      ['com.apple.quicktime.location', 'gps', 'QuickTime location key'],
      ['com.apple.quicktime.make', 'device', 'QuickTime make'],
      ['com.apple.quicktime.model', 'device', 'QuickTime model'],
      ['com.apple.quicktime.software', 'software', 'QuickTime software'],
    ] as const) {
      if (latin.includes(sigS)) residual.push({ category: cat, name, where: 'byte-scan' });
    }
    const retainedValues = new Set([...sp.chapters.map((c) => c.tags?.title ?? ''), ...sp.streams.map((s) => s.tags?.language ?? '')]);
    for (const t of identifyingTags(sp)) {
      const v = t.value.trim();
      if (v.length < 4 || retainedValues.has(v) || /^\d{4}-\d\d-\d\dT/.test(v) || DEFAULT_HANDLERS.has(v)) continue;
      if (ob.includes(Buffer.from(v, 'latin1')) || ob.includes(Buffer.from(v, 'utf16le')) || ob.includes(Buffer.from(v, 'utf16le').swap16())) residual.push({ category: t.category, name: `source value of ${t.key}`, where: 'byte-scan' });
    }
    if (f === 'wav') {
      const ids = riffChunks(ob);
      for (const id of ids) if (['LIST:INFO', 'bext', 'iXML', 'id3 ', 'ID3 ', '_PMX', 'cart'].includes(id)) residual.push({ category: 'other', name: `RIFF chunk ${id}`, where: 'riff-walk' });
      checks.push({ name: 'riff_chunks_clean', ok: !residual.some((r) => r.where === 'riff-walk'), detail: ids.join(','), method: 'riff-walk' });
    }
    // Embedded artwork is kept unmodified: inspect it, and report identifying fields as residual.
    const artGaps: string[] = [];
    if (op) {
      for (const s of op.streams.filter((x) => x.disposition?.attached_pic)) {
        try {
          const pic = (await env.run('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file', '-f', DEMUX[of === 'unknown' ? f : of]!, '-i', `file:${out}`, '-map', `0:${s.index}`, '-c', 'copy', '-f', 'image2pipe', '-'], { timeoutMs: env.timeoutMs, signal: env.signal, maxBuffer: 32 * 1024 * 1024 })).stdout;
          const kind = pic[0] === 0xff && pic[1] === 0xd8 ? 'jpeg' : pic[0] === 0x89 && pic[1] === 0x50 ? 'png' : pic.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : null;
          if (!kind) {
            artGaps.push(`artwork in stream ${s.index} is in a format the image inspector does not support; its metadata was not inspected`);
            continue;
          }
          for (const fl of inspectImage(kind, pic, false).fields) residual.push({ category: `artwork:${fl.category}`, name: fl.name, where: `artwork stream ${s.index}` });
        } catch (e) {
          if (e instanceof RbaError && e.code === 'cancelled') throw e;
          artGaps.push(`artwork in stream ${s.index} could not be extracted; its metadata was not inspected`);
        }
      }
    }
    if (f === 'mp3' && ob.length > 128 && ob.toString('latin1', ob.length - 128, ob.length - 125) === 'TAG') residual.push({ category: 'other', name: 'ID3v1 tag', where: 'byte-scan' });
    if (f === 'flac') {
      const [a, b2] = [flacMd5(sb), flacMd5(ob)];
      checks.push({ name: 'flac_streaminfo_md5_equal', ok: a !== null && a === b2, detail: 'decoded-audio MD5 from STREAMINFO', method: 'flac-streaminfo' });
    }
    checks.push({ name: 'byte_scan_clean', ok: residual.length === scanBefore, method: 'byte-signature-scan' });
    if (latin.includes('Lavf')) limitations.push('A muxer tool identifier ("Lavf…") is present (tool string, not personal).');
    if (op?.streams.some((s) => s.tags?.vendor_id === 'FFMP')) limitations.push('The MOV muxer writes its own codec vendor code "FFMP" (tool identifier) in place of the source\'s vendor code.');
    limitations.push('ffprobe and the ffmpeg streamhash check are the same project as the writer (ffmpeg); the byte scan, RIFF walk and FLAC STREAMINFO check are independent.');
    if (sp.streams.some((s) => s.disposition?.attached_pic)) limitations.push('Embedded artwork is kept unmodified; it was inspected, and any identifying metadata in it is listed as residual (clean the image separately and re-embed it if needed).');
    const retained = ['audio/video/subtitle streams', 'language codes', 'rotation', ...(sp.chapters.length ? ['chapter titles'] : []), ...(sp.streams.some((s) => s.disposition?.attached_pic) ? ['artwork'] : [])];
    const retainedFindings: VerifyReport['retainedFindings'] = [];
    const inspectionGaps: string[] = [...artGaps];
    if (op) {
      const titled = op.chapters.filter((c) => (c.tags?.title ?? '').trim()).length;
      if (titled) retainedFindings.push({ category: 'chapter-titles', name: `${titled} chapter title(s) (free text)`, where: 'chapters', count: titled });
      const art = op.streams.filter((s) => s.disposition?.attached_pic).length;
      if (art) retainedFindings.push({ category: 'artwork', name: `${art} embedded artwork image(s) (picture content kept)`, where: 'attached pictures', count: art });
      const subs = op.streams.filter((s) => s.codec_type === 'subtitle').length;
      if (subs) inspectionGaps.push(`text of ${subs} subtitle stream(s) was not inspected`);
    }
    const structural = ['output_parses', 'format_unchanged', 'streams_equal', 'duration_equal', 'chapters_equal', 'packets_identical', 'flac_streaminfo_md5_equal'];
    return { verdict: decide(checks, residual, structural), policy: 'av_container_tags', methods: [...new Set(checks.map((c) => c.method))], sameEngine: true, checks, residual, retained, retainedFindings, inspectionGaps, limitations };
  },
};
