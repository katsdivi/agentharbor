/**
 * Deterministic catalog site (test-only), built on the request recorder.
 *
 *   GET /catalog?cat=<name>        HTML listing, one .item per product
 *   GET /api/catalog?cat=<name>    the same data as JSON (for read operations)
 *
 * Each category has a different item count and different names/prices, so an
 * operation learned on one category can be called on another it has never
 * seen and its output compared with `catalogTruth(cat)`.
 */
import { createHash } from 'node:crypto';
import { startRecorder, type Recorder } from './ua-counter.js';

export interface CatalogItem {
  name: string;
  price: string;
  sku: string;
}

const COUNTS: Record<string, number> = { tools: 3, garden: 5, kitchen: 8 };

export function catalogTruth(cat: string): CatalogItem[] {
  const n = COUNTS[cat] ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const h = createHash('sha256').update(`${cat}:${i}`).digest('hex');
    const cents = 100 + (parseInt(h.slice(0, 6), 16) % 9900);
    return { name: `${cat[0]!.toUpperCase()}${cat.slice(1)} item ${i + 1} ${h.slice(0, 4)}`, price: `$${(cents / 100).toFixed(2)}`, sku: `${cat.slice(0, 3).toUpperCase()}-${h.slice(6, 12)}` };
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function startCatalogSite(): Promise<Recorder> {
  return startRecorder((_req, u, res) => {
    const cat = u.searchParams.get('cat') ?? '';
    if (u.pathname === '/catalog') {
      const items = catalogTruth(cat);
      res.writeHead(items.length ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><title>Catalog ${esc(cat)}</title></head><body><h1>Catalog: ${esc(cat)}</h1><ul id="items">` +
          items.map((it) => `<li class="item" data-sku="${it.sku}"><span class="name">${esc(it.name)}</span> <span class="price">${it.price}</span></li>`).join('') +
          `</ul><p id="count">${items.length} items</p></body></html>`,
      );
      return true;
    }
    if (u.pathname === '/api/catalog') {
      const items = catalogTruth(cat);
      res.writeHead(items.length ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ category: cat, items }));
      return true;
    }
    return false;
  });
}
