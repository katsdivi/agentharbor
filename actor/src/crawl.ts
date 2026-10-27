/**
 * Bounded BFS crawl inside the SAME browser context as the interactive
 * session.
 *
 * Why not Crawlee's PlaywrightCrawler: it manages its own browser pool and
 * contexts (fingerprints, session pool, retries), whereas this worker must
 * (a) reuse the one authenticated context (cookies/localStorage from
 * /session/init and logins), (b) keep exactly one browser per container, and
 * (c) route every request through the same network guards (route handler +
 * policy proxy). A ~150-line BFS over a dedicated page in that context gives
 * those guarantees with less surface.
 *
 * Decisions:
 * - The crawl uses its own page (same context) so the interactive page is
 *   left untouched; interactive commands return `busy` while it runs.
 * - A BlockSignal (captcha, human verification, HTTP 403 => access_denied,
 *   HTTP 429 => rate_limited) stops the crawl with state `blocked`. The page
 *   that triggered it is included in the results with `error: "blocked: <kind>"`.
 * - Other 4xx/5xx responses are recorded as page results with an error and
 *   are not retried. Retries (<= maxRetriesPerPage, cap 3) are only for
 *   navigation errors/timeouts. Policy-blocked URLs are not retried.
 */
import type { Page } from 'playwright';
import type { BlockSignal, CrawlPageResult, CrawlRequest, CrawlStatusResponse } from './protocol.js';
import type { BrowserSession } from './browser.js';
import { WorkerFail, cleanMessage } from './errors.js';
import { detectBlock } from './blockdetect.js';
import { extract, ExtractSpecError, pageLinks } from './extract.js';
import { checkUrlSync, globToRegExp, safeUrlForLog } from './netpolicy.js';
import { log } from './log.js';

export const CRAWL_MAX_PAGES = 1000;
export const CRAWL_MAX_DEPTH = 10;
export const CRAWL_MAX_RETRIES = 3;
export const CRAWL_MAX_RESULT_BYTES = 20 * 1024 * 1024;
/** Best-effort wait toward `load` after a crawl page's document is ready (never fails the page). */
export const CRAWL_SETTLE_MS = 5_000;
/** Bounded wait for extract.itemSelector to appear before extracting (pages without items cost at most this). */
export const CRAWL_ITEM_WAIT_MS = 2_000;

type State = CrawlStatusResponse['state'];

function normalizeUrl(u: string): string | null {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    x.hash = '';
    return x.href;
  } catch {
    return null;
  }
}

export class Crawler {
  state: State = 'idle';
  pagesDone = 0;
  pagesFailed = 0;
  queue: Array<{ url: string; depth: number }> = [];
  blocked: BlockSignal | null = null;
  error: string | null = null;
  results: CrawlPageResult[] = [];
  private resultBytes = 0;
  private cancelled = false;
  private deadlineHit = false;
  private wake: (() => void) | null = null;
  private page: Page | null = null;
  private done: Promise<void> | null = null;

  constructor(private session: BrowserSession) {}

  get running(): boolean {
    return this.state === 'running';
  }

  status(): CrawlStatusResponse {
    return {
      state: this.state,
      pagesDone: this.pagesDone,
      pagesFailed: this.pagesFailed,
      queued: this.queue.length,
      blocked: this.blocked,
      error: this.error,
      resultsAvailable: this.results.length,
    };
  }

