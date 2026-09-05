import { watch, type FSWatcher } from 'node:fs';

import { copilotHome } from './paths.js';

/**
 * Collapse bursts of writes into one notification.
 * Every turn of every running CLI session touches the store, so the raw event rate is
 * far higher than the sidebar needs.
 */
const DEBOUNCE_MS = 1500;

/**
 * Watch the CLI's history database and report when it changes.
 *
 * This is what keeps the sidebar current, including for sessions running in a terminal
 * that this app knows nothing about. It is deliberately file based rather than a poll:
 * the existing session watcher script wakes every 30 seconds regardless of activity,
 * which is both slower to react and never idle.
 *
 * SQLite writes mostly land in the -wal sidecar rather than the database file, so the
 * directory is watched and filenames are matched by prefix.
 */
export function watchSessionStore(onChange: () => void): FSWatcher | null {
  let timer: NodeJS.Timeout | null = null;

  try {
    const watcher = watch(copilotHome, { persistent: false }, (_event, filename) => {
      if (!filename || !String(filename).startsWith('session-store.db')) return;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, DEBOUNCE_MS);
      timer.unref();
    });

    return watcher;
  } catch {
    // Losing live updates is a degradation, not a failure; the list still loads.
    return null;
  }
}
