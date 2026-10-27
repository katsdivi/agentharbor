/**
 * Synthetic media with KNOWN metadata, generated at test time (ffmpeg + the
 * plugin's own container builders). No real personal data: all values are
 * fixture strings such as "Jane Fixture".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { buildExif, pngChunk } from '../../src/files/images.js';
import { which } from '../../src/files/exec.js';

export const HAVE_FFMPEG = !!which('ffmpeg') && !!which('ffprobe');
export const HAVE_POPPLER = ['pdfinfo', 'pdftotext', 'pdftocairo', 'pdfsig', 'pdfdetach'].every((t) => !!which(t));

export const SECRET_VALUES = {
  make: 'FixtureCam',
  model: 'FC-9000 Fixture',
  artist: 'Jane Fixture',
  software: 'FixtureEditor 1.0',
  datetime: '2021:05:06 07:08:09',
  comment: 'shot at Fixture Street 42',
  xmpCreator: 'Jane XMP Fixture',
};

export const ffmpeg = (args: string[]) => execFileSync(which('ffmpeg')!, ['-hide_banner', '-v', 'error', '-y', ...args]);

function jpegSeg(marker: number, payload: Buffer): Buffer {
  const h = Buffer.from([0xff, marker, 0, 0]);
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}

const xmpPacket = (creator: string) =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="${SECRET_VALUES.software}" xmp:CreateDate="2021-05-06T07:08:09"><dc:creator><rdf:Seq><rdf:li>${creator}</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

const exifAll = (orientation: number) =>
  buildExif({
    ascii: { 0x010f: SECRET_VALUES.make, 0x0110: SECRET_VALUES.model, 0x013b: SECRET_VALUES.artist, 0x0131: SECRET_VALUES.software, 0x0132: SECRET_VALUES.datetime, 0x010e: SECRET_VALUES.comment },
    orientation,
    gps: true,
    thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });

/** Minimal valid ICC v2 profile with desc / cprt (and optional dmnd/dmdd) text tags. */
export function makeIcc(o: { desc: string; cprt?: string; dmnd?: string; dmdd?: string; manufacturer?: string; model?: string }): Buffer {
  const descTag = (text: string) => {
    const ascii = Buffer.from(`${text}\0`, 'latin1');
    const head = Buffer.alloc(12);
    head.write('desc', 0, 'latin1');
    head.writeUInt32BE(ascii.length, 8);
    return Buffer.concat([head, ascii, Buffer.alloc(4 + 4 + 2 + 1 + 67)]);
  };
  const textTag = (text: string) => Buffer.concat([Buffer.from('text\0\0\0\0', 'latin1'), Buffer.from(`${text}\0`, 'latin1')]);
  const tags: Array<[string, Buffer]> = [['desc', descTag(o.desc)], ['cprt', textTag(o.cprt ?? 'Copyright International Color Consortium')]];
  if (o.dmnd) tags.push(['dmnd', descTag(o.dmnd)]);
  if (o.dmdd) tags.push(['dmdd', descTag(o.dmdd)]);
  const tableLen = 4 + tags.length * 12;
  let off = 128 + tableLen;
  const table = Buffer.alloc(tableLen);
  table.writeUInt32BE(tags.length, 0);
  const bodies: Buffer[] = [];
  tags.forEach(([sig, body], i) => {
    const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
    table.write(sig, 4 + i * 12, 'latin1');
    table.writeUInt32BE(off, 8 + i * 12);
    table.writeUInt32BE(body.length, 12 + i * 12);
    bodies.push(padded);
    off += padded.length;
  });
  const header = Buffer.alloc(128);
  header.writeUInt32BE(off, 0);
  header.writeUInt32BE(0x02100000, 8);
  header.write('mntrRGB XYZ ', 12, 'latin1');
  header.write('acsp', 36, 'latin1');
  if (o.manufacturer) header.write(o.manufacturer.padEnd(4).slice(0, 4), 48, 'latin1');
  if (o.model) header.write(o.model.padEnd(4).slice(0, 4), 52, 'latin1');
  return Buffer.concat([header, table, ...bodies]);
}

