import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../../src/core/config.js';
import { buildContext, type CtxOverrides } from '../../src/core/context.js';

/** Config from an isolated temp .env (never the developer's real .env). */
export function testConfig(vars: Record<string, string> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'rba-test-'));
  const envFile = join(dir, '.env');
  const all = {
    RBA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    RBA_DASHBOARD_TOKEN: randomBytes(24).toString('base64url'),
    RBA_DATA_DIR: join(dir, 'data'),
    ...vars,
  };
  writeFileSync(envFile, Object.entries(all).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
  return loadConfig({ RBA_ENV_FILE: envFile } as NodeJS.ProcessEnv);
}

export function testCtx(vars: Record<string, string> = {}, o: CtxOverrides = {}) {
  return buildContext({ provider: null, mail: null, ...o, cfg: o.cfg ?? testConfig(vars) });
}
