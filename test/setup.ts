import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

import { resetStores } from '../src/lib/store';

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

/**
 * Removed when the worker ends rather than after each file.
 *
 * A setup file's afterAll runs after every file the worker handles, so cleaning up there
 * deletes the home out from under the files that follow: the suite passed one file at a
 * time and failed twenty-three tests when run together.
 */
process.on('exit', () => rmSync(home, { recursive: true, force: true }));

// Sidecar tests run without a DOM, where there is nothing to unmount and loading the
// React testing library would only cost startup time.
afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});

/**
 * Start each test with the app remembering nothing.
 *
 * What the app remembers used to be in `localStorage`, which jsdom rebuilds per file and
 * which tests cleared for themselves. It is now held in memory by `store.ts` for the life of
 * the module, so without this a pin set by one test is still set for the next - which is how
 * forty-one of them failed the moment it moved (#191).
 */
beforeEach(() => resetStores());