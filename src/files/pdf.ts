/**
 * PDF policy `pdf_document_properties`.
 *
 * Removed: the document information dictionary (Author, Creator, Producer, Title,
 * Subject, Keywords, dates and custom keys), every XMP /Metadata stream (catalog,
 * pages, images, fonts), /PieceInfo application data, unreachable objects, and
 * prior incremental revisions (the output is ONE fully rewritten revision with
 * classic, uncompressed cross-reference data, written by @cantoo/pdf-lib).
 *
 * NOT removed (reported, kept as content): annotations (incl. their /T author
 * names), embedded files, JavaScript/OpenAction, optional-content (hidden) layers,
 * form fields and their values, visible text and images. Signed and encrypted
 * PDFs are refused (signed: unless allowInvalidateSignatures, because any rewrite
 * invalidates signatures).
 *
 * Verification uses Poppler (independent of the writer): pdfinfo (properties, XMP,
 * page count and sizes), pdftotext (text identical), pdftoppm (rendering identical),
 * pdfsig, pdfdetach; plus a byte scan of the output and of its decoded streams for
 * the source's property values in Latin-1, UTF-16BE and hex-string forms.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFObject } from '@cantoo/pdf-lib';
import { RbaError } from '../core/errors.js';
import { decide, sha256, type Check, type Handler, type HandlerEnv, type VerifyReport } from './media.js';

const MAX_RENDER_PAGES = 20;

interface RawFacts {
  revisions: number;
  encrypted: boolean;
  signatureMarkers: string[];
  hasJavaScript: boolean;
  hasOpenAction: boolean;
  hasOptionalContent: boolean;
}

function rawFacts(b: Buffer): RawFacts {
  const s = b.toString('latin1');
  const markers = ['/ByteRange', '/FT /Sig', '/FT/Sig', '/Type /Sig', '/Type/Sig', '/DocMDP', '/Type /DocTimeStamp'].filter((m) => s.includes(m));
  return {
    revisions: Math.max(1, s.split('startxref').length - 1),
    encrypted: /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(s),
    signatureMarkers: markers,
    hasJavaScript: /\/(JS|JavaScript)\b/.test(s),
    hasOpenAction: /\/OpenAction\b/.test(s),
    hasOptionalContent: /\/OCProperties\b/.test(s),
  };
}

/**
 * Distinct property keys of document-information dictionaries referenced by any
 * revision's trailer (earlier revisions stay recoverable in the source bytes).
 * Bounded: at most 16 distinct /Info references, plain substring searches, and a
 * 64 KB window per object. Dictionaries inside compressed object streams are
 * not seen by this raw scan.
 */
export function infoKeysAllRevisions(b: Buffer): { keys: string[]; dictionaries: number } {
  const s = b.toString('latin1');
  const refs: string[] = [];
  const re = /\/Info\s+(\d{1,10})\s+(\d{1,5})\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && refs.length < 16) {
    const r = `${m[1]} ${m[2]} obj`;
    if (!refs.includes(r)) refs.push(r);
  }
  const keys = new Set<string>();
  let dictionaries = 0;
  for (const r of refs) {
    let at = s.indexOf(r);
    let guard = 0;
    while (at >= 0 && guard++ < 32) {
      const end = s.indexOf('endobj', at);
      const body = s.slice(at + r.length, end > at ? Math.min(end, at + 65536) : at + 65536);
      dictionaries++;
      for (const k of body.matchAll(/\/([A-Za-z][A-Za-z0-9]{0,40})\s*[(<\[\/0-9tf]/g)) keys.add(k[1]!);
      at = s.indexOf(r, at + r.length);
    }
  }
  return { keys: [...keys], dictionaries };
}

function text(o: PDFObject | undefined): string | null {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFName) return o.decodeText();
  return o ? o.toString() : null;
}

async function load(b: Buffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(b, { updateMetadata: false });
  } catch (e) {
    const m = (e as Error).message;
    if (/encrypt/i.test(m)) throw new RbaError('invalid_input', 'encrypted PDF: refused (decrypt it yourself first if you are entitled to)');
    throw new RbaError('invalid_input', `PDF could not be parsed: ${m.slice(0, 200)}`);
  }
}