/** A standard-looking profile (no identifying text): retained without findings. */
export const FAKE_ICC = makeIcc({ desc: 'sRGB IEC61966-2.1' });
/** A personal/device profile: retained for rendering, reported as findings. */
export const PERSONAL_ICC = makeIcc({ desc: "Jane Fixture's calibrated monitor", dmnd: 'FixtureVendor', dmdd: 'FX-Monitor 27 serial 0042', manufacturer: 'FXV', model: 'M27' });

/** JPEG 64x48 with EXIF(GPS, device, author, time, thumbnail, orientation 6), XMP, IPTC, COM, ICC, MPF and trailing bytes. */
export function makeJpeg(dir: string, o: { trailing?: boolean } = {}): string {
  const base = join(dir, 'base.jpg');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=1', '-frames:v', '1', base]);
  const b = readFileSync(base);
  const segs = [
    jpegSeg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifAll(6)])),
    jpegSeg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(xmpPacket(SECRET_VALUES.xmpCreator))])),
    jpegSeg(0xed, Buffer.from('Photoshop 3.0\0' + '8BIM\x04\x04\0\0\0\0\0\x10' + 'IPTC-Fixture-Byl', 'latin1')),
    jpegSeg(0xfe, Buffer.from(SECRET_VALUES.comment)),
    jpegSeg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), FAKE_ICC])),
    jpegSeg(0xe2, Buffer.from('MPF\0MM\0*\0\0\0\x08\0\0', 'latin1')),
  ];
  const out = Buffer.concat([b.subarray(0, 2), ...segs, b.subarray(2), ...(o.trailing ? [Buffer.from('ftypMOTIONPHOTO-fixture-video-bytes')] : [])]);
  const p = join(dir, 'photo.jpg');
  writeFileSync(p, out);
  return p;
}

