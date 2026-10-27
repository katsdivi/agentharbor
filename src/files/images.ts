/**
 * JPEG / PNG / WebP metadata inspection and lossless container-level removal.
 *
 * Policy `image_metadata`:
 *  - removed: EXIF (incl. GPS, device/serial, author, timestamps, comments, maker
 *    notes, IFD1 thumbnail), XMP (incl. extended XMP), IPTC/Photoshop (APP13),
 *    JPEG comments (COM), MPF embedded previews / depth maps, FlashPix (APP2 FPXR),
 *    other vendor APPn segments, JFIF/JFXX thumbnails, PNG tEXt/zTXt/iTXt/eXIf/tIME,
 *    WebP EXIF/XMP chunks;
 *  - retained: compressed image data (copied byte-for-byte), ICC colour profile,
 *    JPEG APP14 Adobe colour transform, PNG colour/transparency/physical-size and
 *    animation chunks, WebP ICCP/ALPH/ANIM/ANMF chunks, and the ORIENTATION tag
 *    (re-written as a minimal EXIF block containing only 0x0112, so images keep
 *    displaying the right way up where viewers honour EXIF orientation);
 *  - reported, kept unless explicitly requested: bytes after the JPEG EOI marker
 *    (often an embedded "motion photo" video) and unknown PNG ancillary chunks.
 * Nothing is decoded or re-encoded: no quality loss.
 */
import * as cryptoMod from 'node:crypto';
import * as zlib from 'node:zlib';

// ---------------------------------------------------------------- EXIF (TIFF) reading

export type Category = 'gps' | 'device' | 'author' | 'timestamps' | 'comments' | 'software' | 'embeddedPreviews' | 'xmp' | 'iptc' | 'makerNotes' | 'contentCredentials' | 'other';

interface TagDef {
  name: string;
  cat: Category;
}

const TAGS: Record<number, TagDef> = {
  0x010e: { name: 'ImageDescription', cat: 'comments' },
  0x010f: { name: 'Make', cat: 'device' },
  0x0110: { name: 'Model', cat: 'device' },
  0x0131: { name: 'Software', cat: 'software' },
  0x0132: { name: 'DateTime', cat: 'timestamps' },
  0x013b: { name: 'Artist', cat: 'author' },
  0x8298: { name: 'Copyright', cat: 'author' },
  0x9003: { name: 'DateTimeOriginal', cat: 'timestamps' },
  0x9004: { name: 'DateTimeDigitized', cat: 'timestamps' },
  0x9010: { name: 'OffsetTime', cat: 'timestamps' },
  0x9011: { name: 'OffsetTimeOriginal', cat: 'timestamps' },
  0x9012: { name: 'OffsetTimeDigitized', cat: 'timestamps' },
  0x927c: { name: 'MakerNote', cat: 'makerNotes' },
  0x9286: { name: 'UserComment', cat: 'comments' },
  0x9c9b: { name: 'XPTitle', cat: 'comments' },
  0x9c9c: { name: 'XPComment', cat: 'comments' },
  0x9c9d: { name: 'XPAuthor', cat: 'author' },
  0x9c9e: { name: 'XPKeywords', cat: 'comments' },
  0x9c9f: { name: 'XPSubject', cat: 'comments' },
  0xa420: { name: 'ImageUniqueID', cat: 'device' },
  0xa430: { name: 'CameraOwnerName', cat: 'author' },
  0xa431: { name: 'BodySerialNumber', cat: 'device' },
  0xa433: { name: 'LensMake', cat: 'device' },
  0xa434: { name: 'LensModel', cat: 'device' },
  0xa435: { name: 'LensSerialNumber', cat: 'device' },
  0x0201: { name: 'ThumbnailOffset', cat: 'embeddedPreviews' },
  0x0202: { name: 'ThumbnailLength', cat: 'embeddedPreviews' },
};
const GPS_NAMES: Record<number, string> = {
  0: 'GPSVersionID', 1: 'GPSLatitudeRef', 2: 'GPSLatitude', 3: 'GPSLongitudeRef', 4: 'GPSLongitude', 5: 'GPSAltitudeRef', 6: 'GPSAltitude',
  7: 'GPSTimeStamp', 12: 'GPSSpeedRef', 13: 'GPSSpeed', 16: 'GPSImgDirectionRef', 17: 'GPSImgDirection', 18: 'GPSMapDatum', 29: 'GPSDateStamp',
};

