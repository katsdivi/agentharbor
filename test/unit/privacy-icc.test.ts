import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { iccCanonicalSha256, parseIcc } from '../../src/files/icc.js';
import { KNOWN_ICC } from '../../src/files/icc-known.js';
import { pngChunk, storedIccBytes } from '../../src/files/images.js';

/** Build an ICC profile from raw tag bodies (each body starts with its 4-byte type). */
function icc(tags: Array<[string, Buffer]>, header: (h: Buffer) => void = () => undefined, extra: Buffer = Buffer.alloc(0)): Buffer {
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
  const h = Buffer.alloc(128);
  h.writeUInt32BE(off + extra.length, 0);
  h.writeUInt32BE(0x02100000, 8);
  h.write('mntrRGB XYZ ', 12, 'latin1');
  h.write('acsp', 36, 'latin1');
  header(h);
  return Buffer.concat([h, table, ...bodies, extra]);
}
const desc = (ascii: string, unicode = '') => {
  const a = Buffer.from(`${ascii}\0`, 'latin1');
  const head = Buffer.alloc(12);
  head.write('desc', 0, 'latin1');
  head.writeUInt32BE(a.length, 8);
  const u = Buffer.from(unicode, 'utf16le').swap16();
  const uh = Buffer.alloc(8);
  uh.writeUInt32BE(unicode.length, 4);
  return Buffer.concat([head, a, uh, u, Buffer.alloc(3 + 67)]);
};
const text = (t: string) => Buffer.concat([Buffer.from('text\0\0\0\0', 'latin1'), Buffer.from(`${t}\0`, 'latin1')]);
const mluc = (...strs: string[]) => {
  const head = Buffer.alloc(16 + strs.length * 12);
  head.write('mluc', 0, 'latin1');
  head.writeUInt32BE(strs.length, 8);
  head.writeUInt32BE(12, 12);
  let off = head.length;
  const parts: Buffer[] = [];
  strs.forEach((s, i) => {
    const u = Buffer.from(s, 'utf16le').swap16();
    head.write(i === 0 ? 'enUS' : 'deDE', 16 + i * 12, 'latin1');
    head.writeUInt32BE(u.length, 16 + i * 12 + 4);
    head.writeUInt32BE(off, 16 + i * 12 + 8);
    parts.push(u);
    off += u.length;
  });
  return Buffer.concat([head, ...parts]);
};
const xyz = () => Buffer.concat([Buffer.from('XYZ \0\0\0\0', 'latin1'), Buffer.alloc(12)]);
const all = (r: ReturnType<typeof parseIcc>) => JSON.stringify(r.findings);

