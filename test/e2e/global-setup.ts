/**
 * The e2e suite runs in its own TMPDIR (set in vitest.e2e.config.ts) so that a
 * concurrent unit/integration run, whose global teardown removes recent rba-*
 * dirs from the shared tmpdir, cannot delete a live e2e data dir. This
 * teardown removes the private TMPDIR itself.
 */
import { rmSync } from 'node:fs';

export default function setup() {
  const dir = process.env.RBA_E2E_TMPDIR;
  return () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
