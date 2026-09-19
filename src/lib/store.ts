/**
 * What this app remembers, in files it owns rather than in the webview's store.
 *
 * `localStorage` belongs to WebView2 and sits among its caches and cookies, where clearing
 * browsing data takes the reader's settings with it, nothing but the window can read it, and
 * an uninstaller's behaviour is whatever the bundler's default happens to be (#191).
 *
 * Two files, because the two kinds of state differ on every axis that matters:
 *
 * - **Settings** are decisions someone made. A handful of keys, written when something is
 *   chosen, worth carrying to another machine and worth opening by hand.
 * - **Session state** is what the app noticed. It grows with the session list, is written on
 *   every pin and tag and fold, and means nothing anywhere these sessions are not.
 *
 * The write rate is the practical argument for keeping them apart: pinning a session would
 * otherwise rewrite the settings file, and put every preference at risk for a change that
 * was not about preferences.
 *
 * What is *not* here is the third kind - the remembered command and model lists, which are
 * caches of what the runtime said. They regenerate on the next fetch, so losing them costs
 * nothing, and a browser cache is exactly what `localStorage` is for.
 */


/**
 * Ask the shell, which is the only part of this that can reach a file.
 *
 * Imported when it is called rather than at the top, because it is only reachable when there
 * is a shell to ask: a browser or a test never loads the Tauri API at all.
 */
async function ask<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}
export type StoreName = 'settings' | 'sessions';

/** What a store holds. Values are whatever JSON the owning hook chose to keep. */
type Contents = Record<string, unknown>;

/**
 * The stores in memory, which is what everything reads.
 *
 * Held rather than fetched per read because the hooks that want them run during render and
 * cannot wait: `loadStores` is awaited once before anything is drawn, so by the time any of
 * this is asked a question it already knows the answer.
 *
 * Hung off the global rather than kept in the module, because it stands in for the file on
 * disk and a file does not vanish when a module is loaded twice. Only tests load this twice
 * - they reset the module registry to simulate a restart - and a restart is precisely the
 * case where what was written is expected to still be there.
 */
const HELD = Symbol.for('copilot-desktop.stores');

interface Kept {
  held: Record<StoreName, Contents>;
  loaded: boolean;
  writing: Partial<Record<StoreName, ReturnType<typeof setTimeout>>>;
}

const kept: Kept = ((globalThis as Record<symbol, unknown>)[HELD] as Kept | undefined) ?? {
  held: { settings: {}, sessions: {} },
  loaded: false,
  writing: {},
};
(globalThis as Record<symbol, unknown>)[HELD] = kept;

const { held, writing } = kept;

/**
 * How long a change waits for the next one.
 *
 * Long enough that dragging the sidebar edge writes once rather than per pixel, short enough
 * that closing the window straight after a change does not lose it.
 */
const SETTLE_MS = 400;

/** Whether this is running somewhere with a shell to ask. Tests and a browser are not. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * The keys each store took over from `localStorage`, and what they were called there.
 *
 * Migration reads these once, when a store has no file yet, and never writes back to them.
 * The old keys are left where they are: they cost a few bytes, and leaving them means a
 * reader who downgrades finds their settings rather than an empty app.
 */
const MIGRATIONS: Record<StoreName, readonly string[]> = {
  settings: ['scale', 'sidebarWidth', 'sidebarHidden', 'confirmDelete', 'reasoning'],
  sessions: ['favourites', 'archived', 'tags', 'reviewed', 'folded'],
};

/** What a key was called in the webview's store. */
function oldKey(key: string): string {
  return `copilot-desktop.${key}`;
}

/**
 * Seed a store from whatever the webview was holding.
 *
 * Values are kept as the strings they were, because that is what the hooks reading them
 * expect: each parses its own, and some of them - a scale, a flag - were never JSON at all.
 */
function migrate(name: StoreName): Contents {
  const found: Contents = {};
  if (typeof localStorage === 'undefined') return found;

  for (const key of MIGRATIONS[name]) {
    const value = localStorage.getItem(oldKey(key));
    if (value !== null) found[key] = value;
  }
  return found;
}

/**
 * Read both stores, once, before anything is drawn.
 *
 * Failure is not fatal. A reader whose config directory cannot be read should get an app
 * with default settings rather than no app, and the next write will try again.
 */
export async function loadStores(): Promise<void> {
  for (const name of ['settings', 'sessions'] as const) {
    let contents: Contents | null = null;

    if (inTauri()) {
      try {
        const raw = await ask<string | null>('read_store', { store: name });
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            contents = parsed as Contents;
          }
        }
      } catch {
        // An unreadable or malformed store reads as a fresh one rather than as a crash.
      }
    }

    // No file is what a fresh install looks like, and also what the first run after this
    // change looks like - so it is the moment to take what the webview was holding.
    const migrated = contents === null;
    held[name] = contents ?? migrate(name);
    kept.loaded = true;

    // Written straight back, so the file exists from now on and this is the only run that
    // looks at the webview. Left unwritten it would be read again on every start, which
    // works but means the old keys decide what the app remembers for ever.
    if (migrated) flush(name);
  }

  kept.loaded = true;
}

/** Write a store, once the changes have stopped arriving. */
function flush(name: StoreName): void {
  clearTimeout(writing[name]);
  writing[name] = setTimeout(() => {
    delete writing[name];
    if (!inTauri()) return;
    void ask('write_store', { store: name, contents: JSON.stringify(held[name], null, 2) }).catch(() => {
      // Nothing useful to do about it: the value is in memory and will be written again on
      // the next change, and a dialog about a settings file would be worse than the failure.
    });
  }, SETTLE_MS);
}

/** What a store holds under this key, or null when it holds nothing. */
export function read(name: StoreName, key: string): string | null {
  const value = held[name][key];
  return typeof value === 'string' ? value : null;
}

/** Put a value in a store, and arrange for it to reach disk. */
export function save(name: StoreName, key: string, value: string): void {
  if (held[name][key] === value) return;
  held[name][key] = value;
  if (kept.loaded) flush(name);
}

/** Take a key out of a store, for a setting that has gone back to its default. */
export function forget(name: StoreName, key: string): void {
  if (!(key in held[name])) return;
  delete held[name][key];
  if (kept.loaded) flush(name);
}

/** Drop everything held, so a test starts from nothing. */
export function resetStores(): void {
  held.settings = {};
  held.sessions = {};
  kept.loaded = false;
  for (const name of ['settings', 'sessions'] as const) {
    clearTimeout(writing[name]);
    delete writing[name];
  }
}
