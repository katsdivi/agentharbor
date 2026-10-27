/**
 * ICC profile inspection (profiles are kept in sanitized images because they
 * are needed for colour rendering).
 *
 * A profile is treated as "standard" ONLY when its canonical bytes (declared
 * size, creation date and profile ID zeroed) match a known published profile
 * (icc-known.ts). A standard-sounding description is never enough: an unknown
 * profile is inspected field by field and every identifying field is reported
 * as a retained finding:
 *  - every text-bearing tag (all mluc records, every desc part, text, utf8,
 *    dict/meta entries, named-colour and colorant names, strings found in
 *    tags of other or private types);
 *  - header device manufacturer/model, creator/CMM codes, creation date,
 *    profile ID and non-zero reserved bytes;
 *  - private or unknown tags (unknown types are also inspection gaps),
 *    duplicate tag signatures, unreferenced non-zero bytes and bytes after
 *    the declared size;
 *  - Apple display tags (mmod: make/model, possibly a serial number; ndin;
 *    vcgt calibration curves) and calibration dates.
 * Values are included only with detailed inspection.
 */
import { createHash } from 'node:crypto';
import { KNOWN_ICC } from './icc-known.js';

export interface IccFinding {
  name: string;
  value?: string;
}

export interface IccInfo {
  parsed: boolean;
  /** Why parsing failed (then the profile is an inspection gap). */
  error?: string;
  /** Canonical bytes match a known published profile (see icc-known.ts). */
  standard: boolean;
  /** Name of the matched known profile. */
  known: string | null;
  /** The description looks like a standard profile name (informational only; never trusted). */
  claimsStandardName: boolean;
  /** Tags whose content is text (signatures). */
  textTags: string[];
  /** Fields that may describe a device, person or organisation (values only when detailed). */
  findings: IccFinding[];
  /** Parts of the profile that could not be interpreted. */
  gaps: string[];
}

/** Used only to say "claims a standard name"; never to trust a profile. */
export const STANDARD_NAME = /^(sRGB|Display P3|Adobe RGB|Generic (RGB|Gray|CMYK|Lab|XYZ)|ProPhoto|ROMM|ITU-R|Rec\.? ?(709|2020)|DCI-?P3|Gray Gamma|Dot Gain|U\.S\. Web Coated|Coated FOGRA|Uncoated FOGRA|ISO Coated|PSO|Japan Color|Linear (RGB|Gray)|ACES|Apple RGB|ColorMatch RGB|e-sRGB|scRGB)\b/i;

export function iccFail(error: string): IccInfo {
  return { parsed: false, error, standard: false, known: null, claimsStandardName: false, textTags: [], findings: [], gaps: [] };
}

/** SHA-256 of the canonical profile: bytes [0, size) with the creation date and profile ID zeroed. */
export function iccCanonicalSha256(b: Buffer): string | null {
  if (b.length < 128) return null;
  const size = b.readUInt32BE(0);
  if (size < 128 || size > b.length) return null;
  const c = Buffer.from(b.subarray(0, size));
  c.fill(0, 24, 36);
  c.fill(0, 84, 100);
  return createHash('sha256').update(c).digest('hex');
}

/** ICC profile ID per the specification: MD5 with flags, rendering intent and ID zeroed. */
function specProfileId(b: Buffer, size: number): string {
  const c = Buffer.from(b.subarray(0, size));
  c.fill(0, 44, 48);
  c.fill(0, 64, 68);
  c.fill(0, 84, 100);
  return createHash('md5').update(c).digest('hex');
}

