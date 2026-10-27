import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { RbaError } from './errors.js';

/**
 * AES-256-GCM envelope: base64("v1" | iv(12) | tag(16) | ciphertext).
 * `aad` binds a blob to its owner (e.g. "account:<id>:state") so a blob copied
 * onto another account fails authentication instead of silently mixing sessions.
 */
export class Vault {
  constructor(private readonly key: Buffer | null) {}

  get available(): boolean {
    return this.key !== null;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new RbaError('config_missing', 'RBA_ENCRYPTION_KEY is not configured; encrypted storage unavailable');
    return this.key;
  }

  encrypt(plaintext: string | Buffer, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([Buffer.from('v1'), iv, c.getAuthTag(), ct]).toString('base64');
  }

  decrypt(blob: string, aad: string): Buffer {
    const raw = Buffer.from(blob, 'base64');
    if (raw.length < 30 || raw.subarray(0, 2).toString() !== 'v1') throw new RbaError('internal', 'corrupt encrypted blob');
    const d = createDecipheriv('aes-256-gcm', this.requireKey(), raw.subarray(2, 14));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(raw.subarray(14, 30));
    try {
      return Buffer.concat([d.update(raw.subarray(30)), d.final()]);
    } catch {
      throw new RbaError('internal', 'encrypted blob failed authentication (wrong key or wrong owner)');
    }
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256Hex(a), 'hex');
  const bb = Buffer.from(sha256Hex(b), 'hex');
  return timingSafeEqual(ab, bb);
}

/** Password satisfying common site rules: upper, lower, digit, symbol, 20 chars. */
export function generatePassword(length = 20): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^*-_=+'];
  const all = sets.join('');
  const pick = (s: string) => s[randomBytes(4).readUInt32BE() % s.length]!;
  const chars = sets.map(pick);
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE() % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
