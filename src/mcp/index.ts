#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { applyRetention, buildContext } from '../core/context.js';
import { redact } from '../core/redact.js';
import { LocalProvider } from '../providers/local.js';
import { createServer } from './server.js';
import { drainCleanup, gateTools, reconcile } from '../core/recovery.js';
import { TOOLS } from './tools/index.js';
import { sweepInboxes } from '../email/inboxes.js';

// stdout is the MCP channel: all diagnostics go to stderr, redacted.
const log = (m: string) => process.stderr.write(`[rba] ${redact(m)}\n`);

async function main(): Promise<void> {
  const ctx = buildContext();
  // Mutating tools wait (bounded, 10 s) for startup reconciliation; job_status / job_cancel never wait.
  let openGate: () => void = () => undefined;
  const recovered = new Promise<void>((r) => (openGate = r));
  gateTools(TOOLS, recovered, 10_000);
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  log(`ready; data dir ${ctx.cfg.dataDir}; remote provider ${ctx.provider?.name ?? 'NOT CONFIGURED'}; local mode ${ctx.providers.local instanceof LocalProvider ? (ctx.providers.local.unavailableReason() ?? 'available') : 'disabled'}; email ${ctx.mail ? 'mailslurp' : 'NOT CONFIGURED'}`);
  // Crash recovery after a previous process died: reap dead sessions/leases, inbox reservations,
  // claim orphaned jobs (resume safe ones, settle the rest), drain the provider cleanup queue.
  void (async () => {
    try {
      const r = await reconcile(ctx);
      ctx.files.cleanTmp();
      if (ctx.providers.local instanceof LocalProvider) ctx.providers.local.sweepStale();
      const ret = applyRetention(ctx);
      if (r.inboxes.orphansDeleted || r.inboxes.orphansKept || r.inboxes.deferred || r.inboxes.queued) log(`inbox reservation recovery: ${JSON.stringify(r.inboxes)}`);
      log(
        `recovery: reaped ${r.sessions.reaped} sessions, ${r.sessions.expiredLeases} expired leases, ${r.jobs.length} interrupted jobs; cleanup ${r.cleanup.done} done, ${r.cleanup.pending} pending; retention removed ${ret.logs} log rows, ${ret.files} files`,
      );
    } catch (e) {
      log(`recovery failed: ${(e as Error).message}`);
    } finally {
      openGate();
    }
  })();
  // Email modes: close/retire disposable inboxes and trim kept ones, then release provider resources.
  const drain = setInterval(() => void sweepInboxes(ctx).catch(() => undefined).finally(() => drainCleanup(ctx).catch(() => undefined)), 60_000);
  drain.unref();
  const sweep = setInterval(() => void ctx.sessions.reapAll().catch(() => undefined), 60_000);
  sweep.unref();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    ctx.sessions.stopHeartbeat();
    // Stop remote runs this process owns so they do not bill until their idle timeout.
    const closing = Promise.all(ctx.sessions.ownedIds().map((id) => ctx.sessions.close(id).catch(() => undefined)));
    void Promise.race([closing, new Promise((r) => setTimeout(r, 8000))]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