function infoDict(doc: PDFDocument): PDFDict | null {
  const ref = doc.context.trailerInfo.Info;
  const o = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
  return o instanceof PDFDict ? o : null;
}

/** Every dict/stream-dict in the document with its indirect ref. */
function allDicts(doc: PDFDocument): Array<{ ref: PDFRef; dict: PDFDict }> {
  const out: Array<{ ref: PDFRef; dict: PDFDict }> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict) out.push({ ref, dict: obj });
    else if (obj instanceof PDFStream) out.push({ ref, dict: obj.dict });
  }
  return out;
}

interface Structure {
  pages: number;
  infoKeys: string[];
  infoValues: string[];
  metadataStreams: number;
  pieceInfo: number;
  annotations: number;
  annotationAuthors: string[];
  formFields: number;
  /** Form fields holding a value (the value itself is content). */
  formValues: number;
  /** Markup annotations (not form widgets) carrying comment text. */
  annotationsWithText: number;
  /** Embedded JPEG/JPEG2000 images whose own bytes still contain EXIF/XMP/IPTC. */
  imagesWithMetadata: number;
  hasEmbeddedFilesTree: boolean;
}

function structure(doc: PDFDocument): Structure {
  const info = infoDict(doc);
  const infoKeys = info ? info.keys().map((k) => k.decodeText()) : [];
  const infoValues = info ? info.keys().map((k) => text(info.get(k)) ?? '').filter((v) => v.length >= 3) : [];
  let metadataStreams = 0;
  let pieceInfo = 0;
  let annotations = 0;
  let annotationsWithText = 0;
  let formValues = 0;
  let imagesWithMetadata = 0;
  const authors: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const filter = obj.dict.get(PDFName.of('Filter'))?.toString() ?? '';
    if (!/DCTDecode|JPXDecode/.test(filter)) continue;
    const c = Buffer.from(obj.contents);
    if (c.includes(Buffer.from('Exif\0\0', 'latin1')) || c.includes(Buffer.from('<x:xmpmeta')) || c.includes(Buffer.from('Photoshop 3.0'))) imagesWithMetadata++;
  }
  for (const { dict } of allDicts(doc)) {
    if (dict.has(PDFName.of('Metadata'))) metadataStreams++;
    if (dict.has(PDFName.of('PieceInfo'))) pieceInfo++;
    const subtype = dict.get(PDFName.of('Subtype'))?.toString();
    const isWidget = subtype === '/Widget';
    if (dict.has(PDFName.of('FT'))) {
      const v = dict.get(PDFName.of('V'));
      const vt = v instanceof PDFRef ? 'ref' : text(v);
      if (vt && vt !== '()' && vt !== '/Off') formValues++;
    }
    if (!isWidget && (dict.get(PDFName.of('Type'))?.toString() === '/Annot' || (subtype && dict.has(PDFName.of('Rect')) && dict.has(PDFName.of('T'))))) {
      annotations++;
      const t = text(dict.get(PDFName.of('T')));
      if (t) authors.push(t); // /T on a markup annotation = its author
      if (text(dict.get(PDFName.of('Contents')))) annotationsWithText++;
    }
  }
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  return {
    pages: doc.getPageCount(),
    infoKeys,
    infoValues,
    metadataStreams,
    pieceInfo,
    annotations,
    annotationAuthors: [...new Set(authors)],
    formFields: fields?.size() ?? 0,
    formValues,
    annotationsWithText,
    imagesWithMetadata,
    hasEmbeddedFilesTree: !!names?.has(PDFName.of('EmbeddedFiles')),
  };
}