/** PNG 40x30 with tEXt Author, iTXt XMP, tIME, eXIf (GPS + orientation 3), iCCP and an unknown private chunk. */
export function makePng(dir: string, size = '40x30'): string {
  const base = join(dir, `base-${size}.png`);
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=1`, '-frames:v', '1', base]);
  const b = readFileSync(base);
  // insert after IHDR (8 sig + 25 IHDR)
  const ihdrEnd = 8 + 25;
  const extra = [
    pngChunk('iCCP', Buffer.concat([Buffer.from('fixture\0\0', 'latin1'), deflateSync(FAKE_ICC)])),
    pngChunk('eXIf', exifAll(3)),
    pngChunk('tEXt', Buffer.from(`Author\0${SECRET_VALUES.artist}`, 'latin1')),
    pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(xmpPacket(SECRET_VALUES.xmpCreator))])),
    pngChunk('tIME', Buffer.from([0x07, 0xe5, 5, 6, 7, 8, 9])),
    pngChunk('prVt', Buffer.from('private-fixture-chunk')),
  ];
  const out = Buffer.concat([b.subarray(0, ihdrEnd), ...extra, b.subarray(ihdrEnd)]);
  const p = join(dir, `image-${size}.png`);
  writeFileSync(p, out);
  return p;
}

/** WebP (1x1 lossless) wrapped in VP8X with ICCP, EXIF (GPS + orientation 8) and XMP. */
export function makeWebp(dir: string): string {
  const simple = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
  const vp8l = simple.subarray(12); // the VP8L chunk incl. header
  const chunk = (cc: string, d: Buffer) => {
    const h = Buffer.alloc(8);
    h.write(cc, 0, 'latin1');
    h.writeUInt32LE(d.length, 4);
    return Buffer.concat([h, d, d.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x20 | 0x08 | 0x04; // ICC, EXIF, XMP
  vp8x.writeUIntLE(0, 4, 3); // width-1
  vp8x.writeUIntLE(0, 7, 3); // height-1
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('ICCP', FAKE_ICC), vp8l, chunk('EXIF', exifAll(8)), chunk('XMP ', Buffer.from(xmpPacket(SECRET_VALUES.xmpCreator)))]);
  const h = Buffer.alloc(12);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(body.length + 4, 4);
  h.write('WEBP', 8, 'latin1');
  const p = join(dir, 'image.webp');
  writeFileSync(p, Buffer.concat([h, body]));
  return p;
}

/** All fixture secret strings (for "not present in output" checks). */
export const ALL_SECRETS = Object.values(SECRET_VALUES);

// ---------------------------------------------------------------- PDF fixtures

import { PDFDocument, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';

export const PDF_SECRETS = {
  author: 'Jane Fixture',
  oldAuthor: 'Old Fixture Author',
  company: 'Fixture Corp Ltd',
  xmpCreator: 'Jane XMP Fixture',
  orphan: 'ORPHAN-FIXTURE-VALUE',
  annotAuthor: 'Annot Author Fixture',
};
export const PDF_BODY_TEXT = 'Synthetic fixture body text';

/**
 * Two-page PDF with Info (incl. custom key), catalog XMP, page PieceInfo, an
 * annotation with /T author, an embedded file and an orphan object. With
 * `incremental`, the saved file gets an appended incremental update whose new
 * Info dict differs (the old value remains recoverable in the source bytes).
 */
export async function makePdf(dir: string, o: { incremental?: boolean; signed?: boolean; encrypted?: boolean; name?: string; body?: string; formValue?: string; jpegWithExif?: Buffer } = {}): Promise<string> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const i of [1, 2]) doc.addPage([300, 200]).drawText(`${o.body ?? PDF_BODY_TEXT} page ${i}`, { x: 20, y: 100, size: 12, font });
  doc.setAuthor(o.incremental ? PDF_SECRETS.oldAuthor : PDF_SECRETS.author);
  doc.setTitle('Fixture Title');
  doc.setSubject('Fixture Subject');
  doc.setKeywords(['fixture', 'keywords']);
  doc.setCreator('FixtureCreator');
  doc.setProducer('FixtureProducer');
  const ctx = doc.context;
  const info = ctx.lookup(ctx.trailerInfo.Info) as import('@cantoo/pdf-lib').PDFDict;
  info.set(PDFName.of('Company'), PDFString.of(PDF_SECRETS.company));
  const xmp = ctx.stream(`<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>${PDF_SECRETS.xmpCreator}</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`, { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(xmp));
  doc.getPage(0).node.set(PDFName.of('PieceInfo'), ctx.obj({ FixtureApp: { Private: PDFString.of('fixture-private-data') } }));
  const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of('note'), T: PDFString.of(PDF_SECRETS.annotAuthor) }));
  doc.getPage(0).node.set(PDFName.of('Annots'), ctx.obj([annot]));
  await doc.attach(Buffer.from('attached fixture file'), 'attachment.txt', { mimeType: 'text/plain' });
  ctx.register(PDFString.of(PDF_SECRETS.orphan));
  if (o.formValue) {
    const field = ctx.register(ctx.obj({ FT: 'Tx', T: PDFString.of('applicant_name'), V: PDFString.of(o.formValue), Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 50, 10], P: doc.getPage(0).ref }));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [field] }));
  }
  if (o.jpegWithExif) {
    const img = await doc.embedJpg(o.jpegWithExif);
    doc.getPage(1).drawImage(img, { x: 10, y: 10, width: 32, height: 24 });
  }
  if (o.signed) {
    const sig = ctx.register(ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 0, 0, 0], Contents: PDFString.of('00') }));
    const field = ctx.register(ctx.obj({ FT: 'Sig', T: PDFString.of('Signature1'), V: sig, Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], P: doc.getPage(0).ref }));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [field], SigFlags: 3 }));
  }
  let bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  const s = bytes.toString('latin1');
  if (o.incremental) {
    const prev = Number(/startxref\s+(\d+)/.exec(s.slice(s.lastIndexOf('startxref')))![1]);
    const size = Number(/\/Size (\d+)/.exec(s)![1]);
    const root = /\/Root (\d+ \d+ R)/.exec(s)![1];
    const obj = `${size} 0 obj\n<< /Author (${PDF_SECRETS.author}) /Producer (FixtureProducer2) >>\nendobj\n`;
    const objOff = bytes.length;
    const xrefOff = objOff + obj.length;
    const xref = `xref\n${size} 1\n${String(objOff).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${prev} >>\nstartxref\n${xrefOff}\n%%EOF\n`;
    bytes = Buffer.concat([bytes, Buffer.from(obj + xref, 'latin1')]);
  }
  if (o.encrypted) {
    bytes = Buffer.from(bytes.toString('latin1').replace(/trailer\s*<</, 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>'), 'latin1');
  }
  const p = join(dir, o.name ?? 'doc.pdf');
  writeFileSync(p, bytes);
  return p;
}

// ---------------------------------------------------------------- audio/video fixtures

export const AV_SECRETS = { artist: 'Jane AV Fixture', title: 'Fixture AV Title', comment: 'fixture av comment', location: '+48.8584+002.2945/', handler: 'Fixture Handler Name', chapter: 'Fixture Chapter One' };

const avMeta = () => ['-metadata', `artist=${AV_SECRETS.artist}`, '-metadata', `title=${AV_SECRETS.title}`, '-metadata', `comment=${AV_SECRETS.comment}`];

function chapters(dir: string): string {
  const p = join(dir, 'chapters.ffmeta');
  writeFileSync(p, `;FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=${AV_SECRETS.chapter}\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Second Chapter\n`);
  return p;
}

/** MP4 or MOV: h264 + aac(deu) + mov_text, GPS location, creation time, chapters, rotation 90. Optional tmcd data track. */
export function makeVideo(dir: string, kind: 'mp4' | 'mov', o: { timecode?: boolean } = {}): string {
  const srt = join(dir, 's.srt');
  writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nFixture subtitle\n');
  const base = join(dir, `base.${kind}`);
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-i', srt, '-i', chapters(dir),
    '-map', '0', '-map', '1', '-map', '2', '-map_chapters', '3', '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'mov_text',
    ...avMeta(), '-metadata', `location=${AV_SECRETS.location}`, '-metadata', 'creation_time=2021-05-06T07:08:09Z',
    '-metadata:s:a:0', 'language=deu', '-metadata:s:a:0', `handler_name=${AV_SECRETS.handler}`,
    ...(o.timecode ? ['-timecode', '01:00:00:00'] : []),
    '-f', kind, base,
  ]);
  if (o.timecode) return base; // timecode (tmcd) data track; no rotation remux
  const p = join(dir, `video.${kind}`);
  // Add rotation by remuxing; map only real streams (chapters regenerated from the chapter list).
  ffmpeg(['-display_rotation', '90', '-i', base, '-map', '0:v', '-map', '0:a', '-map', '0:s', '-map_chapters', '0', '-c', 'copy', '-map_metadata', '0', '-map_metadata:s:a:0', '0:s:a:0', '-f', kind, p]);
  return p;
}

export function makeM4a(dir: string): string {
  const p = join(dir, 'audio.m4a');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-i', chapters(dir), '-map', '0', '-map_chapters', '1', '-c:a', 'aac', ...avMeta(), '-metadata', 'creation_time=2021-05-06T07:08:09Z', '-f', 'ipod', p]);
  return p;
}

function cover(dir: string): string {
  const p = join(dir, 'cover.png');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:size=16x16', '-frames:v', '1', p]);
  return p;
}

export function makeMp3(dir: string): string {
  const p = join(dir, 'audio.mp3');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-i', cover(dir), '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata:s:v', 'comment=Cover (front)', ...avMeta(), '-id3v2_version', '3', '-write_id3v1', '1', p]);
  return p;
}

export function makeFlac(dir: string): string {
  const p = join(dir, 'audio.flac');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-i', cover(dir), '-map', '0', '-map', '1', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic', ...avMeta(), p]);
  return p;
}

export function makeWav(dir: string): string {
  const p = join(dir, 'audio.wav');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'pcm_s16le', ...avMeta(), '-metadata', 'encoded_by=Fixture Recorder', '-write_bext', '1', '-metadata', 'originator=Fixture Originator', p]);
  return p;
}