export interface ExifField {
  ifd: 'IFD0' | 'ExifIFD' | 'GPS' | 'IFD1';
  tag: number;
  name: string;
  category: Category;
  /** Only filled when detailed inspection is requested. */
  value?: string;
}

export interface ExifInfo {
  fields: ExifField[];
  orientation: number | null;
  hasThumbnail: boolean;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Parse a TIFF/EXIF block (starting at the byte-order mark). Bounded and defensive. */
export function parseExif(tiff: Buffer, detailed = false): ExifInfo {
  const out: ExifInfo = { fields: [], orientation: null, hasThumbnail: false };
  if (tiff.length < 8) return out;
  const le = tiff.toString('latin1', 0, 2) === 'II';
  if (!le && tiff.toString('latin1', 0, 2) !== 'MM') return out;
  const u16 = (o: number) => (o + 2 <= tiff.length ? (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : 0);
  const u32 = (o: number) => (o + 4 <= tiff.length ? (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : 0);
  const seen = new Set<number>();
  const value = (type: number, count: number, valOff: number, entryOff: number): string => {
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const at = size <= 4 ? entryOff + 8 : valOff;
    if (at + Math.min(size, 256) > tiff.length) return '[out of range]';
    if (type === 2) return tiff.toString('latin1', at, at + Math.min(size, 256)).replace(/\0+$/, '');
    if (type === 3) return String(u16(at));
    if (type === 4) return String(u32(at));
    if (type === 5) return Array.from({ length: Math.min(count, 4) }, (_, i) => `${u32(at + i * 8)}/${u32(at + i * 8 + 4)}`).join(' ');
    return `[${size} bytes]`;
  };
  const walk = (off: number, ifd: ExifField['ifd'], depth: number): number => {
    if (depth > 4 || off < 8 || off + 2 > tiff.length || seen.has(off)) return 0;
    seen.add(off);
    const n = Math.min(u16(off), 512);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const valOff = u32(e + 8);
      if (ifd !== 'GPS' && tag === 0x8769) {
        walk(valOff, 'ExifIFD', depth + 1);
        continue;
      }
      if (ifd !== 'GPS' && tag === 0x8825) {
        walk(valOff, 'GPS', depth + 1);
        continue;
      }
      if (tag === 0xa005) continue; // interoperability pointer
      if (ifd === 'IFD0' && tag === 0x0112) out.orientation = u16(e + 8);
      let def: TagDef | undefined;
      if (ifd === 'GPS') def = { name: GPS_NAMES[tag] ?? `GPSTag${tag}`, cat: 'gps' };
      else if (ifd === 'IFD1') def = { name: TAGS[tag]?.name ?? `Thumbnail-0x${tag.toString(16)}`, cat: 'embeddedPreviews' };
      else def = TAGS[tag] ?? (tag === 0x0112 ? { name: 'Orientation', cat: 'other' } : { name: `0x${tag.toString(16).padStart(4, '0')}`, cat: 'other' });
      if (ifd === 'IFD1' && (tag === 0x0201 || tag === 0x0111)) out.hasThumbnail = true;
      out.fields.push({ ifd, tag, name: def.name, category: def.cat, ...(detailed ? { value: value(type, count, valOff, e) } : {}) });
    }
    return u32(off + 2 + n * 12);
  };
  const ifd1 = walk(u32(4), 'IFD0', 0);
  if (ifd1) walk(ifd1, 'IFD1', 0);
  return out;
}

/** Minimal big-endian TIFF block holding only IFD0 Orientation (0x0112). */
export function minimalExif(orientation: number): Buffer {
  const b = Buffer.alloc(8 + 2 + 12 + 4);
  b.write('MM\0*', 0, 'latin1');
  b.writeUInt32BE(8, 4);
  b.writeUInt16BE(1, 8);
  b.writeUInt16BE(0x0112, 10);
  b.writeUInt16BE(3, 12); // SHORT
  b.writeUInt32BE(1, 14);
  b.writeUInt16BE(orientation, 18);
  b.writeUInt32BE(0, 22); // no next IFD
  return b;
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  data: Buffer;
}

/** One IFD followed by its out-of-line values, placed at `start`. `next` = next-IFD offset. */
function writeIfd(entries: IfdEntry[], start: number, next: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const ifdLen = 2 + sorted.length * 12 + 4;
  let heapOff = start + ifdLen;
  const ifd = Buffer.alloc(ifdLen);
  const heap: Buffer[] = [];
  ifd.writeUInt16BE(sorted.length, 0);
  sorted.forEach((e, i) => {
    const o = 2 + i * 12;
    ifd.writeUInt16BE(e.tag, o);
    ifd.writeUInt16BE(e.type, o + 2);
    ifd.writeUInt32BE(e.count, o + 4);
    if (e.data.length <= 4) e.data.copy(ifd, o + 8);
    else {
      ifd.writeUInt32BE(heapOff, o + 8);
      const padded = e.data.length % 2 ? Buffer.concat([e.data, Buffer.alloc(1)]) : e.data;
      heap.push(padded);
      heapOff += padded.length;
    }
  });
  ifd.writeUInt32BE(next, ifdLen - 4);
  return Buffer.concat([ifd, ...heap]);
}

const ifdSize = (entries: IfdEntry[]) => 2 + entries.length * 12 + 4 + entries.reduce((n, e) => n + (e.data.length > 4 ? e.data.length + (e.data.length % 2) : 0), 0);

/**
 * TIFF block builder (tests and fixtures; no exiftool needed): IFD0 ASCII tags,
 * optional Orientation, GPS IFD (fixed coordinates) and an IFD1 thumbnail. Big-endian.
 */
export function buildExif(o: { ascii?: Record<number, string>; orientation?: number; gps?: boolean; thumbnail?: Buffer }): Buffer {
  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    return b;
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    return b;
  };
  const rat = (vals: number[]) => Buffer.concat(vals.map((v) => Buffer.concat([u32(v), u32(1)])));
  const ifd0: IfdEntry[] = Object.entries(o.ascii ?? {}).map(([tag, str]) => {
    const d = Buffer.from(`${str}\0`, 'latin1');
    return { tag: Number(tag), type: 2, count: d.length, data: d };
  });
  if (o.orientation) ifd0.push({ tag: 0x0112, type: 3, count: 1, data: u16(o.orientation) });
  const gps: IfdEntry[] = o.gps
    ? [
        { tag: 1, type: 2, count: 2, data: Buffer.from('N\0') },
        { tag: 2, type: 5, count: 3, data: rat([48, 51, 29]) },
        { tag: 3, type: 2, count: 2, data: Buffer.from('E\0') },
        { tag: 4, type: 5, count: 3, data: rat([2, 17, 40]) },
      ]
    : [];
  if (o.gps) ifd0.push({ tag: 0x8825, type: 4, count: 1, data: u32(0) }); // patched below
  const ifd0Start = 8;
  const gpsStart = ifd0Start + ifdSize(ifd0);
  const ifd1Start = gpsStart + (o.gps ? ifdSize(gps) : 0);
  if (o.gps) ifd0.find((e) => e.tag === 0x8825)!.data = u32(gpsStart);
  const parts: Buffer[] = [Buffer.from('MM\0*', 'latin1'), u32(8), writeIfd(ifd0, ifd0Start, o.thumbnail ? ifd1Start : 0)];
  if (o.gps) parts.push(writeIfd(gps, gpsStart, 0));
  if (o.thumbnail) {
    const thumbOff = ifd1Start + 2 + 2 * 12 + 4;
    parts.push(writeIfd([{ tag: 0x0201, type: 4, count: 1, data: u32(thumbOff) }, { tag: 0x0202, type: 4, count: 1, data: u32(o.thumbnail.length) }], ifd1Start, 0));
    parts.push(o.thumbnail);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ICC profiles

import { iccFail, parseIcc, type IccInfo } from './icc.js';
export { parseIcc, type IccInfo };

/** Raw ICC bytes as stored in a file (JPEG APP2 payloads, WebP ICCP; PNG iCCP is compressed). */
export function storedIccBytes(format: 'jpeg' | 'png' | 'webp', b: Buffer): Buffer | null {
  try {
    if (format === 'jpeg') return iccFromJpeg(parseJpeg(b).segments);
    if (format === 'webp') return parseWebp(b).find((c) => c.fourcc === 'ICCP')?.data ?? null;
    if (format === 'png') {
      // iCCP is zlib-compressed: return the inflated profile (values are only findable there).
      const c = parsePng(b).find((x) => x.type === 'iCCP');
      return c ? pngIcc(c.data) : null;
    }
  } catch {
    return null;
  }
  return null;
}

function pngIcc(data: Buffer): Buffer | null {
  const z = data.indexOf(0);
  if (z < 0 || z + 2 > data.length) return null;
  try {
    return zlib.inflateSync(data.subarray(z + 2), { maxOutputLength: 4 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- common report

export interface ImageReport {
  format: 'jpeg' | 'png' | 'webp';
  width: number | null;
  height: number | null;
  /** Counts of identifying fields per category. */
  categories: Partial<Record<Category, number>>;
  /** Field names per category (values only with detailed inspection). */
  fields: Array<{ container: string; name: string; category: Category; value?: string }>;
  orientation: number | null;
  iccProfileSha256: string | null;
  /** Retained ICC profile, inspected (it is kept for colour rendering). */
  icc: IccInfo | null;
  adobeApp14: boolean;
  /** Bytes after the end of the image (JPEG), e.g. an embedded motion-photo video. */
  trailingBytes: number;
  unknownChunks: string[];
  animated: boolean;
}

function addField(r: ImageReport, container: string, name: string, category: Category, value?: string) {
  r.fields.push({ container, name, category, ...(value !== undefined ? { value } : {}) });
  r.categories[category] = (r.categories[category] ?? 0) + 1;
}

function addExif(r: ImageReport, tiff: Buffer, container: string, detailed: boolean) {
  const ex = parseExif(tiff, detailed);
  for (const f of ex.fields) {
    if (f.tag === 0x0112 && f.ifd === 'IFD0') continue; // orientation: retained, reported separately
    addField(r, `${container}/${f.ifd}`, f.name, f.category, f.value);
  }
  if (ex.orientation !== null) r.orientation = ex.orientation;
}

function xmpFields(xml: string, detailed: boolean): Array<{ name: string; category: Category; value?: string }> {
  const out: Array<{ name: string; category: Category; value?: string }> = [];
  const re = /<([a-zA-Z0-9]+:[A-Za-z0-9]+)[\s>]|\s([a-zA-Z0-9]+:[A-Za-z0-9]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(xml)) && out.length < 200) {
    const name = m[1] ?? m[2]!;
    if (/^(x|rdf|xmlns):/.test(name) || name.startsWith('xmlns') || seen.has(name)) continue;
    seen.add(name);
    const lower = name.toLowerCase();
    const category: Category = /gps|location|city|country|state/.test(lower)
      ? 'gps'
      : /creator|author|rights|owner|artist|by-line|credit/.test(lower)
        ? 'author'
        : /date|time/.test(lower)
          ? 'timestamps'
          : /make|model|serial|lens|camera/.test(lower)
            ? 'device'
            : /tool|software|history|derived|documentid|instanceid/.test(lower)
              ? 'software'
              : /description|title|subject|label|comment|keywords/.test(lower)
                ? 'comments'
                : 'xmp';
    out.push({ name, category, ...(detailed && m[3] !== undefined ? { value: m[3].slice(0, 200) } : {}) });
  }
  // Element text (e.g. <dc:creator><rdf:Seq><rdf:li>Name</rdf:li>): values for the byte scan.
  const text = /<(rdf:li|[a-zA-Z0-9]+:[A-Za-z0-9]+)>([^<>]{1,200})<\//g;
  while ((m = text.exec(xml)) && out.length < 300) {
    const v = m[2]!.trim();
    if (v) out.push({ name: `${m[1]} (text)`, category: m[1] === 'rdf:li' ? 'xmp' : 'xmp', ...(detailed ? { value: v } : {}) });
  }
  if (out.length === 0) out.push({ name: 'xmp:packet', category: 'xmp' });
  return out;
}

// ---------------------------------------------------------------- JPEG

interface JpegSeg {
  marker: number;
  start: number;
  end: number; // exclusive
  data: Buffer; // payload after the 2-byte length
}

export interface JpegParse {
  segments: JpegSeg[];
  /** APPn/COM segments found AFTER the first SOS (between scans or before EOI). */
  scanSegments: JpegSeg[];
  /** Offset of the first SOS marker (start of image data). */
  sosStart: number;
  /** Offset just after the EOI marker. */
  eoiEnd: number;
}

export function parseJpeg(b: Buffer): JpegParse {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG (no SOI)');
  const segments: JpegSeg[] = [];
  let p = 2;
  let sosStart = -1;
  while (p < b.length) {
    if (b[p] !== 0xff) throw new Error(`corrupt JPEG: expected marker at ${p}`);
    let marker = b[p + 1]!;
    while (marker === 0xff && p + 2 < b.length) {
      p++;
      marker = b[p + 1]!;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    if (marker === 0xd9) throw new Error('corrupt JPEG: EOI before image data');
    if (p + 4 > b.length) throw new Error('corrupt JPEG: truncated segment header');
    const len = b.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > b.length) throw new Error('corrupt JPEG: segment length out of range');
    const seg = { marker, start: p, end: p + 2 + len, data: b.subarray(p + 4, p + 2 + len) };
    if (marker === 0xda) {
      sosStart = p;
      break;
    }
    segments.push(seg);
    p = seg.end;
  }
  if (sosStart < 0) throw new Error('corrupt JPEG: no image data (SOS)');
  // Walk the scans to the EOI: entropy-coded data, stuffed bytes, RSTn, and
  // further marker segments (progressive DHT/SOS) until FFD9.
  p = sosStart;
  let eoiEnd = -1;
  const scanSegments: JpegSeg[] = [];
  while (p < b.length - 1) {
    if (b[p] === 0xff) {
      const m = b[p + 1]!;
      if (m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
        p += m === 0xff ? 1 : 2;
        continue;
      }
      if (m === 0xd9) {
        eoiEnd = p + 2;
        break;
      }
      if (p + 4 > b.length) break;
      const len = b.readUInt16BE(p + 2);
      if (len < 2 || p + 2 + len > b.length) throw new Error('corrupt JPEG: bad segment inside scan data');
      if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) scanSegments.push({ marker: m, start: p, end: p + 2 + len, data: b.subarray(p + 4, p + 2 + len) });
      p += 2 + len;
      continue;
    }
    p++;
  }
  if (eoiEnd < 0) throw new Error('corrupt or truncated JPEG: no EOI');
  return { segments, scanSegments, sosStart, eoiEnd };
}

function sofDims(segs: JpegSeg[]): { width: number | null; height: number | null } {
  const sof = segs.find((s) => s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker));
  if (!sof || sof.data.length < 5) return { width: null, height: null };
  return { height: sof.data.readUInt16BE(1), width: sof.data.readUInt16BE(3) };
}

const startsWith = (d: Buffer, s: string) => d.length >= s.length && d.toString('latin1', 0, s.length) === s;
const sha = (b: Buffer) => cryptoMod.createHash('sha256').update(b).digest('hex');

function iccFromJpeg(segs: JpegSeg[]): Buffer | null {
  const parts = segs.filter((s) => s.marker === 0xe2 && startsWith(s.data, 'ICC_PROFILE\0')).map((s) => s.data.subarray(14));
  return parts.length ? Buffer.concat(parts) : null;
}

export function inspectJpeg(b: Buffer, detailed = false): ImageReport {
  const j = parseJpeg(b);
  const r: ImageReport = { format: 'jpeg', ...sofDims(j.segments), categories: {}, fields: [], orientation: null, iccProfileSha256: null, icc: null, adobeApp14: false, trailingBytes: b.length - j.eoiEnd, unknownChunks: [], animated: false };
  const icc = iccFromJpeg(j.segments);
  r.iccProfileSha256 = icc ? sha(icc) : null;
  r.icc = icc ? parseIcc(icc, detailed) : null;
  for (const s of [...j.segments, ...j.scanSegments]) {
    if (s.marker === 0xeb && (startsWith(s.data, 'JP') || s.data.includes(Buffer.from('c2pa')) || s.data.includes(Buffer.from('jumb')))) addField(r, 'APP11-JUMBF', s.data.includes(Buffer.from('c2pa')) ? 'C2PA content credentials' : 'JUMBF box', 'contentCredentials');
    else if (s.marker === 0xe1 && startsWith(s.data, 'Exif\0\0')) addExif(r, s.data.subarray(6), 'APP1-Exif', detailed);
    else if (s.marker === 0xe1 && startsWith(s.data, 'http://ns.adobe.com/xap/1.0/\0')) for (const f of xmpFields(s.data.toString('utf8', 29), detailed)) addField(r, 'APP1-XMP', f.name, f.category, f.value);
    else if (s.marker === 0xe1 && startsWith(s.data, 'http://ns.adobe.com/xmp/extension/\0')) addField(r, 'APP1-ExtendedXMP', 'ExtendedXMP', 'xmp');
    else if (s.marker === 0xe1) addField(r, 'APP1', 'vendor APP1', 'other');
    else if (s.marker === 0xed) addField(r, 'APP13', startsWith(s.data, 'Photoshop 3.0') ? 'IPTC/Photoshop' : 'vendor APP13', 'iptc');
    else if (s.marker === 0xfe) addField(r, 'COM', 'Comment', 'comments', detailed ? s.data.toString('utf8').slice(0, 200) : undefined);
    else if (s.marker === 0xe2 && startsWith(s.data, 'MPF\0')) addField(r, 'APP2-MPF', 'MultiPictureFormat (embedded previews/depth)', 'embeddedPreviews');
    else if (s.marker === 0xe2 && startsWith(s.data, 'FPXR')) addField(r, 'APP2-FPXR', 'FlashPix', 'other');
    else if (s.marker === 0xe0 && startsWith(s.data, 'JFIF\0') && s.data.length >= 14 && s.data[12]! * s.data[13]! > 0) addField(r, 'APP0-JFIF', 'JFIFThumbnail', 'embeddedPreviews');
    else if (s.marker === 0xe0 && startsWith(s.data, 'JFXX\0')) addField(r, 'APP0-JFXX', 'JFXXThumbnail', 'embeddedPreviews');
    else if (s.marker === 0xee && startsWith(s.data, 'Adobe')) r.adobeApp14 = true;
    else if (s.marker >= 0xe3 && s.marker <= 0xef && s.marker !== 0xee) addField(r, `APP${s.marker - 0xe0}`, `vendor APP${s.marker - 0xe0}`, 'other');
  }
  return r;
}

function seg(marker: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(4);
  h[0] = 0xff;
  h[1] = marker;
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}

export function sanitizeJpeg(b: Buffer, opts: { removeTrailingData?: boolean } = {}): Buffer {
  const j = parseJpeg(b);
  const ex = j.segments.find((s) => s.marker === 0xe1 && startsWith(s.data, 'Exif\0\0'));
  const orientation = ex ? parseExif(ex.data.subarray(6)).orientation : null;
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let wroteExif = false;
  const writeOrientation = () => {
    if (!wroteExif && orientation && orientation !== 1) out.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), minimalExif(orientation)])));
    wroteExif = true;
  };
  for (const s of j.segments) {
    const keep =
      (s.marker === 0xe0 && startsWith(s.data, 'JFIF\0')) ||
      (s.marker === 0xe2 && startsWith(s.data, 'ICC_PROFILE\0')) ||
      (s.marker === 0xee && startsWith(s.data, 'Adobe')) ||
      !(s.marker >= 0xe0 && s.marker <= 0xef) && s.marker !== 0xfe;
    if (!keep) continue;
    if (s.marker === 0xe0 && startsWith(s.data, 'JFIF\0') && s.data.length >= 14) {
      // JFIF header without its optional thumbnail.
      const h = Buffer.from(s.data.subarray(0, 14));
      h[12] = 0;
      h[13] = 0;
      out.push(seg(0xe0, h));
      writeOrientation();
      continue;
    }
    if (!(s.marker >= 0xe0 && s.marker <= 0xef)) writeOrientation(); // before DQT/SOF etc.
    out.push(b.subarray(s.start, s.end));
  }
  writeOrientation();
  // Image data byte-for-byte, minus APPn/COM segments found between scans.
  let from = j.sosStart;
  for (const s of j.scanSegments) {
    out.push(b.subarray(from, s.start));
    from = s.end;
  }
  out.push(b.subarray(from, j.eoiEnd));
  if (!opts.removeTrailingData && j.eoiEnd < b.length) out.push(b.subarray(j.eoiEnd));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- PNG

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_REMOVE = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'exIf', 'zxIf']);
/** C2PA content credentials (JUMBF in a caBX chunk). */
const PNG_CREDENTIALS = new Set(['caBX']);
const PNG_KNOWN_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT']);