  start(req: CrawlRequest): CrawlStatusResponse {
    if (this.running) throw new WorkerFail('busy', 'a crawl is already running');
    const maxPages = Math.max(1, Math.min(req.maxPages, CRAWL_MAX_PAGES));
    const maxDepth = Math.max(0, Math.min(req.maxDepth, CRAWL_MAX_DEPTH));
    const retries = Math.max(0, Math.min(req.maxRetriesPerPage, CRAWL_MAX_RETRIES));
    const starts: string[] = [];
    for (const s of req.startUrls) {
      const r = checkUrlSync(this.session.policy, s, { topLevelNavigation: true });
      if (!r.ok) throw new WorkerFail('navigation_blocked', `start URL not allowed: ${r.reason}`);
      const n = normalizeUrl(s);
      if (n && !starts.includes(n)) starts.push(n);
    }
    if (starts.length === 0) throw new WorkerFail('bad_request', 'no valid start URLs');
    const origins = new Set(starts.map((s) => new URL(s).origin));
    const inc = req.includeGlobs.map(globToRegExp);
    const exc = req.excludeGlobs.map(globToRegExp);

    this.state = 'running';
    this.pagesDone = 0;
    this.pagesFailed = 0;
    this.blocked = null;
    this.error = null;
    this.results = [];
    this.resultBytes = 0;
    this.cancelled = false;
    this.queue = starts.map((url) => ({ url, depth: 0 }));
    const seen = new Set(starts);

    const accept = (u: string): boolean => {
      if (req.sameOriginOnly && !origins.has(new URL(u).origin)) return false;
      if (inc.length > 0 && !inc.some((r) => r.test(u))) return false;
      if (exc.some((r) => r.test(u))) return false;
      return checkUrlSync(this.session.policy, u, { topLevelNavigation: true }).ok;
    };

    const perPageMs = (retries + 1) * Math.max(1000, req.pageTimeoutMs) + 20_000;
    const overallMs = req.maxDurationMs !== undefined ? Math.max(1000, Math.min(req.maxDurationMs, 24 * 3600_000)) : null;
    const startedAt = Date.now();
    this.deadlineHit = false;

    /** One page: navigation (with retries), block check, extraction, link collection. */
    const processPage = async (page: Page, item: { url: string; depth: number }): Promise<{ result: CrawlPageResult; block: BlockSignal | null }> => {
      const result: CrawlPageResult = { url: item.url, depth: item.depth, status: null, title: '', items: [], error: null };
      let attempt = 0;
      let ok = false;
      for (;;) {
        try {
          // Document required within pageTimeoutMs; load is a bounded best-effort settle
          // (slow optional resources do not fail or retry the page).
          const { resp } = await this.session.gotoChecked(page, item.url, { timeoutMs: req.pageTimeoutMs, waitUntil: 'load', settleMs: CRAWL_SETTLE_MS });
          result.status = resp?.status() ?? null;
          result.url = page.url();
          ok = true;
          break;
        } catch (e) {
          if (this.cancelled) throw e;
          const code = e instanceof WorkerFail ? e.code : 'navigation_failed';
          const retryable = code === 'timeout' || code === 'navigation_failed';
          if (retryable && attempt < retries) {
            attempt++;
            continue;
          }
          result.error = `${code}: ${e instanceof WorkerFail ? e.message : cleanMessage(e)}`;
          break;
        }
      }
      if (!ok) return { result, block: null };
      result.title = await page.title().catch(() => '');
      const block = await detectBlock(page, result.status);
      if (block) {
        result.error = `blocked: ${block.kind}`;
        return { result, block };
      }
      if (result.status !== null && result.status >= 400) {
        result.error = `http_status: ${result.status}`;
      } else if (req.extract) {
        try {
          // Items rendered by script after load: give them a bounded chance to appear.
          if (req.extract.itemSelector) {
            await page.mainFrame().waitForSelector(req.extract.itemSelector, { state: 'attached', timeout: CRAWL_ITEM_WAIT_MS }).catch(() => undefined);
          }
          result.items = (await extract(page, req.extract)).items;
        } catch (e) {
          result.error = e instanceof ExtractSpecError ? `extract: ${e.message}` : `extract: ${cleanMessage(e)}`;
        }
      }
      if (item.depth < maxDepth && result.error === null) {
        const links = await pageLinks(page).catch(() => [] as string[]);
        for (const l of links) {
          const n = normalizeUrl(l);
          if (!n || seen.has(n) || !accept(n)) continue;
          if (seen.size >= maxPages * 20) break;
          seen.add(n);
          this.queue.push({ url: n, depth: item.depth + 1 });
        }
      }
      return { result, block: null };
    };

    const run = async (): Promise<void> => {
      let page = await this.session.newTrackedPage();
      this.page = page;
      let first = true;
      while (this.queue.length > 0 && !this.cancelled && this.pagesDone + this.pagesFailed < maxPages) {
        const left = overallMs === null ? Infinity : overallMs - (Date.now() - startedAt);
        if (left <= 0) {
          this.deadlineHit = true;
          break;
        }
        const item = this.queue.shift()!;
        if (!first && req.delayMs > 0) await this.pause(Math.min(req.delayMs, 60_000, left));
        if (!first) {
          // Fresh page per item (same context, cookies kept): a page that keeps
          // spinning, timing or requesting cannot affect the next item.
          await page.close({ runBeforeUnload: false }).catch(() => undefined);
          if (this.cancelled) break;
          page = await this.session.newTrackedPage();
          this.page = page;
        }
        first = false;
        if (this.cancelled) break;
        const limit = Math.min(perPageMs, overallMs === null ? Infinity : overallMs - (Date.now() - startedAt));
        const work = processPage(page, item);
        work.catch(() => undefined);
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          work.then((v) => ({ v }), (e: unknown) => ({ e })),
          new Promise<'deadline'>((r) => {
            timer = setTimeout(() => r('deadline'), Math.max(0, limit));
          }),
        ]).finally(() => clearTimeout(timer));
        if (outcome === 'deadline') {
          // Cancel in-flight work: closing the page rejects pending navigation/evaluate.
          await page.close({ runBeforeUnload: false }).catch(() => undefined);
          await Promise.race([work.catch(() => undefined), new Promise((r) => setTimeout(r, 10_000).unref())]);
          if (this.cancelled) break;
          const overall = overallMs !== null && Date.now() - startedAt >= overallMs;
          this.pagesFailed++;
          this.push({ url: item.url, depth: item.depth, status: null, title: '', items: [], error: overall ? 'crawl_deadline: whole-crawl deadline reached during this page' : `page_deadline: exceeded ${perPageMs} ms` });
          log('crawl_page_deadline', { url: safeUrlForLog(item.url), overall });
          if (overall) {
            this.deadlineHit = true;
            break;
          }
          page = await this.session.newTrackedPage();
          this.page = page;
          continue;
        }
        if (this.cancelled) break;
        if ('e' in outcome) throw outcome.e;
        const { result, block } = outcome.v;
        if (block) {
          this.pagesFailed++;
          this.push(result);
          this.blocked = block;
          this.state = 'blocked';
          log('crawl_blocked', { url: safeUrlForLog(result.url), kind: block.kind });
          return;
        }
        if (result.error) this.pagesFailed++;
        else this.pagesDone++;
        if (!this.push(result)) return;
      }
      if (this.cancelled) this.state = 'cancelled';
      else if (this.deadlineHit) {
        this.state = 'deadline';
        this.error = `whole-crawl deadline (${overallMs} ms) reached; results so far are kept`;
      } else this.state = 'completed';
    };

    this.done = run()
      .catch((e) => {
        if (this.cancelled) {
          this.state = 'cancelled';
        } else if (this.state === 'deadline') {
          /* keep */
        } else {
          this.state = 'failed';
          this.error = cleanMessage(e);
        }
      })
      .finally(async () => {
        const p = this.page;
        this.page = null;
        if (p) await p.close().catch(() => undefined);
        log('crawl_finished', { state: this.state, done: this.pagesDone, failed: this.pagesFailed });
      });
    log('crawl_started', { startUrls: starts.length, maxPages, maxDepth });
    return this.status();
  }

  /** Append a result; returns false (and fails the crawl) if over the size cap. */
  private push(r: CrawlPageResult): boolean {
    const size = Buffer.byteLength(JSON.stringify(r));
    if (this.resultBytes + size > CRAWL_MAX_RESULT_BYTES) {
      this.state = 'failed';
      this.error = `result size cap (${CRAWL_MAX_RESULT_BYTES} bytes) reached; crawl stopped`;
      return false;
    }
    this.resultBytes += size;
    this.results.push(r);
    return true;
  }

  /** Politeness delay that ends early on cancel. */
  private pause(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(() => {
        this.wake = null;
        r();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        r();
      };
    });
  }

  async cancel(): Promise<CrawlStatusResponse> {
    if (this.running) {
      this.cancelled = true;
      this.wake?.();
      const p = this.page;
      // Closing the page aborts an in-flight navigation/evaluation promptly.
      if (p) await p.close({ runBeforeUnload: false }).catch(() => undefined);
      if (this.done) await Promise.race([this.done, new Promise((r) => setTimeout(r, 10_000))]);
      this.state = 'cancelled';
    }
    return this.status();
  }

  getResults(offset: number, limit: number): { results: CrawlPageResult[]; nextOffset: number } {
    const results = this.results.slice(offset, offset + limit);
    return { results, nextOffset: offset + results.length };
  }
}
