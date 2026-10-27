/**
 * Format detection (magic bytes, never the file extension) and the capability
 * matrix. Only formats whose metadata removal AND output verification are
 * implemented and tested are marked sanitizable; everything else is reported
 * as unsupported with the reason.
 */

export type FileFormat =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'pdf'
  | 'mp3'
  | 'flac'
  | 'wav'
  | 'mp4'
  | 'mov'
  | 'm4a'
  | 'tiff'
  | 'mkv'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'zip'
  | 'unknown';

export type MediaKind = 'image' | 'document' | 'audio' | 'video' | 'other';

export interface FormatInfo {
  format: FileFormat;
  kind: MediaKind;
  mime: string;
  ext: string;
}

export interface Capabilities {
  inspect: boolean;
  sanitize: boolean;
  verify: boolean;
  /** The removal policy implemented for this format (null when unsupported). */
  policy: string | null;
  /** Why something is unsupported in this release. */
  unsupportedReason?: string;
  /** External tools needed (see `npm run doctor`). */
  requires: string[];
}

const INFO: Record<FileFormat, Omit<FormatInfo, 'format'>> = {
  jpeg: { kind: 'image', mime: 'image/jpeg', ext: 'jpg' },
  png: { kind: 'image', mime: 'image/png', ext: 'png' },
  webp: { kind: 'image', mime: 'image/webp', ext: 'webp' },
  pdf: { kind: 'document', mime: 'application/pdf', ext: 'pdf' },
  mp3: { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' },
  flac: { kind: 'audio', mime: 'audio/flac', ext: 'flac' },
  wav: { kind: 'audio', mime: 'audio/wav', ext: 'wav' },
  mp4: { kind: 'video', mime: 'video/mp4', ext: 'mp4' },
  mov: { kind: 'video', mime: 'video/quicktime', ext: 'mov' },
  m4a: { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' },
  tiff: { kind: 'image', mime: 'image/tiff', ext: 'tiff' },
  mkv: { kind: 'video', mime: 'video/x-matroska', ext: 'mkv' },
  docx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  pptx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  xlsx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  zip: { kind: 'other', mime: 'application/zip', ext: 'zip' },
  unknown: { kind: 'other', mime: 'application/octet-stream', ext: 'bin' },
};

export function formatInfo(format: FileFormat): FormatInfo {
  return { format, ...INFO[format] };
}

/** Detect from the first bytes (at least 64 KB recommended for ZIP/Office detection). */
export function detectFormat(head: Buffer): FormatInfo {
  const b = head;
  const ascii = (o: number, n: number) => b.subarray(o, o + n).toString('latin1');
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return formatInfo('jpeg');
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return formatInfo('png');
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return formatInfo('webp');
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return formatInfo('wav');
  if (b.length >= 4 && ascii(0, 4) === 'fLaC') return formatInfo('flac');
  if (b.length >= 3 && ascii(0, 3) === 'ID3') return formatInfo('mp3');
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return formatInfo('mp3'); // MPEG audio frame sync, layer != reserved
  if (b.length >= 4 && (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*')) return formatInfo('tiff');
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return formatInfo('mkv'); // EBML (Matroska/WebM)
  if (b.indexOf(Buffer.from('%PDF-')) >= 0 && b.indexOf(Buffer.from('%PDF-')) < 1024) return formatInfo('pdf');
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    const size = b.readUInt32BE(0);
    const compat = size >= 16 && size <= b.length ? b.subarray(16, size).toString('latin1') : '';
    if (brand === 'qt  ') return formatInfo('mov');
    if (brand === 'M4A ' || brand === 'M4B ') return formatInfo('m4a');
    if (['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].includes(brand) || /isom|mp41|mp42/.test(compat)) return formatInfo('mp4');
    return formatInfo('unknown');
  }
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    // Office Open XML: identified by its first part names (heuristic; inspection only).
    const s = b.toString('latin1');
    if (s.includes('word/')) return formatInfo('docx');
    if (s.includes('ppt/')) return formatInfo('pptx');
    if (s.includes('xl/')) return formatInfo('xlsx');
    return formatInfo('zip');
  }
  return formatInfo('unknown');
}

const UNSUPPORTED: Partial<Record<FileFormat, string>> = {
  tiff: 'TIFF stores metadata inside the image IFD structure (often with multiple pages and private tags); safe removal needs ExifTool-class rewriting that is not implemented and verified in this release.',
  mkv: 'Matroska can carry attachments (fonts, images) and nested tags; removal policy and verification are not implemented in this release.',
  docx: 'Office documents: properties, comments, revisions, hidden content and embedded objects need separate handling, and output verification needs an independent Office renderer (LibreOffice not available); not implemented in this release.',
  pptx: 'Office documents: not implemented in this release (see docx).',
  xlsx: 'Office documents: not implemented in this release (see docx).',
  zip: 'Archives are not inspected or modified.',
  unknown: 'Unrecognised format.',
};

export function capabilities(format: FileFormat): Capabilities {
  switch (format) {
    case 'jpeg':
    case 'png':
    case 'webp':
      return { inspect: true, sanitize: true, verify: true, policy: 'image_metadata', requires: ['ffmpeg (pixel verification)'] };
    case 'pdf':
      return { inspect: true, sanitize: true, verify: true, policy: 'pdf_document_properties', requires: ['poppler: pdfinfo, pdftotext, pdftocairo, pdfsig, pdfdetach'] };
    case 'mp3':
    case 'flac':
    case 'wav':
    case 'm4a':
    case 'mp4':
    case 'mov':
      return { inspect: true, sanitize: true, verify: true, policy: 'av_container_tags', requires: ['ffmpeg', 'ffprobe'] };
    default:
      return { inspect: false, sanitize: false, verify: false, policy: null, unsupportedReason: UNSUPPORTED[format] ?? 'unsupported', requires: [] };
  }
}

/** The full matrix (for docs and the doctor). */
export const SUPPORTED_FORMATS: FileFormat[] = ['jpeg', 'png', 'webp', 'pdf', 'mp3', 'flac', 'wav', 'm4a', 'mp4', 'mov'];
export const UNSUPPORTED_FORMATS: FileFormat[] = ['tiff', 'mkv', 'docx', 'pptx', 'xlsx'];