async function popplerSignatures(path: string, env: HandlerEnv): Promise<number | null> {
  try {
    const r = await env.run('pdfsig', ['-nocert', path], { timeoutMs: env.timeoutMs, signal: env.signal });
    const out = r.stdout.toString('utf8') + r.stderr;
    if (/does not contain any signatures/i.test(out)) return 0;
    return (out.match(/^Signature #\d+/gm) ?? []).length;
  } catch (e) {
    // pdfsig exits non-zero for unsigned files and says so on stdout.
    const m = `${(e as Error).message} ${String((e as RbaError).details?.stdoutTail ?? '')}`;
    if (/does not contain any signatures/i.test(m)) return 0;
    if (e instanceof RbaError && e.code === 'cancelled') throw e;
    return null;
  }
}

async function embeddedFiles(path: string, env: HandlerEnv): Promise<number | null> {
  try {
    const r = await env.run('pdfdetach', ['-list', path], { timeoutMs: env.timeoutMs, signal: env.signal });
    const m = /(\d+)\s+embedded files?/i.exec(r.stdout.toString('utf8'));
    return m ? Number(m[1]) : 0;
  } catch (e) {
    if (e instanceof RbaError && e.code === 'cancelled') throw e;
    return null;
  }
}

export const pdfHandler: Handler = {
  async inspect(path, detailed, env) {
    const b = readFileSync(path);
    const raw = rawFacts(b);
    if (raw.encrypted) return { encrypted: true, revisions: raw.revisions, note: 'Encrypted PDF: contents are not inspected and cannot be sanitized.' };
    const doc = await load(b);
    const st = structure(doc);
    const sigs = await popplerSignatures(path, env);
    const files = await embeddedFiles(path, env);
    return {
      pages: st.pages,
      identifyingFieldCounts: {
        documentProperties: st.infoKeys.length,
        xmpMetadataStreams: st.metadataStreams,
        applicationData: st.pieceInfo,
        priorRevisions: raw.revisions - 1,
      },
      documentPropertyNames: st.infoKeys,
      ...(detailed ? { documentPropertyValues: Object.fromEntries(st.infoKeys.map((k) => [k, text(infoDict(doc)!.get(PDFName.of(k)))])) } : {}),
      retainedByPolicy: {
        annotations: st.annotations,
        annotationAuthorNames: detailed ? st.annotationAuthors : st.annotationAuthors.length,
        embeddedFiles: files,
        formFields: st.formFields,
        javaScript: raw.hasJavaScript,
        openAction: raw.hasOpenAction,
        optionalContentLayers: raw.hasOptionalContent,
      },
      signatures: { poppler: sigs, rawMarkers: raw.signatureMarkers },
      documentId: doc.context.trailerInfo.ID ? 'present' : 'absent',
    };
  },

  async sanitize(src, out, opts, env) {
    const b = readFileSync(src);
    const raw = rawFacts(b);
    if (raw.encrypted) throw new RbaError('invalid_input', 'encrypted PDF: refused (the plugin does not decrypt documents)', { verdict: 'unsupported' });
    const sigs = await popplerSignatures(src, env);
    if (sigs === null && !opts.allowInvalidateSignatures) {
      throw new RbaError('invalid_input', 'pdfsig could not determine whether this PDF is signed; re-run with allowInvalidateSignatures: true only if the user accepts that any signature would be invalidated.', { needsDecision: 'allowInvalidateSignatures' });
    }
    if ((sigs ?? 0) > 0 || raw.signatureMarkers.length > 0) {
      if (!opts.allowInvalidateSignatures) {
        throw new RbaError('invalid_input', 'this PDF is digitally signed (or certified); rewriting it will invalidate the signature. Re-run with allowInvalidateSignatures: true only if the user explicitly accepts that.', {
          needsDecision: 'allowInvalidateSignatures',
          signatures: sigs,
          markers: raw.signatureMarkers,
        });
      }
    }
    const doc = await load(b);
    if (doc.isEncrypted) throw new RbaError('invalid_input', 'encrypted PDF: refused', { verdict: 'unsupported' });
    const revInfo = raw.revisions > 1 ? infoKeysAllRevisions(b) : null;
    // Signatures also from the parsed object graph (sees inside compressed object streams).
    const parsedSig = allDicts(doc).some(({ dict }) => ['/Sig', '/DocTimeStamp'].includes(dict.get(PDFName.of('Type'))?.toString() ?? '') || dict.get(PDFName.of('FT'))?.toString() === '/Sig' || dict.has(PDFName.of('ByteRange')));
    if (parsedSig && !opts.allowInvalidateSignatures) {
      throw new RbaError('invalid_input', 'this PDF contains a signature dictionary; rewriting it will invalidate the signature. Re-run with allowInvalidateSignatures: true only if the user explicitly accepts that.', { needsDecision: 'allowInvalidateSignatures' });
    }
    const before = structure(doc);
    const ctx = doc.context;
    // 1. Document information dictionary: delete every key, then drop the dictionary.
    const info = infoDict(doc);
    if (info) for (const k of info.keys()) info.delete(k);
    if (ctx.trailerInfo.Info instanceof PDFRef) ctx.delete(ctx.trailerInfo.Info);
    ctx.trailerInfo.Info = undefined;
    // 2. XMP /Metadata and /PieceInfo on every object, including nested direct dictionaries.
    let metadataRemoved = 0;
    let pieceInfoRemoved = 0;
    const scrub = (d: PDFDict, depth: number) => {
      const m = d.get(PDFName.of('Metadata'));
      if (m) {
        if (m instanceof PDFRef) ctx.delete(m);
        d.delete(PDFName.of('Metadata'));
        metadataRemoved++;
      }
      if (d.get(PDFName.of('PieceInfo'))) {
        d.delete(PDFName.of('PieceInfo'));
        pieceInfoRemoved++;
      }
      if (depth > 32) return;
      for (const [, v] of d.entries()) {
        if (v instanceof PDFDict) scrub(v, depth + 1);
        else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) {
          const x = v.get(i);
          if (x instanceof PDFDict) scrub(x, depth + 1);
        }
      }
    };
    for (const { dict } of allDicts(doc)) scrub(dict, 0);
    // 3. Drop everything not reachable from the catalog (old revisions, orphans).
    const reachable = new Set<string>();
    const visit = (o: PDFObject | undefined) => {
      if (!o) return;
      if (o instanceof PDFRef) {
        const k = o.toString();
        if (reachable.has(k)) return;
        reachable.add(k);
        visit(ctx.lookup(o));
      } else if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v);
      else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) visit(o.get(i));
      else if (o instanceof PDFStream) visit(o.dict);
    };
    visit(ctx.trailerInfo.Root);
    let unreachableRemoved = 0;
    for (const [ref] of ctx.enumerateIndirectObjects()) {
      if (!reachable.has(ref.toString())) {
        ctx.delete(ref);
        unreachableRemoved++;
      }
    }
    const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, bytes, { mode: 0o600 });
    const files = await embeddedFiles(src, env);
    const retained = [
      'page content (text, images, fonts)',
      ...(before.annotations ? [`${before.annotations} annotations (incl. ${before.annotationAuthors.length} author name(s) in /T)`] : []),
      ...(files ? [`${files} embedded file(s)`] : []),
      ...(before.formFields ? [`${before.formFields} form field(s) and their values`] : []),
      ...(raw.hasJavaScript ? ['JavaScript actions'] : []),
      ...(raw.hasOptionalContent ? ['optional-content (hidden) layers'] : []),
    ];
    return {
      policy: 'pdf_document_properties',
      removed: {
        documentProperties: before.infoKeys.length,
        ...(revInfo ? { propertyKeysAcrossRevisions: revInfo.keys.length, priorRevisionInfoDictionaries: Math.max(0, revInfo.dictionaries - 1) } : {}),
        xmpMetadataStreams: metadataRemoved,
        applicationData: pieceInfoRemoved,
        priorRevisions: raw.revisions - 1,
        unreachableObjects: unreachableRemoved,
      },
      retained,
      notes: [
        ...(revInfo
          ? [`The source had ${raw.revisions - 1} earlier revision(s); their objects (including older document properties: ${revInfo.keys.join(', ') || 'none found by raw scan'}) were dropped with them. documentProperties counts only the current revision's keys.`]
          : []),
        'Not removed under this policy: annotations and their author names, embedded files, JavaScript, hidden layers, form values, and anything visible on the page. This is not content redaction.',
        ...((sigs ?? 0) > 0 || raw.signatureMarkers.length ? ['The document was signed; the rewrite invalidated the signature (explicitly allowed).'] : []),
        'The document /ID (file identifier) is left as is; absent in the output when the writer does not emit one.',
      ],
      tools: { '@cantoo/pdf-lib': '2.11.1' },
    };
  },

  async verify(src, out, env) {
    const sb = readFileSync(src);
    const ob = readFileSync(out);
    const checks: Check[] = [];
    const residual: VerifyReport['residual'] = [];
    const limitations: string[] = [];
    const sdoc = await load(sb);
    const sst = structure(sdoc);
    const sraw = rawFacts(sb);
    // Poppler: parse, properties, XMP, page count, page sizes.
    const pinfo = async (p: string, args: string[] = []) => (await env.run('pdfinfo', [...args, p], { timeoutMs: env.timeoutMs, signal: env.signal })).stdout.toString('utf8');
    let outInfo = '';
    try {
      outInfo = await pinfo(out);
      checks.push({ name: 'output_parses', ok: true, method: 'poppler-pdfinfo' });
    } catch (e) {
      checks.push({ name: 'output_parses', ok: false, detail: (e as Error).message.slice(0, 200), method: 'poppler-pdfinfo' });
    }
    if (outInfo) {
      const srcInfo = await pinfo(src);
      const pages = (s: string) => Number(/^Pages:\s+(\d+)/m.exec(s)?.[1] ?? NaN);
      checks.push({ name: 'page_count_equal', ok: pages(srcInfo) === pages(outInfo), detail: `${pages(outInfo)} pages`, method: 'poppler-pdfinfo' });
      const n = Math.min(pages(srcInfo), 200);
      const sizes = async (p: string) => (await pinfo(p, ['-f', '1', '-l', String(n)])).split('\n').filter((l) => /^Page\s+\d+ size:/.test(l)).join('\n');
      checks.push({ name: 'page_sizes_equal', ok: (await sizes(src)) === (await sizes(out)), method: 'poppler-pdfinfo' });
      for (const k of ['Title', 'Subject', 'Keywords', 'Author', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Custom Metadata']) {
        const m = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(outInfo);
        if (m && !(k === 'Custom Metadata' && /^no$/i.test(m[1]!.trim()))) residual.push({ category: 'documentProperties', name: k, where: 'pdfinfo' });
      }
      const meta = (await pinfo(out, ['-meta'])).trim();
      if (/<x:xmpmeta|<rdf:RDF/i.test(meta)) residual.push({ category: 'xmp', name: 'catalog XMP metadata', where: 'pdfinfo -meta' });
      checks.push({ name: 'properties_absent_poppler', ok: residual.filter((r) => r.where.startsWith('pdfinfo')).length === 0, method: 'poppler-pdfinfo' });
    }
    // Text identical.
    try {
      const t = async (p: string) => (await env.run('pdftotext', ['-layout', '-enc', 'UTF-8', p, '-'], { timeoutMs: env.timeoutMs, signal: env.signal })).stdout;
      const [a, b] = [await t(src), await t(out)];
      checks.push({ name: 'text_identical', ok: a.equals(b), detail: `${a.length} bytes of text`, method: 'poppler-pdftotext' });
    } catch (e) {
      if (e instanceof RbaError && e.code === 'cancelled') throw e;
      checks.push({ name: 'text_identical', ok: false, detail: (e as Error).message.slice(0, 200), method: 'poppler-pdftotext' });
    }
    // Rendering identical (first pages, low resolution, greyscale PGM: no metadata in the raster).
    try {
      const pages = Math.min(sst.pages, MAX_RENDER_PAGES);
      const r = async (p: string) => {
        const hashes: string[] = [];
        for (let i = 1; i <= pages; i++) {
          const o = await env.run('pdftoppm', ['-r', '36', '-gray', '-f', String(i), '-l', String(i), p], { timeoutMs: env.timeoutMs, signal: env.signal });
          hashes.push(sha256(o.stdout));
        }
        return hashes.join(',');
      };
      const [a, b] = [await r(src), await r(out)];
      checks.push({ name: 'rendering_identical', ok: a === b, detail: `${pages} page(s) at 36 dpi`, method: 'poppler-pdftoppm' });
      if (sst.pages > MAX_RENDER_PAGES) limitations.push(`Rendering compared for the first ${MAX_RENDER_PAGES} of ${sst.pages} pages; text and page count compared for all.`);
    } catch (e) {
      if (e instanceof RbaError && e.code === 'cancelled') throw e;
      checks.push({ name: 'rendering_identical', ok: null, detail: (e as Error).message.slice(0, 200), method: 'poppler-pdftoppm' });
    }
    // Single revision; signatures; embedded files kept.
    const oraw = rawFacts(ob);
    checks.push({ name: 'single_revision', ok: oraw.revisions === 1, detail: `${oraw.revisions} startxref`, method: 'byte-scan' });
    const [sf, of] = [await embeddedFiles(src, env), await embeddedFiles(out, env)];
    checks.push({ name: 'embedded_files_kept', ok: sf === of, detail: `${of} embedded file(s)`, method: 'poppler-pdfdetach' });
    // Byte scan for the source property values (raw output + decoded streams).
    const forms = (v: string) => {
      const u16 = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(v, 'utf16le').swap16()]);
      const l1 = Buffer.from(v, 'latin1');
      return [l1, u16, Buffer.from(u16.toString('hex').toUpperCase()), Buffer.from(u16.toString('hex')), Buffer.from(l1.toString('hex').toUpperCase()), Buffer.from(l1.toString('hex'))];
    };
    const values = [...new Set(sst.infoValues.filter((v) => v.length >= 4 && !/^D:\d/.test(v)))];
    const needles = values.flatMap((v) => forms(v).map((f) => ({ v, f })));
    const hits = new Set<string>();
    // Embedded JPEG/JPEG2000 images keep their own EXIF/XMP (reported as a retained
    // finding); hits that occur ONLY inside those image streams are not residual.
    const imageBlobs: Buffer[] = [];
    try {
      const idoc = await PDFDocument.load(ob, { updateMetadata: false });
      for (const [, obj] of idoc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image' && /DCTDecode|JPXDecode/.test(obj.dict.get(PDFName.of('Filter'))?.toString() ?? '')) imageBlobs.push(Buffer.from(obj.contents));
      }
    } catch {
      /* parse failure recorded elsewhere */
    }
    const count = (hay: Buffer, needle: Buffer) => {
      let n = 0;
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) n++;
      return n;
    };
    const onlyInImages = (needle: Buffer) => {
      const total = count(ob, needle);
      return total > 0 && imageBlobs.reduce((n, b) => n + count(b, needle), 0) === total;
    };
    const valuesInImages = new Set<string>();
    const xmpSig = Buffer.from('<x:xmpmeta');
    let xmpHit = ob.includes(xmpSig) && !onlyInImages(xmpSig);
    for (const { v, f } of needles) {
      if (!ob.includes(f)) continue;
      if (onlyInImages(f)) valuesInImages.add(v);
      else hits.add(v);
    }
    // Decoded streams: FlateDecode only, bounded per stream and in total, scanned and discarded.
    const PER_STREAM = 8 * 1024 * 1024;
    let budget = 64 * 1024 * 1024;
    let skipped = 0;
    try {
      const odoc = await PDFDocument.load(ob, { updateMetadata: false });
      for (const [, obj] of odoc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream)) continue;
        const filter = obj.dict.get(PDFName.of('Filter'))?.toString();
        if (filter !== '/FlateDecode') continue;
        if (budget <= 0) {
          skipped++;
          continue;
        }
        let d: Buffer;
        try {
          d = inflateSync(obj.contents, { maxOutputLength: Math.min(PER_STREAM, budget) });
        } catch {
          skipped++; // over the cap or undecodable: not scanned
          continue;
        }
        budget -= d.length;
        for (const { v, f } of needles) if (!hits.has(v) && d.includes(f)) hits.add(v);
        if (!xmpHit && d.includes(Buffer.from('<x:xmpmeta'))) xmpHit = true;
      }
    } catch {
      /* output parse failure already recorded */
    }
    for (const v of hits) residual.push({ category: 'value', name: `source property value (length ${v.length})`, where: 'byte-scan' });
    if (xmpHit) residual.push({ category: 'xmp', name: 'XMP packet', where: 'byte-scan' });

    checks.push({ name: 'byte_scan_clean', ok: residual.filter((r) => r.where === 'byte-scan').length === 0, method: 'byte-signature-scan' });
    if (sraw.signatureMarkers.length) limitations.push('The source was signed; signatures are invalid in the output (explicitly allowed).');
    limitations.push('Annotations, embedded files, JavaScript, hidden layers and form values are outside this policy and are kept as content; check them separately if they may identify someone.');
    limitations.push('Dates (D:...) are not byte-scanned (too short/generic); their removal is checked through pdfinfo.');
    const retained = ['page content', ...(sst.annotations ? ['annotations (incl. /T author names)'] : []), ...(sf ? ['embedded files'] : []), ...(sst.formFields ? ['form fields'] : [])];
    // Privacy-relevant information kept by design, measured on the OUTPUT (what would be uploaded).
    const retainedFindings: VerifyReport['retainedFindings'] = [];
    const inspectionGaps: string[] = [];
    // Streams the byte scan could not decode may still hold a removed value: a gap, not a footnote.
    if (skipped) inspectionGaps.push(`${skipped} compressed stream(s) were not decoded for the byte scan (over the size cap or undecodable); their content was not inspected`);
    try {
      const ost = structure(await PDFDocument.load(ob, { updateMetadata: false }));
      if (ost.annotationAuthors.length) retainedFindings.push({ category: 'annotation-authors', name: `${ost.annotationAuthors.length} annotation author name(s) (/T)`, where: 'annotations', count: ost.annotationAuthors.length });
      if (ost.annotationsWithText) retainedFindings.push({ category: 'annotation-text', name: `${ost.annotationsWithText} annotation(s) with comment text`, where: 'annotations', count: ost.annotationsWithText });
      if (ost.formValues) retainedFindings.push({ category: 'form-values', name: `${ost.formValues} filled form field(s)`, where: 'AcroForm', count: ost.formValues });
      if (ost.imagesWithMetadata) retainedFindings.push({ category: 'embedded-image-metadata', name: `${ost.imagesWithMetadata} embedded JPEG image(s) still carrying EXIF/XMP/IPTC${valuesInImages.size ? ` (incl. ${valuesInImages.size} value(s) of removed document properties)` : ''}`, where: 'image XObjects', count: ost.imagesWithMetadata });
    } catch {
      inspectionGaps.push('output structure could not be re-read for retained findings');
    }
    if (of) {
      retainedFindings.push({ category: 'embedded-files', name: `${of} embedded file(s)`, where: 'EmbeddedFiles', count: of });
      inspectionGaps.push(`contents of ${of} embedded file(s) were not inspected`);
    }
    if (oraw.hasOptionalContent) inspectionGaps.push('optional-content (hidden) layers present; their content was not inspected');
    if (oraw.hasJavaScript) inspectionGaps.push('JavaScript present; not inspected');
    const structural = ['output_parses', 'page_count_equal', 'page_sizes_equal', 'text_identical', 'rendering_identical', 'single_revision', 'embedded_files_kept'];
    return { verdict: decide(checks, residual, structural), policy: 'pdf_document_properties', methods: [...new Set(checks.map((c) => c.method))], sameEngine: false, checks, residual, retained, retainedFindings, inspectionGaps, limitations };
  },
};
