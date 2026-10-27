/**
 * Remote browser worker - Actor entry point.
 *
 * Input: `Actor.getInput()` (apify@3.7.2). On the Apify platform it comes from
 * the run's default key-value store. Locally (outside the platform) the SDK
 * uses @crawlee/memory-storage, which reads the storage directory from env
 * `CRAWLEE_STORAGE_DIR` (default `./storage` relative to cwd); apify@3.7.2
 * does NOT honour `APIFY_LOCAL_STORAGE_DIR`. The input file is
 * `$CRAWLEE_STORAGE_DIR/key_value_stores/default/INPUT.json`. The default
 * purge-on-start keeps the INPUT record.
 *
 * Test-only env knobs (never set by the production image / Apify platform):
 *   RBA_WORKER_TEST_MODE=1 together with RBA_WORKER_TEST_PROXY_URL=http://...
 *   makes non-direct proxy modes use that upstream proxy URL instead of the
 *   Apify proxy. Without RBA_WORKER_TEST_MODE=1 the URL variable is ignored.
 *
 * Other env: ACTOR_WEB_SERVER_PORT (default 4321); RBA_WORKER_BIND_HOST
 * (127.0.0.1 when started by the local provider; default 0.0.0.0).
 *
 * Prints exactly one line `RBA_WORKER_LISTENING port=<n>` once listening.
 */
import { Actor } from 'apify';
import { BrowserSession, type ProxyUrlResolver } from './browser.js';
import { Crawler } from './crawl.js';
import { createServer } from './server.js';
import { log, line } from './log.js';
import { ValidationError, validateWorkerInput } from './validate.js';
import type { WorkerInput } from './protocol.js';

const resolveProxyUrl: ProxyUrlResolver = async (input: WorkerInput) => {
  if (process.env.RBA_WORKER_TEST_MODE === '1' && process.env.RBA_WORKER_TEST_PROXY_URL) {
    return process.env.RBA_WORKER_TEST_PROXY_URL;
  }
  const cfg = await Actor.createProxyConfiguration({
    ...(input.proxy.mode === 'residential' ? { groups: ['RESIDENTIAL'] } : {}),
    ...(input.proxy.country ? { countryCode: input.proxy.country } : {}),
    // The SDK's access check calls proxy.apify.com; off the platform it only
    // warns (and on timeout even reports success), so skip it locally. Our own
    // egress verification is the real gate either way.
    checkAccess: Actor.isAtHome(),
  });
  if (!cfg) throw new Error('proxy configuration unavailable');
  const url = await cfg.newUrl(input.proxy.sessionKey);
  if (!url) throw new Error('proxy URL unavailable');
  // Without a password apify@3.7.2 still returns a URL, with the literal
  // password "undefined" (verified locally). Treat that as unavailable rather
  // than attempting an unauthenticated proxy.
  const pw = new URL(url).password;
  if (!pw || pw === 'undefined' || pw === 'null') throw new Error('proxy URL has no credentials');
  return url;
};

/**
 * Listen address. 0.0.0.0 on the provider (the platform routes the container
 * URL to it); a worker started by the local provider sets
 * RBA_WORKER_BIND_HOST=127.0.0.1 so it is reachable from this computer only.
 */
function bindHost(): string {
  const h = process.env.RBA_WORKER_BIND_HOST;
  return h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' ? h : '0.0.0.0';
}

async function main(): Promise<void> {
  await Actor.init();
  let input: WorkerInput;
  try {
    input = validateWorkerInput(await Actor.getInput());
  } catch (e) {
    const msg = e instanceof ValidationError ? e.message : 'could not read input';
    log('invalid_input', { reason: msg });
    await Actor.fail(`invalid input: ${msg}`);
    return;
  }

  const startedAt = Date.now();
  let lastActivity = Date.now();
  let shuttingDown = false;
  const session = new BrowserSession(input, resolveProxyUrl);
  const crawler = new Crawler(session);

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutdown', { reason });
    void (async () => {
      server.close();
      server.closeAllConnections();
      await Promise.race([session.close(), new Promise((r) => setTimeout(r, 10_000))]);
      await Actor.exit({ exitCode: 0, statusMessage: `worker stopped: ${reason}` });
    })();
  };

  const server = createServer({
    tokenHash: input.tokenHash,
    session,
    crawler,
    maxUploadBytes: input.maxUploadBytes,
    startedAt,
    onActivity: () => {
      lastActivity = Date.now();
    },
    idleSecs: () => Math.round((Date.now() - lastActivity) / 1000),
    shutdown,
    isShuttingDown: () => shuttingDown,
  });

  const port = Number(process.env.ACTOR_WEB_SERVER_PORT ?? 4321);
  server.listen(port, bindHost(), () => {
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    line(`RBA_WORKER_LISTENING port=${actual}`);
  });
  server.on('error', (e) => {
    log('server_error', { err: (e as NodeJS.ErrnoException).code ?? e.name });
    void Actor.fail('worker HTTP server failed');
  });

  const timer = setInterval(() => {
    if (Date.now() - lastActivity > input.idleTimeoutSecs * 1000) shutdown('idle_timeout');
    else if (Date.now() - startedAt > input.maxLifetimeSecs * 1000) shutdown('max_lifetime');
  }, 500);
  timer.unref();

  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => shutdown(sig));
  Actor.on('aborting', () => shutdown('aborting'));
  process.on('unhandledRejection', (e) => log('unhandled_rejection', { err: e instanceof Error ? e.name : 'unknown' }));
}

main().catch(async (e) => {
  log('fatal', { err: e instanceof Error ? e.name : 'unknown' });
  await Actor.exit({ exitCode: 1 }).catch(() => process.exit(1));
});
