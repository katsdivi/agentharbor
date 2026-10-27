/**
 * Format handlers for media_inspect / media_sanitize / media_verify.
 *
 * Verdicts (decided per policy, never "anonymous" or "all metadata removed"):
 *  - failed: output does not parse, structure differs (pages / streams / pixels /
 *    packets), or the source file changed.
 *  - partial: structure intact, but a TARGETED field is still detectable by one of
 *    the verification methods (including byte-scan hits that cannot be ruled out).
 *  - verified_for_policy: every targeted field is absent under every method used.
 *    Categories the policy deliberately keeps are listed as `retained` and do not
 *    downgrade the verdict.
 *  - unsupported: no handler for this format in this release.
 * Each report lists the methods used and whether the same engine both wrote and
 * checked the output (`sameEngine`).
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { RbaError } from '../core/errors.js';
import { defaultRunner, toolVersion, which, type Runner } from './exec.js';
import { capabilities, type FileFormat } from './formats.js';
import { IMAGE_REMOVED_CATEGORIES, inspectImage, parseExif, parseJpeg, parsePng, parseWebp, sanitizeImage, storedIccBytes, type ImageReport } from './images.js';

export type Verdict = 'verified_for_policy' | 'partial' | 'unsupported' | 'failed';

export interface Check {
  name: string;
  ok: boolean | null; // null = could not be performed
  detail?: string;
  method: string;
}

export interface VerifyReport {
  verdict: Verdict;
  policy: string;
  methods: string[];
  sameEngine: boolean;
  checks: Check[];
  /** TARGETED metadata still detectable: makes the verdict "partial". */
  residual: Array<{ category: string; name: string; where: string }>;
  retained: string[];
  /**
   * Privacy-relevant information KEPT BY DESIGN in preserved structures (annotation
   * authors, form values, attachments, chapter titles, artwork, ICC device text...).
   * Does not change the verdict; a requireSanitized upload needs an explicit decision.
   */
  retainedFindings: Array<{ category: string; name: string; where: string; count?: number }>;
  /** Preserved structures that were NOT inspected (also need the explicit decision). */
  inspectionGaps: string[];
  limitations: string[];
  sourceSha256Unchanged: boolean;
  outputSha256: string;
  /** Version of the inspection policy (POLICY_VERSIONS) that produced this report. */
  policyVersion: number;
  /** Random id of this verification run (binds acceptance decisions to it). */
  verificationId: string;
  verifiedAt: string;
}

/**
 * Inspection policy versions. Bump when what a verification inspects or reports
 * changes; stored reports of an older (or no) version are stale: a
 * requireSanitized upload then asks for media_verify first.
 *  - 2: ICC profiles trusted only by canonical hash; uninspected artwork / undecoded
 *    PDF streams are inspection gaps (not limitations); reports are versioned.
 */
export const POLICY_VERSIONS: Record<string, number> = {
  image_metadata: 2,
  pdf_document_properties: 2,
  av_container_tags: 2,
};

export interface SanitizeInfo {
  policy: string;
  removed: Record<string, number>;
  retained: string[];
  notes: string[];
  tools: Record<string, string | null>;
}

export interface HandlerEnv {
  run: Runner;
  signal?: AbortSignal;
  timeoutMs: number;
  maxImagePixels: number;
  tmp: (ext: string) => string;
}

export interface SanitizeOptions {
  /** JPEG: drop bytes after EOI (e.g. an embedded motion-photo video). */
  removeTrailingData?: boolean;
  /** PDF: required when the document is signed (any rewrite invalidates signatures). */
  allowInvalidateSignatures?: boolean;
  /** MP4/MOV: drop data streams (timecode/telemetry, which may hold GPS). */
  dropDataStreams?: boolean;
  /** Images: C2PA content credentials are removed only with this explicit decision (removal invalidates them). */
  allowRemoveContentCredentials?: boolean;
}

