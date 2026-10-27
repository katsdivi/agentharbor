import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Private TMPDIR for this run (inherited by test workers, the MCP server, workers and browsers).
if (!process.env.RBA_E2E_TMPDIR) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-')));
  process.env.RBA_E2E_TMPDIR = dir;
  process.env.TMPDIR = dir;
}

/** Acceptance (e2e) suite: drives the built MCP server over stdio. Run with `npm run test:e2e`. */
export default defineConfig({
  test: {
    // Teardowns run in reverse order: the private TMPDIR is removed last.
    globalSetup: ['test/e2e/global-setup.ts', 'test/helpers/global-setup.ts'],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    include: ['test/e2e/**/*.e2e.ts'],
  },
});