describe('ICC: known profiles are recognised by canonical bytes, never by name', () => {
  const apple = Object.entries(KNOWN_ICC).filter(([, k]) => k.source.startsWith('macOS'));
  it.skipIf(!existsSync('/System/Library/ColorSync/Profiles/sRGB Profile.icc'))('every macOS-derived hash re-derives from the real file and is accepted without findings', () => {
    for (const [hash, k] of apple) {
      const path = k.source.replace(/^macOS \d+ /, '');
      if (!existsSync(path)) continue;
      const b = readFileSync(path);
      expect(iccCanonicalSha256(b), path).toBe(hash);
      const r = parseIcc(b, true);
      expect(r.standard, path).toBe(true);
      expect(r.known).toBe(k.name);
      expect(r.findings).toEqual([]);
      // the creation date is excluded from the canonical hash; content is not
      const redated = Buffer.from(b);
      redated.writeUInt16BE(1999, 24);
      expect(parseIcc(redated).standard).toBe(true);
      const altered = Buffer.from(b);
      altered[altered.length - 1] ^= 0x01;
      expect(parseIcc(altered).standard).toBe(false);
    }
  });

  it.skipIf(!existsSync('/System/Library/ColorSync/Profiles/sRGB Profile.icc'))('a known profile with a wrong profile ID or trailing bytes is not trusted', () => {
    const b = readFileSync('/System/Library/ColorSync/Profiles/sRGB Profile.icc');
    const id = Buffer.from(b);
    Buffer.from('CANARY_ICC_ID_01', 'latin1').copy(id, 84);
    const r = parseIcc(id, true);
    expect(r.standard).toBe(false);
    expect(all(r)).toMatch(/profile ID does not match/);
    const trailing = Buffer.concat([b, Buffer.from('CANARY_TRAILING')]);
    expect(all(parseIcc(trailing))).toMatch(/after the declared ICC profile size/);
  });

  it('a standard NAME is not trusted: device text under "sRGB IEC61966-2.1" is reported', () => {
    const p = icc([
      ['desc', desc('sRGB IEC61966-2.1')],
      ['cprt', text('Copyright International Color Consortium')],
      ['dmdd', desc('CANARY_ICC_DEVICE model 27 serial 0042')],
      ['wtpt', xyz()],
    ]);
    const r = parseIcc(p, true);
    expect(r.standard).toBe(false);
    expect(r.claimsStandardName).toBe(true);
    expect(all(r)).toMatch(/claims a standard name/);
    expect(all(r)).toContain('CANARY_ICC_DEVICE');
    // names only without detailed
    expect(JSON.stringify(parseIcc(p, false))).not.toContain('CANARY_ICC_DEVICE');
  });

  it('"Display ..." is not a free pass any more', () => {
    const r = parseIcc(icc([['desc', desc('Display calibrated for CANARY_PERSON')]]), true);
    expect(r.standard).toBe(false);
    expect(all(r)).toContain('CANARY_PERSON');
  });

  it('reads every mluc record and the Unicode part of desc', () => {
    const r = parseIcc(icc([['desc', mluc('Generic', 'CANARY_SECOND_RECORD')], ['dmnd', desc('Vendor', 'CANARY_UNICODE_PART')]]), true);
    expect(all(r)).toContain('CANARY_SECOND_RECORD');
    expect(all(r)).toContain('CANARY_UNICODE_PART');
  });

  it('reports header creator/device/date/reserved fields', () => {
    const r = parseIcc(
      icc([['desc', desc('x')]], (h) => {
        h.write('CNRY', 80, 'latin1'); // creator
        h.write('MFR1', 48, 'latin1');
        h.writeUInt16BE(2024, 24);
        h.writeUInt16BE(5, 26);
        h.writeUInt16BE(17, 28);
        h[110] = 7; // reserved
      }),
      true,
    );
    const s = all(r);
    expect(s).toMatch(/creator\/CMM codes.*CNRY/);
    expect(s).toMatch(/manufacturer\/model codes.*MFR1/);
    expect(s).toMatch(/creation date.*2024-05-17/);
    expect(s).toMatch(/reserved ICC header bytes/);
  });

  it('private and unknown tags are findings; unknown types are also gaps; duplicates and hidden bytes are reported', () => {
    const priv = Buffer.concat([Buffer.from('zzzz\0\0\0\0', 'latin1'), Buffer.from('owner CANARY_PRIVATE_TAG', 'latin1')]);
    const mmod = Buffer.concat([Buffer.from('mmod\0\0\0\0', 'latin1'), Buffer.from('SN CANARY_SERIAL_9', 'latin1')]);
    const p = icc(
      [
        ['desc', desc('x')],
        ['ABCD', priv],
        ['mmod', mmod],
        ['wtpt', xyz()],
        ['wtpt', xyz()],
        ['PRV1', xyz()],
      ],
      () => undefined,
      Buffer.from('HIDDEN', 'latin1'),
    );
    const r = parseIcc(p, true);
    const s = all(r);
    expect(s).toContain('CANARY_PRIVATE_TAG');
    expect(s).toContain('CANARY_SERIAL_9');
    expect(s).toMatch(/duplicate ICC tag signature 'wtpt'/);
    expect(s).toMatch(/private ICC tag 'PRV1'/);
    expect(s).toMatch(/not referenced by any tag/);
    expect(r.gaps.join(' ')).toMatch(/'ABCD' of unknown type 'zzzz'/);
  });

  it('PNG: the stored ICC bytes are the inflated profile (so values inside it can be attributed)', () => {
    const prof = icc([['desc', desc('CANARY_PNG_ICC')]]);
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('iCCP', Buffer.concat([Buffer.from('p\0\0', 'latin1'), deflateSync(prof)])), pngChunk('IEND', Buffer.alloc(0))]);
    const got = storedIccBytes('png', png);
    expect(got && createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(prof).digest('hex'));
  });
});