/** Tag types that carry only numbers (curves, matrices, LUTs, measurement data). */
const NUMERIC_TYPES = new Set(['curv', 'para', 'XYZ ', 'mft1', 'mft2', 'mAB ', 'mBA ', 'sf32', 'chrm', 'clro', 'meas', 'view', 'sig ', 'mpet', 'ui08', 'ui16', 'ui32', 'ui64', 'uf32', 'rcs2', 'cicp', 'smat']);
/** Tag signatures defined by ICC.1 (anything else is private). */
const STANDARD_TAGS = new Set([
  'A2B0', 'A2B1', 'A2B2', 'A2B3', 'B2A0', 'B2A1', 'B2A2', 'B2A3', 'D2B0', 'D2B1', 'D2B2', 'D2B3', 'B2D0', 'B2D1', 'B2D2', 'B2D3',
  'bXYZ', 'bTRC', 'gXYZ', 'gTRC', 'rXYZ', 'rTRC', 'kTRC', 'wtpt', 'bkpt', 'chad', 'chrm', 'cicp', 'clro', 'clrt', 'clot', 'ciis',
  'cprt', 'crdi', 'calt', 'targ', 'data', 'dtim', 'devs', 'dmnd', 'dmdd', 'desc', 'gamt', 'lumi', 'meas', 'meta', 'ncol', 'ncl2',
  'resp', 'rig0', 'rig2', 'pre0', 'pre1', 'pre2', 'pseq', 'psid', 'ps2s', 'ps2i', 'ps2r', 'scrd', 'scrn', 'tech', 'bfd ', 'vued', 'view',
]);
const TAG_NAMES: Record<string, string> = {
  desc: 'profile description',
  dscm: 'Apple localized description',
  cprt: 'copyright',
  dmnd: 'device manufacturer description',
  dmdd: 'device model description',
  targ: 'characterization target',
  vued: 'viewing conditions description',
  meta: 'metadata dictionary',
  ciis: 'colorimetric intent image state',
  scrd: 'screening description',
  calt: 'calibration date',
  ncl2: 'named colours',
  clrt: 'colorant names',
  clot: 'output colorant names',
  pseq: 'profile sequence description',
  psid: 'profile sequence identifiers',
  devs: 'device settings',
  crdi: 'CRD info',
  mmod: 'Apple display make and model (may include a serial number)',
  ndin: 'Apple native display information',
  vcgt: 'display calibration curves (video card gamma)',
};

