/**
 * The vendored api-anything files are byte-identical to the pinned upstream
 * revision (MANIFEST.json), carry the upstream licence, and import nothing that
 * does I/O.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = resolve(import.meta.dirname, '../../src/vendor/api-anything');
const manifest = JSON.parse(readFileSync(join(DIR, 'MANIFEST.json'), 'utf8')) as {
  revision: string;
  license: string;
  verbatim: Record<string, string>;
  derived: Record<string, { sha256: string }>;
};
const sha = (f: string) => createHash('sha256').update(readFileSync(join(DIR, f))).digest('hex');

describe('vendored api-anything', () => {
  it('is pinned to one upstream revision with its MIT licence', () => {
    expect(manifest.revision).toBe('4a785e8d9e72a00e2dddc0dc56569a86826df07b');
    expect(manifest.license).toBe('MIT');
    expect(readFileSync(join(DIR, 'LICENSE'), 'utf8')).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Tianjun Zheng/);
  });

  it('verbatim files match the manifest hashes (no local edits)', () => {
    for (const [f, h] of Object.entries(manifest.verbatim)) expect(sha(f), f).toBe(h);
  });

  it('the derived session shim matches its recorded hash', () => {
    for (const [f, d] of Object.entries(manifest.derived)) expect(sha(f), f).toBe(d.sha256);
  });

  it('contains only the listed files', () => {
    const listed = new Set([...Object.keys(manifest.verbatim), ...Object.keys(manifest.derived), 'MANIFEST.json', 'ATTRIBUTION.md']);
    expect(readdirSync(DIR).filter((f) => !listed.has(f))).toEqual([]);
  });

  it('imports no I/O modules (fs, net, http, child_process, os, playwright, tldts)', () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(DIR, f), 'utf8');
      const imports = [...src.matchAll(/^import [^;]*?from "([^"]+)";/gms)].map((m) => m[1]);
      for (const i of imports) expect(['zod', 'node-html-parser'].includes(i!) || i!.startsWith('./'), `${f} imports ${i}`).toBe(true);
      expect(src, f).not.toMatch(/\b(fetch|require)\(|process\.env|import\(/);
    }
  });
});
