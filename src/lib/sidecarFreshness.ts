/**
 * Whether the sidecar answering this window is running the code that is on disk.
 *
 * The three pieces of this app ship independently: Vite replaces frontend modules in a
 * running window, while the sidecar is a Node process started once from a copy of
 * `sidecar/dist` taken when the app launched. Nothing rebuilds or restarts it afterwards,
 * so editing a sidecar source file leaves the running one a version behind with no signal
 * at all - and the failure that follows names whichever method drifted, which sends the
 * reader into that method's source, which is correct, which is where the time goes (#169).
 *
 * `PROTOCOL_VERSION` already catches the case where the set of method *names* differs. It
 * cannot catch a method whose parameters changed shape, because those are types and are
 * gone by runtime: `git.stage` went from taking a path to taking a list of them without the
 * fingerprint moving at all. This covers that, by watching the files rather than the shapes.
 *
 * Development only. There is no source tree beside a packaged app, and nothing there can
 * drift: the sidecar it runs was built with it.
 */

/** Separators normalised, so one predicate answers for both platforms. */
const normalise = (file: string) => file.replace(/\\/g, '/');

/**
 * Whether changing this file leaves the running sidecar behind.
 *
 * The sidecar's own sources, and the protocol both halves compile separately from - that
 * one is the whole reason this is needed, since the frontend picks up an edit to it
 * immediately and the sidecar cannot.
 *
 * Tests are left out: they are never imported by the running sidecar, and a suite in watch
 * mode would otherwise report the app as stale every time a test was saved.
 */
export function affectsRunningSidecar(file: string): boolean {
  const path = normalise(file);
  if (!path.endsWith('.ts') || path.endsWith('.test.ts')) return false;
  return path.includes('/sidecar/src/') || path.includes('/shared/');
}

/**
 * What to say about it.
 *
 * Names the file and the remedy rather than the feature. The reader is about to watch
 * something behave impossibly, and the useful sentence is the one that explains why rather
 * than the one that describes what.
 */
export function behindMessage(file: string): string {
  const name = normalise(file).split('/').slice(-2).join('/');
  return `${name} changed after the runtime started, so the runtime is a version behind it.`;
}

/** What the window sends to ask for a rebuild, and what comes back when it is done. */
export const SIDECAR_REBUILD_EVENT = 'sidecar-rebuild';
export const SIDECAR_REBUILT_EVENT = 'sidecar-rebuilt';

/** The message the dev server sends when it sees one of those files change. */
export const SIDECAR_BEHIND_EVENT = 'sidecar-behind';

/** The part of Vite's HMR client this needs, which is the part a test can stand in for. */
interface HotChannel {
  on(event: string, listener: (data: unknown) => void): void;
  off(event: string, listener: (data: unknown) => void): void;
  send(event: string, data?: unknown): void;
}

/**
 * Ask the dev server to rebuild the sidecar, and hear back when it has.
 *
 * Two hops rather than one, because neither end can do the whole job: the dev server has
 * npm and the source tree but cannot replace a process the Rust shell owns, and the shell
 * can replace it but has no way to build what it would start. So this rebuilds, and the
 * caller restarts.
 *
 * Reports the failure rather than swallowing it. A rebuild that failed and a rebuild that
 * worked must not look the same, or the restart afterwards quietly loads the old code again
 * and the reader is back where they started.
 */
export function rebuildSidecar(
  hot: HotChannel | undefined = import.meta.hot as HotChannel | undefined,
): Promise<void> {
  if (!hot) return Promise.reject(new Error('There is no dev server to rebuild anything.'));

  return new Promise((resolve, reject) => {
    const done = (data: unknown) => {
      hot.off(SIDECAR_REBUILT_EVENT, done);
      const failure = (data as { error?: unknown } | null)?.error;
      if (typeof failure === 'string') reject(new Error(failure));
      else resolve();
    };

    hot.on(SIDECAR_REBUILT_EVENT, done);
    hot.send(SIDECAR_REBUILD_EVENT);
  });
}

/**
 * Listen for the dev server saying the sidecar has been left behind.
 *
 * Returns a function that stops listening. In a build with no dev server there is nothing
 * to listen to and nothing to stop, which is the packaged case.
 *
 * The channel is a parameter because `import.meta` belongs to the module that writes it -
 * a test cannot reach in and replace this one's, so it is handed in instead.
 */
export function onSidecarBehind(
  handler: (message: string) => void,
  hot: HotChannel | undefined = import.meta.hot as HotChannel | undefined,
): () => void {
  if (!hot) return () => undefined;

  const listener = (data: unknown) => {
    const file = (data as { file?: unknown } | null)?.file;
    if (typeof file === 'string') handler(behindMessage(file));
  };

  hot.on(SIDECAR_BEHIND_EVENT, listener);
  return () => hot.off(SIDECAR_BEHIND_EVENT, listener);
}
