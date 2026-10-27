import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultEnv } from '../../src/files/media.js';
import { PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { deflateSync } from 'node:zlib';
import { infoKeysAllRevisions, pdfHandler } from '../../src/files/pdf.js';
import { inspectFile, sanitizeFile, verifyFile } from '../../src/files/service.js';
import { testCtx } from '../helpers/ctx.js';
import { HAVE_POPPLER, PDF_BODY_TEXT, PDF_SECRETS, makePdf } from '../fixtures/media.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'rba-pdf-'));
  return { ctx: testCtx({ RBA_IMPORT_ROOTS: root }), root };
}
const run = (ctx: ReturnType<typeof setup>['ctx'], id: string, opts = {}) => sanitizeFile(ctx, 'test', id, opts, new AbortController().signal);
const pdfinfo = (p: string, args: string[] = []) => execFileSync('pdfinfo', [...args, p]).toString();
/** Encodings a PDF string can take: Latin-1, UTF-16BE (+BOM) raw, and hex strings of both. */
const forms = (v: string) => {
  const u16 = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(v, 'utf16le').swap16()]);
  const l1 = Buffer.from(v, 'latin1');
  return [l1, u16, Buffer.from(u16.toString('hex').toUpperCase()), Buffer.from(u16.toString('hex')), Buffer.from(l1.toString('hex').toUpperCase()), Buffer.from(l1.toString('hex'))];
};

