import type { SessionSummary } from '../../shared/protocol';
import type { SessionAction } from '../components/SessionMenu';

/** What the menu needs from the app, named so it can be supplied without one. */
export interface SessionActionDeps {
  /** Which sessions are favourited, and how to change that. */
  favourites: readonly string[];
  toggleFavourite: (sessionId: string) => void;
  /** Opens the tag picker. Tags change in handfuls, so this hands over rather than toggling. */
  tag: (session: SessionSummary) => void;
  /** Which sessions are put away, and how to change that. */
  archived: readonly string[];
  toggleArchived: (sessionId: string) => void;
  /** Which sessions are mid-turn. Read live: a session can start working while a menu is open. */
  working: ReadonlySet<string>;
  unload: (sessionId: string) => void;
  /** Brings one into memory before anything is asked of it. */
  load: (sessionId: string) => void;
  copy: (text: string) => void;
  openDirectory: (path: string) => void;
  /** Asked to delete. Confirming is the caller's business, not this list's. */
  remove: (session: SessionSummary) => void;
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
  const isFavourite = deps.favourites.includes(session.sessionId);

  return [
    {
      id: 'favourite',
      label: isFavourite ? 'Unfavourite' : 'Favourite',
      run: () => deps.toggleFavourite(session.sessionId),
    },
    {
      id: 'memory',
      label: session.loaded ? 'Unload from memory' : 'Load into memory',
      // One row rather than two, since a session is either resident or not and the reader is
      // asking about the same thing either way. Only unloading can be refused: a turn cannot
      // be running on a session that was never resumed.
      refused:
        session.loaded && deps.working.has(session.sessionId)
          ? 'Still working. It can be unloaded once the turn finishes.'
          : undefined,
      run: () => (session.loaded ? deps.unload(session.sessionId) : deps.load(session.sessionId)),
    },
    {
      id: 'tag',
      label: 'Tags…',
      run: () => deps.tag(session),
    },
    {
      id: 'archive',
      label: deps.archived.includes(session.sessionId) ? 'Unarchive' : 'Archive',
      // Nothing on disk changes and the group is one press from open, so unlike deleting
      // this asks nothing first. What it does refuse is putting away a session mid-turn:
      // archiving lets it go, and letting go mid-turn loses the turn.
      refused: deps.working.has(session.sessionId)
        ? 'Still working. It can be archived once the turn finishes.'
        : undefined,
      run: () => deps.toggleArchived(session.sessionId),
    },
    {
      id: 'copy-id',
      label: 'Copy session id',
      run: () => deps.copy(session.sessionId),
    },
    {
      id: 'directory',
      label: 'Open working directory',
      refused: session.cwd ? undefined : 'This session has no working directory.',
      run: () => {
        if (session.cwd) deps.openDirectory(session.cwd);
      },
    },
    {
      id: 'delete',
      label: 'Delete session',
      destructive: true,
      // The turn would be cut off partway and its record deleted underneath it, which is a
      // worse thing to do by accident than any of the above.
      refused: deps.working.has(session.sessionId)
        ? 'Still working. It can be deleted once the turn finishes.'
        : undefined,
      run: () => deps.remove(session),
    },
  ];
}
