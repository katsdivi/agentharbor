/**
 * Declarative extraction. Only a fixed in-page function runs; the caller
 * supplies data (selectors/attribute names), never code.
 */
import type { Page } from 'playwright';
import type { ExtractSpec } from './protocol.js';

export const MAX_HTML_CHARS = 20_000;
export const MAX_TEXT_CHARS = 20_000;
export const EXTRACT_DEFAULT_ITEMS = 100;
export const EXTRACT_MAX_ITEMS = 1000;

export class ExtractSpecError extends Error {}

type Item = Record<string, string | string[] | null>;

interface InPageArgs {
  itemSelector: string | null;
  fields: Array<[string, { selector: string; attr: string; all: boolean }]>;
  maxItems: number;
  maxHtml: number;
  maxText: number;
}

/** Fixed in-page function. */
function runExtract(a: InPageArgs): { items: Item[]; truncated: boolean; error: string | null } {
  const URL_ATTRS = ['href', 'src', 'action', 'poster', 'data-src', 'srcset-first'];
  const value = (el: Element, attr: string): string | null => {
    if (attr === 'text') {
      const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
      return t.length > a.maxText ? t.slice(0, a.maxText) : t;
    }
    if (attr === 'html') {
      const h = el.outerHTML;
      return h.length > a.maxHtml ? h.slice(0, a.maxHtml) : h;
    }
    const v = el.getAttribute(attr);
    if (v === null) return null;
    if (URL_ATTRS.includes(attr.toLowerCase())) {
      try {
        return new URL(v, document.baseURI).href;
      } catch {
        return v;
      }
    }
    return v.length > a.maxText ? v.slice(0, a.maxText) : v;
  };
  try {
    let roots: Array<Element | Document>;
    let truncated = false;
    if (a.itemSelector) {
      const all = Array.from(document.querySelectorAll(a.itemSelector));
      truncated = all.length > a.maxItems;
      roots = all.slice(0, a.maxItems);
    } else {
      roots = [document];
    }
    const items: Item[] = roots.map((root) => {
      const item: Item = {};
      for (const [name, f] of a.fields) {
        if (f.all) {
          const els = Array.from(root.querySelectorAll(f.selector)).slice(0, a.maxItems);
          item[name] = els.map((e) => value(e, f.attr)).filter((x): x is string => x !== null);
        } else {
          const el = root.querySelector(f.selector);
          item[name] = el ? value(el, f.attr) : null;
        }
      }
      return item;
    });
    return { items, truncated, error: null };
  } catch (e) {
    return { items: [], truncated: false, error: e instanceof Error ? e.message : 'extract failed' };
  }
}

export function validateExtractSpec(spec: unknown): ExtractSpec {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new ExtractSpecError('spec must be an object');
  const s = spec as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    if (!['itemSelector', 'fields', 'maxItems'].includes(k)) throw new ExtractSpecError(`unknown spec key ${k}`);
  }
  if (s.itemSelector !== undefined && (typeof s.itemSelector !== 'string' || !s.itemSelector || s.itemSelector.length > 1000)) {
    throw new ExtractSpecError('itemSelector must be a non-empty string');
  }
  if (s.maxItems !== undefined && (!Number.isInteger(s.maxItems) || (s.maxItems as number) < 1)) {
    throw new ExtractSpecError('maxItems must be a positive integer');
  }
  if (!s.fields || typeof s.fields !== 'object' || Array.isArray(s.fields)) throw new ExtractSpecError('fields must be an object');
  const fields = s.fields as Record<string, unknown>;
  const names = Object.keys(fields);
  if (names.length === 0 || names.length > 100) throw new ExtractSpecError('fields must have 1..100 entries');
  for (const n of names) {
    const f = fields[n] as Record<string, unknown>;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new ExtractSpecError(`field ${n} must be an object`);
    for (const k of Object.keys(f)) {
      if (!['selector', 'attr', 'all'].includes(k)) throw new ExtractSpecError(`unknown key ${k} in field ${n}`);
    }
    if (typeof f.selector !== 'string' || !f.selector || f.selector.length > 1000) throw new ExtractSpecError(`field ${n}.selector must be a string`);
    if (f.attr !== undefined && (typeof f.attr !== 'string' || !/^[A-Za-z_:][-A-Za-z0-9_:.]{0,99}$/.test(f.attr))) {
      throw new ExtractSpecError(`field ${n}.attr is invalid`);
    }
    if (f.all !== undefined && typeof f.all !== 'boolean') throw new ExtractSpecError(`field ${n}.all must be boolean`);
  }
  return s as unknown as ExtractSpec;
}

export async function extract(page: Page, spec: ExtractSpec): Promise<{ items: Item[]; truncated: boolean }> {
  const maxItems = Math.min(spec.maxItems ?? EXTRACT_DEFAULT_ITEMS, EXTRACT_MAX_ITEMS);
  const args: InPageArgs = {
    itemSelector: spec.itemSelector ?? null,
    fields: Object.entries(spec.fields).map(([n, f]) => [n, { selector: f.selector, attr: f.attr ?? 'text', all: f.all ?? false }]),
    maxItems,
    maxHtml: MAX_HTML_CHARS,
    maxText: MAX_TEXT_CHARS,
  };
  const r = await page.mainFrame().evaluate(runExtract, args);
  if (r.error) throw new ExtractSpecError(`invalid selector: ${r.error.slice(0, 200)}`);
  return { items: r.items, truncated: r.truncated };
}

/** Fixed in-page link collector for crawling. */
function collectLinks(max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = (a as HTMLAnchorElement).href;
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= max) break;
  }
  return out;
}

export async function pageLinks(page: Page, max = 2000): Promise<string[]> {
  return page.mainFrame().evaluate(collectLinks, max);
}