interface PngChunk {
  type: string;
  start: number;
  end: number;
  data: Buffer;
}

export function parsePng(b: Buffer): PngChunk[] {
  if (!b.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  const chunks: PngChunk[] = [];
  let p = 8;
  while (p < b.length) {
    if (p + 12 > b.length) throw new Error('corrupt PNG: truncated chunk');
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || p + 12 + len > b.length) throw new Error('corrupt PNG: bad chunk');
    const data = b.subarray(p + 8, p + 8 + len);
    const crc = b.readUInt32BE(p + 8 + len);
    if (zlib.crc32(Buffer.concat([b.subarray(p + 4, p + 8), data])) >>> 0 !== crc) throw new Error(`corrupt PNG: CRC mismatch in ${type}`);
    chunks.push({ type, start: p, end: p + 12 + len, data });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR' || chunks[chunks.length - 1]?.type !== 'IEND') throw new Error('corrupt PNG: missing IHDR or IEND');
  return chunks;
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(data.length, 0);
  h.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0);
  return Buffer.concat([h, data, crc]);
}

export function inspectPng(b: Buffer, detailed = false): ImageReport {
  const chunks = parsePng(b);
  const ihdr = chunks[0]!.data;
  const r: ImageReport = { format: 'png', width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), categories: {}, fields: [], orientation: null, iccProfileSha256: null, icc: null, adobeApp14: false, trailingBytes: 0, unknownChunks: [], animated: false };
  for (const c of chunks) {
    if (c.type === 'eXIf') addExif(r, c.data, 'eXIf', detailed);
    else if (c.type === 'tIME') addField(r, 'tIME', 'ModificationTime', 'timestamps');
    else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      const key = c.data.toString('latin1', 0, Math.max(0, c.data.indexOf(0))).slice(0, 79) || 'text';
      if (key === 'XML:com.adobe.xmp') {
        const xml = c.data.toString('utf8');
        for (const f of xmpFields(xml, detailed)) addField(r, `${c.type}-XMP`, f.name, f.category, f.value);
      } else {
        const lower = key.toLowerCase();
        const cat: Category = /author|copyright|artist/.test(lower) ? 'author' : /time|date/.test(lower) ? 'timestamps' : /software/.test(lower) ? 'software' : /gps|location/.test(lower) ? 'gps' : 'comments';
        addField(r, c.type, key, cat, detailed && c.type === 'tEXt' ? c.data.toString('latin1', c.data.indexOf(0) + 1).slice(0, 200) : undefined);
      }
    } else if (c.type === 'iCCP') {
      r.iccProfileSha256 = sha(c.data);
      const raw = pngIcc(c.data);
      r.icc = raw ? parseIcc(raw, detailed) : iccFail('iCCP could not be decompressed within limits');
    } else if (c.type === 'acTL') r.animated = true;
    else if (PNG_CREDENTIALS.has(c.type)) addField(r, c.type, 'C2PA content credentials', 'contentCredentials');
    else if (c.type === 'exIf' || c.type === 'zxIf') addField(r, c.type, 'legacy EXIF chunk', 'other');
    else if (!PNG_KNOWN_KEEP.has(c.type) && !PNG_REMOVE.has(c.type)) r.unknownChunks.push(c.type);
  }
  return r;
}