export interface Handler {
  inspect(path: string, detailed: boolean, env: HandlerEnv): Promise<Record<string, unknown>>;
  /** Writes the cleaned file to outPath. Throws RbaError('invalid_input', ...) with `needsDecision` details when an explicit choice is required. */
  sanitize(srcPath: string, outPath: string, opts: SanitizeOptions, env: HandlerEnv): Promise<SanitizeInfo>;
  verify(srcPath: string, outPath: string, env: HandlerEnv): Promise<Omit<VerifyReport, 'sourceSha256Unchanged' | 'outputSha256' | 'policyVersion' | 'verificationId' | 'verifiedAt'>>;
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** One unambiguous sentence for a verification report (never "anonymous" / "all metadata removed"). */
export function summarize(v: Pick<VerifyReport, 'verdict' | 'policy' | 'residual' | 'retainedFindings' | 'inspectionGaps'>): string {
  const kept = `${v.retainedFindings.length} privacy-relevant item(s) kept by design${v.retainedFindings.length ? ` (${v.retainedFindings.map((f) => f.category).join(', ')})` : ''}; ${v.inspectionGaps.length} preserved structure(s) not inspected`;
  switch (v.verdict) {
    case 'verified_for_policy':
      return `The fields targeted by policy ${v.policy} were not detected in the output by the listed methods, and the content structure is intact. ${kept}. This is not a statement that the file contains no identifying information.`;
    case 'partial':
      return `Structure intact, but ${v.residual.length} targeted field(s) are still detectable (see residual). ${kept}.`;
    case 'failed':
      return 'Verification failed (output unreadable, content changed, or source changed); no output is kept.';
    default:
      return 'Unsupported format: nothing was changed.';
  }
}

export function decide(checks: Check[], residual: VerifyReport['residual'], structuralNames: string[]): Verdict {
  if (checks.some((c) => c.ok === false && structuralNames.includes(c.name))) return 'failed';
  if (residual.length > 0 || checks.some((c) => c.ok === false)) return 'partial';
  if (checks.some((c) => c.ok === null && structuralNames.includes(c.name))) return 'partial';
  return 'verified_for_policy';
}

// ---------------------------------------------------------------- images

const DEMUX: Record<string, string> = { jpeg: 'jpeg_pipe', png: 'png_pipe', webp: 'webp_pipe' };

function imgFormat(b: Buffer): 'jpeg' | 'png' | 'webp' {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  return 'webp';
}

function checkPixels(r: ImageReport, env: HandlerEnv) {
  if (r.width !== null && r.height !== null && r.width * r.height > env.maxImagePixels) {
    throw new RbaError('invalid_input', `image is ${r.width}x${r.height} pixels; the limit is ${env.maxImagePixels} (RBA_MAX_IMAGE_MEGAPIXELS)`);
  }
}

/** Independent decoder: hash of every decoded frame (no auto-rotation), via ffmpeg. */
async function decodedHash(path: string, format: string, env: HandlerEnv): Promise<string> {
  const r = await env.run(
    'ffmpeg',
    ['-hide_banner', '-v', 'error', '-nostdin', '-noautorotate', '-protocol_whitelist', 'file', '-f', DEMUX[format]!, '-i', `file:${path}`, '-map', '0:v:0', '-f', 'hash', '-hash', 'sha256', '-'],
    { timeoutMs: env.timeoutMs, signal: env.signal },
  );
  const m = /SHA256=([0-9a-f]{64})/.exec(r.stdout.toString('utf8'));
  if (!m) throw new Error('ffmpeg produced no hash');
  return m[1]!;
}

/** Literal values (>= 4 chars) of identifying fields in the source, for the byte scan. */
function identifyingValues(r: ImageReport): string[] {
  return [
    ...new Set(
      r.fields
        .map((f) => (f.value ?? '').trim())
        .filter((v) => v.length >= 4 && !/^\[/.test(v) && !/^\d+(\/\d+)?( \d+\/\d+)*$/.test(v)),
    ),
  ];
}

export const imageHandler: Handler = {
  async inspect(path, detailed, env) {
    const b = readFileSync(path);
    const r = inspectImage(imgFormat(b), b, detailed);
    checkPixels(r, env);
    return {
      format: r.format,
      dimensions: r.width !== null ? { width: r.width, height: r.height } : null,
      identifyingFieldCounts: r.categories,
      identifyingFieldNames: [...new Set(r.fields.map((f) => `${f.container}:${f.name}`))].slice(0, 100),
      ...(detailed ? { detail: r.fields } : {}),
      retainedByPolicy: {
        orientation: r.orientation,
        iccColourProfile: r.iccProfileSha256 ? 'present' : 'absent',
        adobeColourTransform: r.adobeApp14,
        trailingBytesAfterImage: r.trailingBytes,
        unknownChunks: r.unknownChunks,
        animated: r.animated,
        iccProfileInspection: r.icc ? (r.icc.parsed ? { knownProfile: r.icc.known, standardProfile: r.icc.standard, claimsStandardName: r.icc.claimsStandardName, textTags: r.icc.textTags, findings: r.icc.findings, notInterpreted: r.icc.gaps } : { inspected: false, reason: r.icc.error }) : null,
      },
    };
  },

  async sanitize(src, out, opts, env) {
    const b = readFileSync(src);
    const f = imgFormat(b);
    const before = inspectImage(f, b, false);
    checkPixels(before, env);
    if (before.categories.contentCredentials && !opts.allowRemoveContentCredentials) {
      throw new RbaError('invalid_input', 'this image carries C2PA content credentials (provenance). Removing them invalidates that provenance record. Re-run with allowRemoveContentCredentials: true only if the user explicitly accepts that.', {
        needsDecision: 'allowRemoveContentCredentials',
      });
    }
    let cleaned: Buffer;
    try {
      cleaned = sanitizeImage(f, b, opts);
    } catch (e) {
      throw new RbaError('invalid_input', (e as Error).message);
    }
    writeFileSync(out, cleaned, { mode: 0o600 });
    const retained = ['compressed image data (byte-for-byte)'];
    if (before.orientation && before.orientation !== 1) retained.push(`orientation ${before.orientation} (minimal EXIF with only the Orientation tag)`);
    if (before.iccProfileSha256) retained.push('ICC colour profile');
    if (before.adobeApp14) retained.push('JPEG APP14 Adobe colour transform');
    if (before.trailingBytes > 0 && !opts.removeTrailingData) retained.push(`${before.trailingBytes} bytes after the image end (e.g. motion-photo video; pass removeTrailingData to drop)`);
    return {
      policy: 'image_metadata',
      removed: { ...(before.categories as Record<string, number>), ...(before.unknownChunks.length ? { unknownAncillaryChunks: before.unknownChunks.length } : {}) },
      retained,
      notes: [
        ...(before.unknownChunks.length ? [`Unknown ancillary chunks removed (not needed for rendering): ${before.unknownChunks.join(', ')}`] : []),
        ...(before.trailingBytes > 0 && !opts.removeTrailingData ? [`${before.trailingBytes} bytes after the image end were kept and are NOT inspected (they may hold e.g. a motion-photo video with its own GPS); the verdict is at most "partial" until removeTrailingData is used.`] : []),
        ...(f !== 'jpeg' && before.orientation && before.orientation !== 1 ? ['PNG/WebP EXIF orientation is honoured by some viewers only; it was preserved, not applied to the pixels.'] : []),
        ...(f === 'jpeg' && before.fields.some((x) => x.container === 'APP2-MPF') && before.trailingBytes > 0 && !opts.removeTrailingData
          ? [`The MPF index was removed, but the embedded preview/depth images it referenced are in the ${before.trailingBytes} trailing bytes and may carry their own EXIF/GPS; pass removeTrailingData to drop them.`]
          : []),
      ],
      tools: { 'rba-container-rewriter': 'built-in (no re-encoding)' },
    };
  },

  async verify(src, out, env) {
    const sb = readFileSync(src);
    const ob = readFileSync(out);
    const f = imgFormat(sb);
    const checks: Check[] = [];
    const residual: VerifyReport['residual'] = [];
    const limitations: string[] = [];
    let srcR: ImageReport;
    let outR: ImageReport | null = null;
    srcR = inspectImage(f, sb, true);
    try {
      if (f === 'jpeg') parseJpeg(ob);
      else if (f === 'png') parsePng(ob);
      else parseWebp(ob);
      outR = inspectImage(f, ob, true);
      checks.push({ name: 'output_parses', ok: true, method: 'rba-container-parser' });
    } catch (e) {
      checks.push({ name: 'output_parses', ok: false, detail: (e as Error).message, method: 'rba-container-parser' });
    }
    if (outR) {
      for (const fl of outR.fields) if (IMAGE_REMOVED_CATEGORIES.includes(fl.category)) residual.push({ category: fl.category, name: fl.name, where: fl.container });
      for (const c of outR.unknownChunks) residual.push({ category: 'other', name: `unknown chunk ${c}`, where: 'container' });
      if (outR.trailingBytes > 0) residual.push({ category: 'unscanned', name: `${outR.trailingBytes} bytes after the image end, not inspected`, where: 'container' });
      checks.push({ name: 'dimensions_equal', ok: outR.width === srcR.width && outR.height === srcR.height, detail: `${outR.width}x${outR.height}`, method: 'rba-container-parser' });
      checks.push({ name: 'icc_profile_unchanged', ok: outR.iccProfileSha256 === srcR.iccProfileSha256, method: 'rba-container-parser' });
      checks.push({ name: 'orientation_preserved', ok: (outR.orientation ?? 1) === (srcR.orientation ?? 1), detail: String(outR.orientation ?? 1), method: 'rba-container-parser' });
      if (f === 'jpeg') checks.push({ name: 'adobe_app14_preserved', ok: outR.adobeApp14 === srcR.adobeApp14, method: 'rba-container-parser' });
    }
    // Independent byte scan: metadata signatures and the source's identifying values.
    const latin = ob.toString('latin1');
    const sigs: Array<[string, string]> = [
      ['<x:xmpmeta', 'xmp'],
      ['http://ns.adobe.com/xap/1.0/', 'xmp'],
      ['Photoshop 3.0', 'iptc'],
      ['8BIM', 'iptc'],
      ['MPF\0', 'embeddedPreviews'],
      ['JFXX\0', 'embeddedPreviews'],
    ];
    for (const [s, cat] of sigs) if (latin.includes(s)) residual.push({ category: cat, name: `byte signature ${JSON.stringify(s)}`, where: 'byte-scan' });
    const exifCount = latin.split('Exif\0\0').length - 1;
    if (exifCount > (outR && outR.orientation && outR.orientation !== 1 && f === 'jpeg' ? 1 : 0)) residual.push({ category: 'other', name: 'extra Exif header', where: 'byte-scan' });
    // A hit that occurs only inside the retained ICC profile is a retained finding
    // (identifying text in a structure kept for rendering), not leftover targeted metadata.
    const icc = storedIccBytes(f, ob);
    const count = (hay: Buffer, needle: Buffer) => {
      let n = 0;
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) n++;
      return n;
    };
    const valueInIcc: string[] = [];
    for (const v of identifyingValues(srcR)) {
      for (const needle of [Buffer.from(v, 'latin1'), Buffer.from(v, 'utf16le'), Buffer.from(v, 'utf16le').swap16()]) {
        const total = count(ob, needle);
        const inIcc = icc ? count(icc, needle) : 0;
        if (!total && !inIcc) continue;
        // PNG iCCP is compressed: a value inside it is found only in the inflated profile.
        if (inIcc && (total === 0 || (f !== 'png' && inIcc === total))) valueInIcc.push(v);
        else residual.push({ category: 'value', name: `source value of length ${v.length} still present`, where: 'byte-scan' });
        break;
      }
    }
    checks.push({ name: 'byte_scan_clean', ok: residual.filter((r) => r.where === 'byte-scan').length === 0, method: 'byte-signature-scan' });
    // Independent decoder: pixels identical.
    try {
      const [a, b] = [await decodedHash(src, f, env), await decodedHash(out, f, env)];
      checks.push({ name: 'decoded_pixels_identical', ok: a === b, detail: a === b ? 'sha256 of decoded frames equal' : 'decoded pixels differ', method: 'ffmpeg-decode' });
    } catch (e) {
      if (e instanceof RbaError && e.code === 'cancelled') throw e;
      checks.push({ name: 'decoded_pixels_identical', ok: null, detail: (e as Error).message.slice(0, 200), method: 'ffmpeg-decode' });
      limitations.push('ffmpeg could not decode this image (e.g. animated WebP); pixel identity not independently verified.');
    }
    // Optional extra independent tool.
    if (which('exiftool')) {
      try {
        const r = await env.run('exiftool', ['-j', '-G1', '-a', '-n', '--', out], { timeoutMs: env.timeoutMs, signal: env.signal });
        const j = JSON.parse(r.stdout.toString('utf8'))[0] as Record<string, unknown>;
        const bad = Object.keys(j).filter((k) => /^(GPS|IFD0:(Make|Model|Artist|Copyright|Software|DateTime)|ExifIFD:|XMP|IPTC|IFD1:|MakerNotes)/.test(k) && !/Orientation/.test(k));
        for (const k of bad) residual.push({ category: 'exiftool', name: k, where: 'exiftool' });
        checks.push({ name: 'exiftool_clean', ok: bad.length === 0, method: 'exiftool' });
      } catch {
        checks.push({ name: 'exiftool_clean', ok: null, method: 'exiftool' });
      }
    } else limitations.push('exiftool not installed: no third-party metadata reader was used (optional; see npm run doctor).');
    limitations.push('The container parser that wrote the output also inspected it; independence comes from the byte scan and the ffmpeg pixel decode.');
    const retained = ['compressed image data', ...(srcR.iccProfileSha256 ? ['ICC colour profile'] : []), ...(srcR.orientation && srcR.orientation !== 1 ? ['orientation tag'] : []), ...(srcR.trailingBytes ? ['bytes after image end (if not removed)'] : [])];
    const retainedFindings: VerifyReport['retainedFindings'] = [];
    const inspectionGaps: string[] = [];
    if (outR?.icc) {
      if (!outR.icc.parsed) inspectionGaps.push(`retained ICC profile could not be parsed (${outR.icc.error}); its text fields were not inspected`);
      for (const fd of outR.icc.findings) retainedFindings.push({ category: 'icc', name: fd.name, where: 'ICC profile (kept for colour rendering)' });
      for (const g of outR.icc.gaps) inspectionGaps.push(`retained ${g}`);
    }
    if (valueInIcc.length) retainedFindings.push({ category: 'icc', name: `${valueInIcc.length} value(s) of removed metadata fields also appear in the retained ICC profile text`, where: 'ICC profile (kept for colour rendering)', count: valueInIcc.length });
    if (outR && outR.orientation && outR.orientation !== 1) {
      // The retained EXIF block must hold only the orientation tag (anything else is residual above).
      checks.push({ name: 'retained_exif_orientation_only', ok: !outR.fields.some((x) => x.container.includes('Exif') || x.container.startsWith('eXIf') || x.container.startsWith('EXIF')), method: 'rba-container-parser' });
    }
    const structural = ['output_parses', 'dimensions_equal', 'icc_profile_unchanged', 'orientation_preserved', 'adobe_app14_preserved', 'decoded_pixels_identical'];
    return { verdict: decide(checks, residual, structural), policy: 'image_metadata', methods: [...new Set(checks.map((c) => c.method))], sameEngine: false, checks, residual, retained, retainedFindings, inspectionGaps, limitations };
  },
};

// ---------------------------------------------------------------- registry of handlers

const handlers: Partial<Record<FileFormat, () => Promise<Handler>>> = {
  jpeg: async () => imageHandler,
  png: async () => imageHandler,
  webp: async () => imageHandler,
  pdf: async () => (await import('./pdf.js')).pdfHandler,
  mp3: async () => (await import('./av.js')).avHandler,
  flac: async () => (await import('./av.js')).avHandler,
  wav: async () => (await import('./av.js')).avHandler,
  m4a: async () => (await import('./av.js')).avHandler,
  mp4: async () => (await import('./av.js')).avHandler,
  mov: async () => (await import('./av.js')).avHandler,
};

export async function handlerFor(format: FileFormat): Promise<Handler> {
  const h = handlers[format];
  const cap = capabilities(format);
  if (!h || !cap.sanitize) throw new RbaError('invalid_input', `unsupported format "${format}" in this release: ${cap.unsupportedReason ?? 'no handler'}`, { verdict: 'unsupported' });
  return h();
}

export async function toolVersions(names: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const n of names) out[n] = await toolVersion(n);
  return out;
}

export function removeQuietly(p: string): void {
  rmSync(p, { force: true });
}

export const defaultEnv = (o: { timeoutMs: number; maxImagePixels: number; tmp: (ext: string) => string; signal?: AbortSignal; run?: Runner }): HandlerEnv => ({
  run: o.run ?? defaultRunner,
  signal: o.signal,
  timeoutMs: o.timeoutMs,
  maxImagePixels: o.maxImagePixels,
  tmp: o.tmp,
});

export { parseExif };
