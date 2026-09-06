import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';

/**
 * Point the tests at a copilot home of their own, before anything reads the real one.
 *
 * The sidecar resolves its paths from this once, at import, so it has to be set here
 * rather than in a test. Without it, anything that writes beside a session's state - the
 * snapshot records, the private git index - lands in the reader's actual sessions, which
 * a run of the suite did before this existed.
 */
const home = mkdtempSync(join(tmpdir(), 'ccd-test-home-'));
process.env.COPILOT_HOME = home;

afterAll(() => rmSync(home, { recursive: true, force: true }));

// Sidecar tests run without a DOM, where there is nothing to unmount and loading the
// React testing library would only cost startup time.
afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});