export function sanitizePng(b: Buffer): Buffer {
  const chunks = parsePng(b);
  const criticalUnknown = chunks.filter((c) => !PNG_KNOWN_KEEP.has(c.type) && !PNG_REMOVE.has(c.type) && !PNG_CREDENTIALS.has(c.type) && c.type[0] === c.type[0]!.toUpperCase());
  if (criticalUnknown.length) throw new Error(`unsupported PNG: unknown critical chunk(s) ${criticalUnknown.map((c) => c.type).join(', ')}`);
  const ex = chunks.find((c) => c.type === 'eXIf');
  const orientation = ex ? parseExif(ex.data).orientation : null;
  const out: Buffer[] = [PNG_SIG];
  for (const c of chunks) {
    // Removed: metadata chunks, content credentials (only after an explicit decision,
    // checked by the caller) and unknown ANCILLARY chunks (not needed for rendering).
    if (PNG_REMOVE.has(c.type) || PNG_CREDENTIALS.has(c.type) || !PNG_KNOWN_KEEP.has(c.type)) continue;
    out.push(b.subarray(c.start, c.end));
    // eXIf must precede the first IDAT.
    if (c.type === 'IHDR' && orientation && orientation !== 1) out.push(pngChunk('eXIf', minimalExif(orientation)));
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- WebP

interface RiffChunk {
  fourcc: string;
  start: number;
  end: number; // incl. padding
  data: Buffer;
}

export function parseWebp(b: Buffer): RiffChunk[] {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP');
  const riffSize = b.readUInt32LE(4);
  if (riffSize + 8 > b.length || riffSize < 4) throw new Error('corrupt WebP: RIFF size out of range');
  const chunks: RiffChunk[] = [];
  let p = 12;
  const end = 8 + riffSize;
  while (p + 8 <= end) {
    const fourcc = b.toString('latin1', p, p + 4);
    const len = b.readUInt32LE(p + 4);
    const dataEnd = p + 8 + len;
    if (dataEnd > end) throw new Error('corrupt WebP: chunk out of range');
    chunks.push({ fourcc, start: p, end: dataEnd + (len % 2), data: b.subarray(p + 8, dataEnd) });
    p = dataEnd + (len % 2);
  }
  if (!chunks.some((c) => ['VP8 ', 'VP8L', 'ANMF'].includes(c.fourcc))) throw new Error('corrupt WebP: no image data');
  return chunks;
}

function webpDims(chunks: RiffChunk[]): { width: number | null; height: number | null } {
  const x = chunks.find((c) => c.fourcc === 'VP8X');
  if (x && x.data.length >= 10) return { width: 1 + x.data.readUIntLE(4, 3), height: 1 + x.data.readUIntLE(7, 3) };
  const l = chunks.find((c) => c.fourcc === 'VP8L');
  if (l && l.data.length >= 5) {
    const bits = l.data.readUInt32LE(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  const v = chunks.find((c) => c.fourcc === 'VP8 ');
  if (v && v.data.length >= 10) return { width: v.data.readUInt16LE(6) & 0x3fff, height: v.data.readUInt16LE(8) & 0x3fff };
  return { width: null, height: null };
}

export function inspectWebp(b: Buffer, detailed = false): ImageReport {
  const chunks = parseWebp(b);
  const r: ImageReport = { format: 'webp', ...webpDims(chunks), categories: {}, fields: [], orientation: null, iccProfileSha256: null, icc: null, adobeApp14: false, trailingBytes: 0, unknownChunks: [], animated: chunks.some((c) => c.fourcc === 'ANIM') };
  for (const c of chunks) {
    if (c.fourcc === 'EXIF') {
      const t = startsWith(c.data, 'Exif\0\0') ? c.data.subarray(6) : c.data;
      addExif(r, t, 'EXIF', detailed);
    } else if (c.fourcc === 'XMP ') for (const f of xmpFields(c.data.toString('utf8'), detailed)) addField(r, 'XMP', f.name, f.category, f.value);
    else if (c.fourcc === 'ICCP') {
      r.iccProfileSha256 = sha(c.data);
      r.icc = parseIcc(c.data, detailed);
    }
    else if (c.fourcc === 'C2PA') addField(r, 'C2PA', 'C2PA content credentials', 'contentCredentials');
    else if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF'].includes(c.fourcc)) r.unknownChunks.push(c.fourcc.trim());
  }
  return r;
}

function riff(fourcc: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(fourcc, 0, 'latin1');
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

export function sanitizeWebp(b: Buffer): Buffer {
  const chunks = parseWebp(b);
  const ex = chunks.find((c) => c.fourcc === 'EXIF');
  const orientation = ex ? parseExif(startsWith(ex.data, 'Exif\0\0') ? ex.data.subarray(6) : ex.data).orientation : null;
  const keepOrientation = !!orientation && orientation !== 1;
  const parts: Buffer[] = [];
  for (const c of chunks) {
    // Only image/colour/animation chunks are kept; EXIF, XMP, C2PA (after a decision) and unknown chunks are dropped.
    if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP'].includes(c.fourcc)) continue;
    if (c.fourcc === 'VP8X') {
      const d = Buffer.from(c.data);
      // flags: bit3 EXIF, bit2 XMP
      d[0] = (d[0]! & ~0x0c) | (keepOrientation ? 0x08 : 0);
      parts.push(riff('VP8X', d));
      continue;
    }
    parts.push(b.subarray(c.start, c.end));
  }
  // EXIF chunk goes after the image data (WebP container spec order).
  if (keepOrientation && chunks.some((c) => c.fourcc === 'VP8X')) parts.push(riff('EXIF', minimalExif(orientation!)));
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(12);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(body.length + 4, 4);
  h.write('WEBP', 8, 'latin1');
  return Buffer.concat([h, body]);
}

// ---------------------------------------------------------------- dispatch

export function inspectImage(format: 'jpeg' | 'png' | 'webp', b: Buffer, detailed = false): ImageReport {
  return format === 'jpeg' ? inspectJpeg(b, detailed) : format === 'png' ? inspectPng(b, detailed) : inspectWebp(b, detailed);
}

export function sanitizeImage(format: 'jpeg' | 'png' | 'webp', b: Buffer, opts: { removeTrailingData?: boolean } = {}): Buffer {
  return format === 'jpeg' ? sanitizeJpeg(b, opts) : format === 'png' ? sanitizePng(b) : sanitizeWebp(b);
}

/** Categories removed by the policy (everything in a report except orientation/ICC/trailing). */
export const IMAGE_REMOVED_CATEGORIES: Category[] = ['gps', 'device', 'author', 'timestamps', 'comments', 'software', 'embeddedPreviews', 'xmp', 'iptc', 'makerNotes', 'contentCredentials', 'other'];
