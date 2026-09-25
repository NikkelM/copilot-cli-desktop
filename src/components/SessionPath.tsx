import { useEffect, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';

import { Branches } from './Branches';
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
 * Noticing it is also the moment it wants changing, so the indicator is where the branch is
 * chosen rather than somewhere to read and then go elsewhere to act on (#102). It used to
 * open the branch on GitHub instead, which the button immediately right of it already does.
 *
 * A detached HEAD is a commit rather than a branch, so it stays plain text: there is no name
 * to switch away from and a picker would be claiming otherwise.
 */
export function SessionPath({
  cwd,
  state,
  branches,
  switching,
  busy,
  onBranches,
  onSwitch,
}: {
  cwd: string | null;
  state: TreeState | null;
  branches: { name: string; current: boolean }[];
  switching: boolean;
  /** Whether a turn is running, which is the one time a switch is refused. */
  busy: boolean;
  onBranches: () => void;
  onSwitch: (name: string, create: boolean) => void;
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
    // A div rather than a paragraph: the picker's menu is a list and a form, and neither
    // belongs inside a <p>.
    <div className="cwd">
      {shortenHome(cwd, homePath)}
      {state &&
        (state.detached ? (
          <span className="branch" title={meaning ?? undefined}>
            {label}
          </span>
        ) : (
          <Branches
            branch={state.branch}
            label={label}
            className="branch link"
            title={meaning ?? undefined}
            note={marks.length > 0 ? 'Changed files carry over' : null}
            branches={branches}
            switching={switching}
            disabled={busy}
            disabledReason="Cannot switch branch while the agent is working"
            onOpen={onBranches}
            onSwitch={onSwitch}
          />
        ))}
    </div>
  );
}
