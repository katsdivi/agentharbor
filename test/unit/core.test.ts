import { describe, expect, it } from 'vitest';
import { generatePassword, Vault } from '../../src/core/crypto.js';
import { redact, redactDeep, registerSecret, safeUrl } from '../../src/core/redact.js';
import { isPlaceholder, parseTargets } from '../../src/core/config.js';
import { RbaError } from '../../src/core/errors.js';
import { testCtx } from '../helpers/ctx.js';

describe('vault', () => {
  const v = new Vault(Buffer.alloc(32, 7));
  it('round-trips and binds ciphertext to its owner (AAD)', () => {
    const blob = v.encrypt('{"cookies":[]}', 'account:a:state');
    expect(v.decrypt(blob, 'account:a:state').toString()).toBe('{"cookies":[]}');
    expect(() => v.decrypt(blob, 'account:b:state')).toThrow(/failed authentication/);
  });
  it('rejects tampering and a wrong key', () => {
    const blob = v.encrypt('secret', 'x');
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => v.decrypt(raw.toString('base64'), 'x')).toThrow();
    expect(() => new Vault(Buffer.alloc(32, 8)).decrypt(blob, 'x')).toThrow();
  });
  it('refuses without a key', () => {
    expect(() => new Vault(null).encrypt('x', 'y')).toThrow(RbaError);
  });
  it('generates strong passwords', () => {
    const p = generatePassword();
    expect(p).toHaveLength(20);
    expect(p).toMatch(/[A-Z]/);
    expect(p).toMatch(/[a-z]/);
    expect(p).toMatch(/[0-9]/);
    expect(p).toMatch(/[^A-Za-z0-9]/);
  });
});

describe('redaction', () => {
  it('removes registered secrets and credential-shaped strings', () => {
    registerSecret('hunter2-very-secret');
    const s = redact('pw=hunter2-very-secret token apify_api_ABCDEFGHIJKLMNOPQRSTUV Authorization: Bearer abc.def x-api-key: k123 https://u:p@h.test/x?token=zzz&a=1');
    expect(s).not.toContain('hunter2-very-secret');
    expect(s).not.toContain('apify_api_ABCDEFGHIJKLMNOPQRSTUV');
    expect(s).not.toContain('abc.def');
    expect(s).not.toContain('k123');
    expect(s).not.toContain('u:p@');
    expect(s).not.toContain('zzz');
  });
  it('deep-redacts sensitive keys', () => {
    expect(redactDeep({ a: { password: 'x', cookies: [1], ok: 'fine' } })).toEqual({ a: { password: '[REDACTED]', cookies: '[REDACTED]', ok: 'fine' } });
  });
  it('strips one-time tokens from URLs', () => {
    expect(safeUrl('https://a.test/verify?token=abc#x')).toBe('https://a.test/verify?[query]');
    expect(safeUrl('https://a.test/confirm/Zq81kd02Lm9xP4tR7vB2')).toBe('https://a.test/confirm/[redacted]');
    expect(safeUrl('https://a.test/account/settings')).toBe('https://a.test/account/settings');
  });
});

describe('config parsing', () => {
  it('treats placeholders as missing', () => {
    for (const v of ['', 'REPLACE_ME', '<token>', 'your-key', undefined]) expect(isPlaceholder(v)).toBe(true);
    expect(isPlaceholder('apify_api_real')).toBe(false);
  });
  it('parses targets with auth origins', () => {
    expect(parseTargets('https://app.example.com/x|https://auth.example.com, http://127.0.0.1:3000')).toEqual([
      { origin: 'https://app.example.com', authOrigins: ['https://auth.example.com'] },
      { origin: 'http://127.0.0.1:3000', authOrigins: [] },
    ]);
    expect(() => parseTargets('ftp://x')).toThrow();
    expect(parseTargets('staging.example.com')).toEqual([{ origin: 'https://staging.example.com', authOrigins: [] }]);
  });
});

