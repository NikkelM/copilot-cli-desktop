/**
 * Why a window that has just crashed may be running code that exists nowhere.
 *
 * A render error names whatever was being rendered, which sends the reader into that
 * feature's source - and when the cause is a stale bundle, that source is correct and the
 * time is lost. Same shape as a stale sidecar (#169), one layer up.
 *
 * In development the window is served by Vite rather than from disk, so it can outlive the
 * server it was loaded from: the `tauri dev` process exits, the window carries on with
 * whatever modules it last received, and nothing can replace them. That happened here with
 * a half-applied edit, and the stack said `openSubagentId is not defined` for an identifier
 * that no longer existed in the source, the tests, or the type checker.
 *
 * Asked of the server rather than guessed from the error, because the error cannot tell the
 * difference between a stale build and a real bug, and guessing wrong sends the reader the
 * wrong way either time.
 */

/** What to say when the window is on its own, where reloading cannot help. */
export const ORPHANED =
  'The dev server is gone and this window may be showing old code. Restart the app.';

/** What to say when the code is still being served, so the error is probably real. */
export const RELOADABLE = 'Reload to fetch the current code.';

/**
 * Whether this window has outlived the server that loaded it.
 *
 * False for a packaged build, which serves its own files and cannot be orphaned, and false
 * when the server answers. Only a dev build that cannot reach its server is stranded.
 */
export async function windowOrphaned(
  hot: unknown = import.meta.hot,
  get: typeof fetch = fetch,
): Promise<boolean> {
  if (!hot) return false;

  try {
    // The client Vite serves every dev page, asked for without cache so a stored copy
    // cannot answer for a server that has gone.
    await get('/@vite/client', { cache: 'no-store' });
    return false;
  } catch {
    return true;
  }
}

/** The sentence to put under a crash, once the window's own state is known. */
export function adviceFor(orphaned: boolean): string {
  return orphaned ? ORPHANED : RELOADABLE;
}
