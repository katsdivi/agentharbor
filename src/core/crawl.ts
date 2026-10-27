import { appendFileSync, chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrawlRequest, CrawlResultsResponse, CrawlStatusResponse, ExtractSpec, ProxyMode } from '../../actor/src/protocol.js';
import { sleep } from '../email/verification.js';
import type { Ctx } from './context.js';
import type { ExecutionMode, ProxyKind } from './modes.js';
import { RbaError } from './errors.js';
import { JobBlocked } from './jobs.js';

export interface CrawlParams {
  startUrls: string[];
  accountId?: string;
  leaseId?: string;
  sameOriginOnly?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxPages?: number;
  maxDepth?: number;
  delayMs?: number;
  extract?: ExtractSpec;
  mode?: ExecutionMode;
  proxy?: { kind: ProxyKind; country?: string };
  proxyMode?: ProxyMode;
  country?: string;
  maxMinutes?: number;
}

export function resultsPath(ctx: Ctx, jobId: string): string {
  return join(ctx.dirs.results, `${jobId}.jsonl`);
}

export function crawlDurationMs(ctx: Ctx, p: CrawlParams): number {
  const minutes = Math.min(p.maxMinutes ?? ctx.cfg.limits.maxSessionMinutes, ctx.cfg.limits.maxSessionMinutes);
  return Math.max(60_000, (minutes - 1) * 60_000);
}

export function buildCrawlRequest(ctx: Ctx, p: CrawlParams): CrawlRequest {
  if (!p.startUrls.length) throw new RbaError('invalid_input', 'startUrls is empty');
  for (const u of p.startUrls) {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') throw new RbaError('invalid_input', `unsupported URL scheme ${x.protocol}`);
  }
  return {
    startUrls: p.startUrls,
    sameOriginOnly: p.sameOriginOnly ?? true,
    includeGlobs: p.includeGlobs ?? [],
    excludeGlobs: p.excludeGlobs ?? [],
    maxPages: Math.min(p.maxPages ?? ctx.cfg.limits.maxCrawlPages, ctx.cfg.limits.maxCrawlPages),
    maxDepth: Math.min(p.maxDepth ?? ctx.cfg.limits.maxCrawlDepth, ctx.cfg.limits.maxCrawlDepth),
    delayMs: Math.max(250, p.delayMs ?? 1000),
    pageTimeoutMs: 30_000,
    maxRetriesPerPage: ctx.cfg.limits.maxRetries,
    extract: p.extract,
    // Whole-crawl deadline: the session's lifetime minus a minute for draining results.
    maxDurationMs: crawlDurationMs(ctx, p),
  };
}

/** Crawl job body: one dedicated remote session, polled until the crawl ends. */
export async function runCrawl(ctx: Ctx, jobId: string, p: CrawlParams, signal: AbortSignal): Promise<void> {
  const req = buildCrawlRequest(ctx, p);
  const session = await ctx.sessions.start({
    accountId: p.accountId,
    leaseId: p.leaseId,
    mode: p.mode,
    proxy: p.proxy,
    proxyMode: p.proxyMode,
    country: p.country,
    maxMinutes: p.maxMinutes,
    purpose: 'crawl',
    signal,
  });
  ctx.db.run('UPDATE jobs SET session_id = ? WHERE id = ?', session.sessionId, jobId);
  const file = resultsPath(ctx, jobId);
  writeFileSync(file, '', { mode: 0o600 });
  try {
    await ctx.sessions.call(session.sessionId, '/crawl/start', req, { signal });
    await pollCrawl(ctx, jobId, session.sessionId, signal, 0, req.maxDurationMs);
  } finally {
    await ctx.sessions.close(session.sessionId).catch(() => undefined);
  }
}

export async function pollCrawl(ctx: Ctx, jobId: string, sid: string, signal: AbortSignal, startOffset: number, deadlineMs?: number): Promise<void> {
  const file = resultsPath(ctx, jobId);
  // Orchestrator-side watchdog: if the worker has not ended the crawl by its own
  // deadline + grace, cancel it here (the caller then closes the session).
  // Counted from when polling starts (the worker's crawl started just before).
  const watchdogAt = deadlineMs !== undefined ? Date.now() + deadlineMs + 45_000 : Infinity;
  if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
  chmodSync(file, 0o600);
  let offset = startOffset;
  const drain = async () => {
    for (;;) {
      const page = await ctx.sessions.call<CrawlResultsResponse & { page?: null }>(sid, '/crawl/results', undefined, { signal, query: `offset=${offset}&limit=100` });
      if (page.results.length === 0) return;
      appendFileSync(file, page.results.map((x) => JSON.stringify(x)).join('\n') + '\n');
      offset = page.nextOffset;
    }
  };
  for (;;) {
    if (signal.aborted) {
      await ctx.sessions.call(sid, '/crawl/cancel', {}).catch(() => undefined);
      await drain().catch(() => undefined);
      signal.throwIfAborted();
    }
    if (Date.now() > watchdogAt) {
      await ctx.sessions.call(sid, '/crawl/cancel', {}).catch(() => undefined);
      await drain().catch(() => undefined);
      ctx.jobs.setResult(jobId, { results: offset, resultsFile: file, stoppedBy: 'orchestrator_watchdog' });
      throw new RbaError('timeout', 'crawl did not end by its deadline; cancelled by the orchestrator (results so far are kept)');
    }
    const st = await ctx.sessions.call<CrawlStatusResponse & { page?: null }>(sid, '/crawl/status', undefined, { signal });
    await drain();
    ctx.jobs.setProgress(jobId, { pagesDone: st.pagesDone, pagesFailed: st.pagesFailed, queued: st.queued, resultsSaved: offset, resultsFile: file, resultsOffset: offset });
    if (st.state === 'completed' || st.state === 'deadline') {
      const partial = st.state === 'deadline';
      ctx.jobs.setResult(jobId, { pages: st.pagesDone, failed: st.pagesFailed, results: offset, resultsFile: file, ...(partial ? { stoppedBy: 'crawl_deadline', partial: true } : {}) });
      ctx.jobs.transition(jobId, 'completed', partial ? `crawl stopped at its deadline (partial): ${st.pagesDone} pages, ${st.pagesFailed} failed` : `crawl finished: ${st.pagesDone} pages, ${st.pagesFailed} failed`);
      return;
    }
    if (st.state === 'blocked') {
      const acct = ctx.db.get<{ account_id: string | null }>('SELECT account_id FROM sessions WHERE id = ?', sid);
      if (acct?.account_id && st.blocked) ctx.accounts.quarantine(acct.account_id, `${st.blocked.kind} during crawl: ${st.blocked.detail}`);
      ctx.jobs.setResult(jobId, { pages: st.pagesDone, results: offset, resultsFile: file, blocked: st.blocked });
      throw new JobBlocked(`crawl stopped: ${st.blocked?.kind ?? 'blocked'} ${st.blocked?.detail ?? ''}`.trim());
    }
    if (st.state === 'failed' || st.state === 'cancelled') {
      ctx.jobs.setResult(jobId, { pages: st.pagesDone, results: offset, resultsFile: file });
      throw new RbaError(st.state === 'cancelled' ? 'cancelled' : 'worker_error', st.error ?? `crawl ${st.state}`);
    }
    await sleep(2000, signal).catch(() => undefined);
  }
}
