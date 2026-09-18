import type { SessionSummary } from '../../shared/protocol';
import type { SessionAction } from '../components/SessionMenu';

/** What the menu needs from the app, named so it can be supplied without one. */
export interface SessionActionDeps {
  /** Which sessions are pinned, and how to change that. */
  pinned: readonly string[];
  togglePin: (sessionId: string) => void;
  /** Which sessions are mid-turn. Read live: a session can start working while a menu is open. */
  working: ReadonlySet<string>;
  unload: (sessionId: string) => void;
  copy: (text: string) => void;
  openFolder: (path: string) => void;
}

/**
 * What right-clicking a session offers.
 *
 * Only things the app can actually do today. Renaming, archiving and deleting are named in
 * #107 but none of them exist yet, and a menu that lists them greyed out would promise four
 * features this app does not have (#29, #101, #63).
 *
 * An action that cannot be taken is named and refused rather than left out, so the menu keeps
 * its shape and the reason is where the reader is already looking.
 */
export function sessionActions(session: SessionSummary, deps: SessionActionDeps): SessionAction[] {
  const isPinned = deps.pinned.includes(session.sessionId);

  return [
    {
      id: 'pin',
      label: isPinned ? 'Unpin' : 'Pin to top',
      run: () => deps.togglePin(session.sessionId),
    },
    {
      id: 'unload',
      label: 'Unload from memory',
      // A session that is already cold costs nothing, and one that is mid-turn would lose the
      // turn: the runtime refuses that outright, so saying so beats appearing to do nothing.
      refused: !session.loaded
        ? 'Already unloaded. It costs nothing until it is opened.'
        : deps.working.has(session.sessionId)
          ? 'Still working. It can be unloaded once the turn finishes.'
          : undefined,
      run: () => deps.unload(session.sessionId),
    },
    {
      id: 'copy-id',
      label: 'Copy session id',
      run: () => deps.copy(session.sessionId),
    },
    {
      id: 'folder',
      label: 'Open working folder',
      refused: session.cwd ? undefined : 'This session was not started in a folder.',
      run: () => {
        if (session.cwd) deps.openFolder(session.cwd);
      },
    },
  ];
}
