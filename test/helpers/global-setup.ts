/**
 * Give this test run its own temp directory. Concurrent runs (other worktrees)
 * then cannot delete each other's fixtures, fake runs or data dirs, and the
 * whole directory is removed at teardown. Test workers inherit TMPDIR.
 *
 * On macOS, also hold a power assertion for the run. With idle sleep enabled
 * (pmset `sleep 1` on the development machine) a long or heavily loaded run
 * often straddles a system sleep. Across a sleep, wall-clock deadlines
 * (Date.now: leases, provider startup, email waits, crawl deadlines) jump
 * forward while monotonic timers (test timeouts, setTimeout) do not, and on wake
 * Chromium can drop in-flight requests. Tests then fail in ways that look like
 * load-dependent races. `caffeinate -i -s -w <pid>` prevents idle and (on AC)
 * system sleep until this process exits; it cannot prevent a lid-close sleep.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function holdAwake(): ChildProcess | null {
  if (process.platform !== 'darwin' || process.env.RBA_TEST_ALLOW_SLEEP === '1') return null;
  try {
    const p = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    p.on('error', () => undefined); // caffeinate missing: run without the assertion
    p.unref();
    return p;
  } catch {
    return null;
  }
}

export default function setup() {
  const previous = process.env.TMPDIR;
  const dir = mkdtempSync(join(tmpdir(), 'vitest-run-'));
  process.env.TMPDIR = dir;
  const awake = holdAwake();
  return () => {
    awake?.kill();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(dir, { recursive: true, force: true });
  };
}
