import { useEffect, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { openUrl } from '@tauri-apps/plugin-opener';

import { githubUrl } from './OpenIn';
import { shortenHome } from '../lib/paths';
import type { TreeState } from '../../shared/protocol';

/** Asked for once per run: the home directory does not change while the app is open. */
let asked: Promise<string> | null = null;
const home = () => (asked ??= homeDir().catch(() => ''));

/**
 * What each marker means, in the order a shell prompt writes them.
 *
 * Borrowed rather than invented: anyone who has these in their prompt already reads them
 * without thinking, and they are cryptic enough to be worth spelling out in the title.
 */
const MARKERS: ReadonlyArray<[keyof TreeState, string, string]> = [
  ['modified', '*', 'unstaged changes'],
  ['staged', '+', 'staged changes'],
  ['untracked', '%', 'untracked files'],
];

/**
 * A session's working directory, with the branch it is on beside it.
 *
 * Which branch a session works on matters as much as which directory: the same checkout on
 * two branches is two different pieces of work, and one left on the wrong branch is worth
 * noticing before sending rather than after.
 *
 * The branch is the obvious thing to click to go and look at it, so when the checkout has a
 * GitHub remote it does what the GitHub button does. Without one it stays plain text rather
 * than becoming a button that cannot go anywhere.
 */
export function SessionPath({
  cwd,
  state,
  onError,
}: {
  cwd: string | null;
  state: TreeState | null;
  onError: (message: string) => void;
}) {
  const [homePath, setHomePath] = useState('');
  useEffect(() => {
    let current = true;
    void home().then((found) => current && setHomePath(found));
    return () => {
      current = false;
    };
  }, []);

  // A session started without a directory has nothing to say here, and an empty line
  // beside the title reads as something failing to load.
  if (!cwd) return null;

  const marks = state ? MARKERS.filter(([key]) => state[key]) : [];
  const label = state && (
    <>
      <span aria-hidden="true">⎇ </span>
      {state.branch}
      {marks.map(([, mark]) => mark).join('')}
    </>
  );
  const meaning =
    state &&
    [
      state.detached ? `detached at ${state.branch}` : `on branch ${state.branch}`,
      ...marks.map(([, , explanation]) => explanation),
    ].join(', ');

  return (
    <p className="cwd">
      {shortenHome(cwd, homePath)}
      {state &&
        (state.remote ? (
          <button
            type="button"
            className="branch link"
            title={`${meaning} - open on GitHub`}
            onClick={() => openUrl(githubUrl(state.remote!, state.branch)).catch((e) => onError(String(e)))}
          >
            {label}
          </button>
        ) : (
          <span className="branch" title={meaning ?? undefined}>
            {label}
          </span>
        ))}
    </p>
  );
}