describe.skipIf(!HAVE_POPPLER)('PDF: document properties policy', () => {
  it('inspection lists property names and counts (no values by default), revisions and retained content', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(await makePdf(root, { incremental: true }));
    const r = await inspectFile(ctx, v.artifactId, false);
    expect(r.pages).toBe(2);
    expect((r.identifyingFieldCounts as any)).toMatchObject({ priorRevisions: 1, xmpMetadataStreams: 1, applicationData: 1 });
    expect(r.documentPropertyNames).toEqual(expect.arrayContaining(['Author', 'Producer']));
    expect((r.retainedByPolicy as any)).toMatchObject({ annotations: 1, annotationAuthorNames: 1, embeddedFiles: 1 });
    const text = JSON.stringify(r);
    for (const s of Object.values(PDF_SECRETS)) expect(text, s).not.toContain(s);
    expect(JSON.stringify(await inspectFile(ctx, v.artifactId, true))).toContain(PDF_SECRETS.author);
  });

  it('sanitized PDF: properties, XMP, PieceInfo, prior revisions and orphans gone; text, pages and rendering identical', async () => {
    const { ctx, root } = setup();
    const path = await makePdf(root, { incremental: true });
    const original = readFileSync(path);
    expect(forms(PDF_SECRETS.oldAuthor).some((f) => original.includes(f))).toBe(true); // recoverable in the source
    const v = ctx.files.importPath(path);
    const res = await run(ctx, v.artifactId);
    expect(res.verdict, JSON.stringify(res.verification, null, 1)).toBe('verified_for_policy');
    const outPath = ctx.files.absPath(ctx.files.row(res.output!.artifactId));
    const out = readFileSync(outPath);
    for (const s of [PDF_SECRETS.author, PDF_SECRETS.oldAuthor, PDF_SECRETS.company, PDF_SECRETS.xmpCreator, PDF_SECRETS.orphan, 'FixtureProducer', 'fixture-private-data']) {
      for (const f of forms(s)) expect(out.includes(f), s).toBe(false);
    }
    const info = pdfinfo(outPath);
    expect(info).not.toMatch(/^(Author|Producer|Creator|Title|Subject|Keywords|CreationDate|ModDate):/m);
    expect(info).toMatch(/^Pages:\s+2$/m);
    expect(pdfinfo(outPath, ['-meta']).trim()).toBe('');
    expect(out.toString('latin1').split('startxref').length - 1).toBe(1);
    expect(execFileSync('pdftotext', [outPath, '-']).toString()).toContain(`${PDF_BODY_TEXT} page 2`);
    // content kept: annotation (and its author) + embedded file
    expect(forms(PDF_SECRETS.annotAuthor).some((f) => out.includes(f))).toBe(true);
    expect(execFileSync('pdfdetach', ['-list', outPath]).toString()).toMatch(/1 embedded files?/);
    expect(JSON.stringify(res.sanitize)).toMatch(/annotations \(incl\. 1 author/);
    // properties of the earlier revision are counted and named, not hidden under "unreachable objects"
    expect((res.sanitize as any).removed.propertyKeysAcrossRevisions).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify((res.sanitize as any).notes)).toMatch(/earlier revision\(s\).*Title/);
    const checks = Object.fromEntries(res.verification.checks.map((c) => [c.name, c.ok]));
    expect(checks).toMatchObject({ output_parses: true, page_count_equal: true, page_sizes_equal: true, text_identical: true, rendering_identical: true, single_revision: true, embedded_files_kept: true, source_unchanged: true });
    expect(res.verification.sameEngine).toBe(false);
    expect(readFileSync(path).equals(original)).toBe(true);
    expect((await verifyFile(ctx, res.output!.artifactId)).verdict).toBe('verified_for_policy');
  });

  it('signed PDFs need an explicit decision; encrypted PDFs are refused', async () => {
    const { ctx, root } = setup();
    const signed = ctx.files.importPath(await makePdf(root, { signed: true, name: 'signed.pdf' }));
    await expect(run(ctx, signed.artifactId)).rejects.toMatchObject({ details: { needsDecision: 'allowInvalidateSignatures' } });
    const ok = await run(ctx, signed.artifactId, { allowInvalidateSignatures: true });
    expect(['verified_for_policy', 'partial']).toContain(ok.verdict);
    expect(JSON.stringify(ok.sanitize)).toMatch(/invalidated the signature/);
    const enc = ctx.files.importPath(await makePdf(root, { encrypted: true, name: 'enc.pdf' }));
    await expect(run(ctx, enc.artifactId)).rejects.toThrow(/encrypted/i);
    expect(await inspectFile(ctx, enc.artifactId, false)).toMatchObject({ encrypted: true });
  });

  it('the revision scan is bounded (many /Info references do not stall the server)', () => {
    const parts: string[] = ['%PDF-1.7\n'];
    for (let i = 0; i < 20000; i++) parts.push(`/Info ${i} 0 R\n`);
    parts.push('1 0 obj\n<< /Author (x) >>\nendobj\nstartxref\n0\n%%EOF\n');
    const t0 = Date.now();
    infoKeysAllRevisions(Buffer.from(parts.join(''), 'latin1'));
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('decoding for the byte scan is capped (compression bomb does not exhaust memory)', async () => {
    const { ctx, root } = setup();
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([100, 100]);
    const bomb = deflateSync(Buffer.alloc(96 * 1024 * 1024)); // ~96 MB of zeros in ~100 KB
    doc.context.register(PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode', Length: bomb.length }), bomb));
    const p = join(root, 'bomb.pdf');
    writeFileSync(p, await doc.save({ useObjectStreams: false }));
    const env = defaultEnv({ timeoutMs: 60_000, maxImagePixels: 1e8, tmp: (e) => join(root, `t.${e}`) });
    global.gc?.();
    const before = process.memoryUsage().rss;
    const r = await pdfHandler.verify(p, p, env);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
    // an undecoded stream may still hold a removed value: an inspection gap (needs a decision), not a footnote
    expect(r.inspectionGaps.join(' ')).toMatch(/not decoded for the byte scan/);
    expect(r.limitations.join(' ')).not.toMatch(/not decoded for the byte scan/);
  });

  it('a signature hidden from raw scanning and an inconclusive pdfsig both require a decision', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(await makePdf(root, { name: 'plain.pdf' }));
    const { serviceHooks } = await import('../../src/files/service.js');
    const { defaultRunner } = await import('../../src/files/exec.js');
    serviceHooks.run = (bin, args, o) => (bin === 'pdfsig' ? Promise.reject(new Error('pdfsig broke')) : defaultRunner(bin, args, o));
    try {
      await expect(run(ctx, v.artifactId)).rejects.toMatchObject({ details: { needsDecision: 'allowInvalidateSignatures' } });
    } finally {
      serviceHooks.run = undefined;
    }
  });

  it('nested /Metadata in direct dictionaries is removed too', async () => {
    const { ctx, root } = setup();
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([100, 100]);
    const x = doc.context.register(doc.context.stream('<x:xmpmeta>Nested XMP Fixture Person</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }));
    doc.catalog.set(PDFName.of('ViewerPreferences'), doc.context.obj({ Metadata: x }));
    const p = join(root, 'nested.pdf');
    writeFileSync(p, await doc.save({ useObjectStreams: false }));
    const v = ctx.files.importPath(p);
    const res = await run(ctx, v.artifactId);
    expect(res.verdict).toBe('verified_for_policy');
    expect(readFileSync(ctx.files.absPath(ctx.files.row(res.output!.artifactId))).includes(Buffer.from('Nested XMP Fixture'))).toBe(false);
  });

  it('corrupt PDFs fail cleanly', async () => {
    const { ctx, root } = setup();
    writeFileSync(join(root, 'bad.pdf'), Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog'));
    const v = ctx.files.importPath(join(root, 'bad.pdf'));
    await expect(run(ctx, v.artifactId)).rejects.toThrow();
    expect(ctx.files.list().filter((f) => f.origin === 'sanitized')).toEqual([]);
    expect(readdirSync(ctx.files.tmpDir)).toEqual([]);
  });

  it('the verifier is not vacuous: a leftover property gives partial, changed content gives failed', async () => {
    const { ctx, root } = setup();
    const v = ctx.files.importPath(await makePdf(root));
    const res = await run(ctx, v.artifactId);
    const src = ctx.files.absPath(ctx.files.row(v.artifactId));
    const clean = readFileSync(ctx.files.absPath(ctx.files.row(res.output!.artifactId)));
    const env = defaultEnv({ timeoutMs: 60_000, maxImagePixels: 1e8, tmp: (e) => ctx.files.tmpPath(e) });
    // Leftover: an incremental update that adds Info /Author back.
    const s = clean.toString('latin1');
    const prev = Number(/startxref\s+(\d+)/.exec(s.slice(s.lastIndexOf('startxref')))![1]);
    const size = Number(/\/Size (\d+)/.exec(s)![1]);
    const root2 = /\/Root (\d+ \d+ R)/.exec(s)![1];
    const obj = `${size} 0 obj\n<< /Author (${PDF_SECRETS.author}) >>\nendobj\n`;
    const xref = `xref\n${size} 1\n${String(clean.length).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size + 1} /Root ${root2} /Info ${size} 0 R /Prev ${prev} >>\nstartxref\n${clean.length + obj.length}\n%%EOF\n`;
    writeFileSync(join(root, 'leftover.pdf'), Buffer.concat([clean, Buffer.from(obj + xref, 'latin1')]));
    const part = await pdfHandler.verify(src, join(root, 'leftover.pdf'), env);
    expect(part.verdict, JSON.stringify(part.checks)).toBe('failed'); // two revisions -> structural failure (single_revision)
    expect(part.residual.some((r) => r.name === 'Author')).toBe(true);
    // Changed content: a different document with the same page count.
    const changed = await pdfHandler.verify(src, await makePdf(root, { name: 'changed.pdf', body: 'Different fixture text' }), env);
    expect(changed.verdict).toBe('failed');
    expect(changed.checks.find((c) => c.name === 'text_identical')!.ok).toBe(false);
  });
});

describe.skipIf(!HAVE_POPPLER)('PDF: targeted fields removed, identifying information in preserved structures reported', () => {
  it('verified_for_policy still lists annotation authors, comment text, form values, attachments and image EXIF as retained findings', async () => {
    const { makeJpeg } = await import('../fixtures/media.js');
    const { ctx, root } = setup();
    const jpeg = readFileSync(makeJpeg(root)); // carries EXIF with GPS and an artist name
    const v = ctx.files.importPath(await makePdf(root, { name: 'form.pdf', formValue: 'Jane Applicant Fixture', jpegWithExif: jpeg }));
    const res = await run(ctx, v.artifactId);
    expect(res.verdict, JSON.stringify(res.verification.residual)).toBe('verified_for_policy'); // document properties: gone
    const cats = res.verification.retainedFindings.map((f) => f.category);
    expect(cats).toEqual(expect.arrayContaining(['annotation-authors', 'annotation-text', 'form-values', 'embedded-files', 'embedded-image-metadata']));
    expect(res.verification.inspectionGaps.join(' ')).toMatch(/embedded file/);
    expect(res.summary).toMatch(/kept by design/);
    expect(res.summary).toMatch(/not a statement that the file contains no identifying information/);
    // nothing meaningful was silently deleted: the form value and annotation author are still in the output
    const out = readFileSync(ctx.files.absPath(ctx.files.row(res.output!.artifactId)));
    const u16 = (s: string) => Buffer.from(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()]).toString('hex').toUpperCase());
    expect(out.includes(Buffer.from('Jane Applicant Fixture')) || out.includes(u16('Jane Applicant Fixture'))).toBe(true);
    // no false positives on a document without such content
    const plain = await run(ctx, ctx.files.importPath(await makePdf(root, { name: 'p.pdf' })).artifactId);
    expect(plain.verification.retainedFindings.map((f) => f.category)).not.toContain('form-values');
    expect(plain.verification.retainedFindings.map((f) => f.category)).not.toContain('embedded-image-metadata');
  });
});
