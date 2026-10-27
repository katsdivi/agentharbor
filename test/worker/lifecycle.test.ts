import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startIpEcho } from '../fixtures/ipecho.js';
import { baseInput, hostOf, startWorker } from './harness.js';

describe('worker: lifecycle', () => {
  it('exits by itself after idleTimeoutSecs without authenticated requests', async () => {
    const echo = await startIpEcho();
    const w = await startWorker({ input: { idleTimeoutSecs: 3, network: { allowedNavigationOrigins: ['*'], allowPrivateHosts: [hostOf(echo.url)] }, egressCheckUrl: echo.url } });
    try {
      expect((await w.call('/session/init', {})).status).toBe(200);
      const t0 = Date.now();
      // Unauthenticated health checks do not count as activity.
      const poll = setInterval(() => void w.call('/health', undefined, { token: null }).catch(() => undefined), 500);
      const code = await w.exited;
      clearInterval(poll);
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2500);
      expect(w.output()).toContain('shutdown reason=idle_timeout');
    } finally {
      await w.stop();
      await echo.close();
    }
  });

  it('POST /shutdown responds and exits', async () => {
    const w = await startWorker({ input: {} });
    const r = await w.call('/shutdown', {});
    expect(r.body).toEqual({ ok: true });
    expect(await w.exited).toBe(0);
    await w.stop();
  });

  it.each([
    ['unknown key', { ...baseInput({ tokenHash: 'a'.repeat(64) }), extra: 1 }],
    ['bad tokenHash', baseInput({ tokenHash: 'xyz' })],
    ['bad proxy mode', { ...baseInput({ tokenHash: 'a'.repeat(64) }), proxy: { mode: 'tor' } }],
    ['bad origin', baseInput({ tokenHash: 'a'.repeat(64), network: { allowedNavigationOrigins: ['ftp://x'], allowPrivateHosts: [] } })],
    ['missing input', null],
  ])('rejects invalid input (%s) with a non-zero exit', async (_name, input) => {
    const w = await startWorker({ input: input as Record<string, unknown>, rawInput: true, waitListening: false });
    const code = await w.exited;
    expect(code).not.toBe(0);
    expect(w.output()).toContain('invalid_input');
    expect(w.output()).not.toContain('RBA_WORKER_LISTENING');
    await w.stop();
  });

  it('constant-time auth accepts only the matching token', async () => {
    const w = await startWorker({ input: {} });
    try {
      expect((await w.call('/status', undefined, { token: crypto.randomBytes(24).toString('hex') })).status).toBe(401);
      expect((await w.call('/status')).status).toBe(200);
    } finally {
      await w.stop();
    }
  });
});