const four = (b: Buffer, o: number) => b.toString('latin1', o, o + 4);
const clean = (s: string) => s.replace(/\0+$/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim();
const MAX_TAGS = 1000;
const MAX_TAG_BYTES = 4 * 1024 * 1024;

function utf16be(b: Buffer, start: number, bytes: number): string {
  if (bytes <= 0 || start < 0 || start + bytes > b.length) return '';
  return Buffer.from(b.subarray(start, start + (bytes & ~1))).swap16().toString('utf16le');
}

/** Printable ASCII and UTF-16BE runs of >= 4 characters (for tag types without a text decoder). */
function strings(d: Buffer): string[] {
  const out = new Set<string>();
  for (const m of d.toString('latin1').matchAll(/[\x20-\x7e]{4,}/g)) out.add(m[0].trim());
  const w = d.length >= 2 ? Buffer.from(d.subarray(0, d.length & ~1)).swap16().toString('utf16le') : '';
  for (const m of w.matchAll(/[\x20-\x7e -ɏ]{4,}/g)) out.add(m[0].trim());
  return [...out].filter((s) => s.length >= 4);
}

/** Decode the text of a tag (null = not a text type). */
function tagText(b: Buffer, off: number, len: number, type: string): { text: string[]; gap?: string } | null {
  const t = b.subarray(off, off + len);
  try {
    switch (type) {
      case 'text':
        return { text: [clean(t.toString('latin1', 8))] };
      case 'utf8':
        return { text: [clean(t.toString('utf8', 8))] };
      case 'ut16':
        return { text: [clean(utf16be(t, 8, t.length - 8))] };
      case 'desc': {
        const out: string[] = [];
        const n = t.readUInt32BE(8);
        if (12 + n > t.length) return { text: [], gap: 'desc ASCII count out of range' };
        out.push(clean(t.toString('latin1', 12, 12 + n)));
        let p = 12 + n;
        if (p + 8 <= t.length) {
          const un = t.readUInt32BE(p + 4);
          if (p + 8 + un * 2 <= t.length) out.push(clean(utf16be(t, p + 8, un * 2)));
          p += 8 + Math.min(un * 2, t.length);
        }
        if (p + 3 <= t.length) {
          const sn = t[p + 2]!;
          if (sn > 0 && p + 3 + Math.min(sn, 67) <= t.length) out.push(clean(t.toString('latin1', p + 3, p + 3 + Math.min(sn, 67))));
        }
        return { text: out };
      }
      case 'mluc': {
        const n = t.readUInt32BE(8);
        const rs = t.readUInt32BE(12);
        if (rs < 12 || 16 + n * rs > t.length || n > 10_000) return { text: [], gap: 'mluc record table out of range' };
        const out: string[] = [];
        for (let i = 0; i < n; i++) {
          const r = 16 + i * rs;
          const l = t.readUInt32BE(r + 4);
          const o = t.readUInt32BE(r + 8);
          if (o + l > t.length) return { text: out, gap: 'mluc string out of range' };
          out.push(clean(utf16be(t, o, l)));
        }
        return { text: out };
      }
      case 'dict': {
        const n = t.readUInt32BE(8);
        const rs = t.readUInt32BE(12);
        if (![16, 24, 32].includes(rs) || 16 + n * rs > t.length || n > 10_000) return { text: [], gap: 'dict record table out of range' };
        const out: string[] = [];
        for (let i = 0; i < n; i++) {
          const r = 16 + i * rs;
          const name = utf16be(t, t.readUInt32BE(r), t.readUInt32BE(r + 4));
          const value = utf16be(t, t.readUInt32BE(r + 8), t.readUInt32BE(r + 12));
          out.push(clean(`${name}=${value}`));
        }
        // Display names/values (mluc) of 24/32-byte records live after the table.
        if (rs > 16) out.push(...strings(t.subarray(16 + n * rs)));
        return { text: out };
      }
      case 'ncl2': {
        const n = t.readUInt32BE(12);
        const dev = t.readUInt32BE(16);
        const out = [clean(t.toString('latin1', 20, 52)), clean(t.toString('latin1', 52, 84))];
        const rs = 32 + 6 + dev * 2;
        for (let i = 0; i < Math.min(n, 1000); i++) {
          const r = 84 + i * rs;
          if (r + 32 > t.length) return { text: out, gap: 'named colour table out of range' };
          out.push(clean(t.toString('latin1', r, r + 32)));
        }
        return { text: out };
      }
      case 'clrt': {
        const n = t.readUInt32BE(8);
        const out: string[] = [];
        for (let i = 0; i < Math.min(n, 1000); i++) {
          const r = 12 + i * 38;
          if (r + 32 > t.length) return { text: out, gap: 'colorant table out of range' };
          out.push(clean(t.toString('latin1', r, r + 32)));
        }
        return { text: out };
      }
      case 'data': {
        const flag = t.readUInt32BE(8);
        if (flag === 0) return { text: [clean(t.toString('latin1', 12))] };
        return { text: strings(t.subarray(12)), gap: 'binary data tag' };
      }
      case 'dtim': {
        const v = [0, 1, 2, 3, 4, 5].map((i) => t.readUInt16BE(8 + i * 2));
        return { text: [`${v[0]}-${String(v[1]).padStart(2, '0')}-${String(v[2]).padStart(2, '0')}T${String(v[3]).padStart(2, '0')}:${String(v[4]).padStart(2, '0')}:${String(v[5]).padStart(2, '0')}`] };
      }
      case 'pseq':
      case 'psid':
      case 'devs':
      case 'crdi':
      case 'mmod':
      case 'ndin':
        return { text: strings(t.subarray(8)) };
      default:
        return null;
    }
  } catch {
    return { text: [], gap: `tag of type '${type}' could not be decoded` };
  }
}

function iso(b: Buffer): string | null {
  const v = [0, 1, 2, 3, 4, 5].map((i) => b.readUInt16BE(24 + i * 2));
  if (v.every((x) => x === 0)) return null;
  return `${v[0]}-${String(v[1]).padStart(2, '0')}-${String(v[2]).padStart(2, '0')}T${String(v[3]).padStart(2, '0')}:${String(v[4]).padStart(2, '0')}:${String(v[5]).padStart(2, '0')}`;
}

const sigText = (b: Buffer, o: number) => (b.readUInt32BE(o) ? four(b, o).replace(/[^\x20-\x7e]/g, '?') : '');

/** Bounded, defensive ICC parser. `b` is the stored profile blob (it may extend beyond the declared size). */
export function parseIcc(b: Buffer, detailed = false): IccInfo {
  if (b.length < 132 || four(b, 36) !== 'acsp') return iccFail('not a valid ICC profile (no acsp signature)');
  const size = b.readUInt32BE(0);
  if (size > b.length || size < 132) return iccFail('ICC size field out of range');
  const n = b.readUInt32BE(128);
  if (n > MAX_TAGS || 132 + n * 12 > size) return iccFail('ICC tag table out of range');
  const entries: Array<{ sig: string; off: number; len: number }> = [];
  for (let i = 0; i < n; i++) {
    const e = 132 + i * 12;
    const off = b.readUInt32BE(e + 4);
    const len = b.readUInt32BE(e + 8);
    if (off < 128 || off + len > size || len > MAX_TAG_BYTES) return iccFail('ICC tag out of range');
    entries.push({ sig: four(b, e), off, len });
  }

  const findings: IccFinding[] = [];
  const gaps: string[] = [];
  const add = (name: string, value?: string | null) => findings.push({ name, ...(detailed && value ? { value: value.slice(0, 200) } : {}) });

  // Integrity facts that matter even for a profile matching a known hash.
  const idBytes = b.subarray(84, 100);
  const idNonZero = idBytes.some((x) => x !== 0);
  const idMismatch = idNonZero && idBytes.toString('hex') !== specProfileId(b, size);
  const after = b.subarray(size);
  const afterNonZero = after.some((x) => x !== 0);
  const dupes = [...new Set(entries.map((e) => e.sig).filter((s, i, a) => a.indexOf(s) !== i))];

  const canon = iccCanonicalSha256(b);
  const known = canon ? (KNOWN_ICC[canon] ?? null) : null;
  // Text of the description (for the "claims a standard name" note).
  const descEntry = entries.find((e) => e.sig === 'desc');
  const descText = descEntry && descEntry.len >= 12 ? (tagText(b, descEntry.off, descEntry.len, four(b, descEntry.off))?.text ?? []).find((x) => x) ?? '' : '';
  const claimsStandardName = STANDARD_NAME.test(descText.trim());

  const textTags: string[] = [];
  if (known && !idMismatch && !afterNonZero && dupes.length === 0) {
    for (const e of entries) if (e.len >= 12 && tagText(b, e.off, e.len, four(b, e.off))) textTags.push(e.sig);
    return { parsed: true, standard: true, known: known.name, claimsStandardName, textTags: [...new Set(textTags)], findings, gaps };
  }

  add(known ? `ICC profile resembles ${known.name} but its ID, trailing bytes or tag table differ` : `ICC profile is not in the known-profile list${claimsStandardName ? ' (its description claims a standard name, which is not trusted)' : ''}`, descText);
  if (idMismatch) add('ICC profile ID does not match the profile contents', idBytes.toString('hex'));
  else if (idNonZero) add('ICC profile ID (16-byte identifier)', idBytes.toString('hex'));
  if (afterNonZero) add(`${after.length} byte(s) stored after the declared ICC profile size`);
  for (const d of dupes) add(`duplicate ICC tag signature '${d}' (only one copy is used by readers)`);

  // Header.
  const mfr = sigText(b, 48);
  const model = sigText(b, 52);
  if (mfr || model) add('ICC header device manufacturer/model codes', `${mfr}/${model}`);
  const creator = sigText(b, 80);
  const cmm = sigText(b, 4);
  if (creator || cmm) add('ICC header creator/CMM codes', `${creator}/${cmm}`);
  const date = iso(b);
  if (date) add('ICC profile creation date', date);
  if (b.subarray(56, 64).some((x) => x !== 0)) add('ICC header device attributes', b.subarray(56, 64).toString('hex'));
  if (b.subarray(100, 128).some((x) => x !== 0)) add('non-zero reserved ICC header bytes (100-127)', b.subarray(100, 128).toString('hex'));

  // Tags.
  const covered = new Uint8Array(size);
  covered.fill(1, 0, 132 + n * 12);
  for (const e of entries) {
    covered.fill(1, e.off, e.off + e.len);
    if (e.len < 8) {
      add(`ICC tag '${e.sig}' shorter than its type header`);
      continue;
    }
    const type = four(b, e.off);
    const label = TAG_NAMES[e.sig] ?? (STANDARD_TAGS.has(e.sig) ? 'standard tag' : 'private/unknown tag');
    if (NUMERIC_TYPES.has(type)) {
      if (!STANDARD_TAGS.has(e.sig)) add(`private ICC tag '${e.sig}' (${label}; numeric type '${type}', ${e.len} bytes)`);
      continue;
    }
    if (type === 'vcgt' || e.sig === 'vcgt') {
      add(`ICC tag '${e.sig}' (${TAG_NAMES.vcgt}): marks a calibrated, device-specific display profile`);
      continue;
    }
    const t = e.len >= 12 ? tagText(b, e.off, e.len, type) : null;
    if (t) {
      const text = t.text.filter((x) => x);
      if (text.length) {
        textTags.push(e.sig);
        add(`ICC text in tag '${e.sig}' (${label})`, text.join(' | '));
      } else if (e.sig === 'mmod' || type === 'mmod') add(`ICC tag '${e.sig}' (${TAG_NAMES.mmod})`);
      if (t.gap) gaps.push(`ICC tag '${e.sig}' (type '${type}'): ${t.gap}; its content was not fully interpreted`);
      continue;
    }
    // Unknown type: report it, scan it for strings, and record that it was not interpreted.
    const found = strings(b.subarray(e.off + 8, e.off + e.len));
    add(`ICC tag '${e.sig}' (${label}) of unknown type '${type}' (${e.len} bytes)`, found.join(' | '));
    gaps.push(`ICC tag '${e.sig}' of unknown type '${type}' was not interpreted (only scanned for text)`);
  }
  let hidden = 0;
  for (let i = 0; i < size; i++) if (!covered[i] && b[i] !== 0) hidden++;
  if (hidden) add(`${hidden} non-zero byte(s) inside the ICC profile not referenced by any tag`);
  return { parsed: true, standard: false, known: null, claimsStandardName, textTags: [...new Set(textTags)], findings, gaps };
}