describe('account leases', () => {
  it('is exclusive, renewable, and reclaims stale leases', async () => {
    const ctx = testCtx({ RBA_LEASE_TTL_SECS: '10' });
    const a = ctx.accounts.create({ targetOrigin: 'https://t.test', proxyMode: 'direct', status: 'active' });
    const l1 = ctx.accounts.acquire(a.id, 'job1', 10);
    expect(() => ctx.accounts.acquire(a.id, 'job2', 10)).toThrow(/leased by job1/);
    ctx.accounts.renew(l1.leaseId, 10);
    // Simulate a crashed holder: its lease expires without renewal.
    ctx.db.run('UPDATE leases SET expires_at = ? WHERE lease_id = ?', Date.now() - 1, l1.leaseId);
    const l2 = ctx.accounts.acquire(a.id, 'job2', 10);
    expect(l2.reclaimedStale).toBe(true);
    expect(() => ctx.accounts.renew(l1.leaseId, 10)).toThrow(/no longer held/);
    expect(() => ctx.accounts.assertLease(a.id, l1.leaseId)).toThrow();
    expect(ctx.accounts.release(l2.leaseId)).toBe(true);
  });
  it('refuses quarantined accounts and leased deletion', () => {
    const ctx = testCtx();
    const a = ctx.accounts.create({ targetOrigin: 'https://t.test', proxyMode: 'direct', status: 'active' });
    const l = ctx.accounts.acquire(a.id, 'x', 30);
    expect(() => ctx.accounts.delete(a.id)).toThrow(/leased/);
    ctx.accounts.release(l.leaseId);
    ctx.accounts.quarantine(a.id, 'captcha');
    expect(() => ctx.accounts.acquire(a.id, 'x', 30)).toThrow(/quarantined/);
    ctx.accounts.delete(a.id);
    expect(() => ctx.accounts.row(a.id)).toThrow(/not found/);
  });
  it('isolates encrypted state per account', () => {
    const ctx = testCtx();
    const a = ctx.accounts.create({ targetOrigin: 'https://t.test', proxyMode: 'direct', status: 'active' });
    const b = ctx.accounts.create({ targetOrigin: 'https://t.test', proxyMode: 'direct', status: 'active' });
    ctx.accounts.saveState(a.id, { cookies: [{ name: 'sid', value: 'A' }], origins: [] });
    ctx.accounts.saveState(b.id, { cookies: [{ name: 'sid', value: 'B' }], origins: [] });
    expect(ctx.accounts.loadState(a.id)!.cookies[0]!.value).toBe('A');
    // Copying A's blob onto B must not yield a usable session for B.
    const blobA = ctx.db.get<{ state_blob: string }>('SELECT state_blob FROM accounts WHERE id = ?', a.id)!.state_blob;
    ctx.db.run('UPDATE accounts SET state_blob = ? WHERE id = ?', blobA, b.id);
    expect(() => ctx.accounts.loadState(b.id)).toThrow(/authentication/);
    // Views never expose secrets.
    ctx.accounts.setCredentials(a.id, { password: 'P@ssw0rd-unique-123' });
    expect(JSON.stringify(ctx.accounts.list())).not.toContain('P@ssw0rd-unique-123');
    const raw = ctx.db.get<{ credential_blob: string }>('SELECT credential_blob FROM accounts WHERE id = ?', a.id)!.credential_blob;
    expect(raw).not.toContain('P@ssw0rd');
  });
});

describe('jobs state machine', () => {
  it('enforces legal transitions', () => {
    const ctx = testCtx();
    const id = ctx.jobs.create('register', { password: 'x' });
    expect(ctx.jobs.row(id).params_json).not.toContain('"x"');
    expect(() => ctx.jobs.transition(id, 'verifying', 'skip')).toThrow(/illegal/);
    ctx.jobs.transition(id, 'running', '');
    ctx.jobs.transition(id, 'awaiting_email', '');
    ctx.jobs.transition(id, 'verifying', '');
    ctx.jobs.transition(id, 'completed', '');
    expect(() => ctx.jobs.transition(id, 'failed', '')).toThrow(/already completed/);
  });
});
