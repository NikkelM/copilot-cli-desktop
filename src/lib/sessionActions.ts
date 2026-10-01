import type { SessionSummary } from '../../shared/protocol';
import type { SessionAction } from '../components/SessionMenu';

/** What the menu needs from the app, named so it can be supplied without one. */
export interface SessionActionDeps {
  /** Which sessions are favourited, and how to change that. */
  favourites: readonly string[];
  toggleFavourite: (sessionId: string) => void;
  /** Opens the rename dialog. Naming is a decision, so it asks rather than acting. */
  rename: (session: SessionSummary) => void;
  /** Opens the tag picker. Tags change in handfuls, so this hands over rather than toggling. */
  tag: (session: SessionSummary) => void;
  /** Writes the session out as a bundle, which means asking where to put it first (#63). */
  exportTo: (session: SessionSummary) => void;
  /** Which sessions are put away, and how to change that. */
  archived: readonly string[];
  toggleArchived: (sessionId: string) => void;
  /** Open the tasks this session delegated, read from its log rather than from memory (#228). */
  showSubagents: (sessionId: string) => void;
  /** Whether a session is known to have delegated nothing, which is the only certain answer. */
  hasNoSubagents: (sessionId: string) => boolean;
  /** Which sessions are mid-turn. Read live: a session can start working while a menu is open. */
  working: ReadonlySet<string>;
  unload: (sessionId: string) => void;
  /** Brings one into memory before anything is asked of it. */
  load: (sessionId: string) => void;
  copy: (text: string) => void;
  openDirectory: (path: string) => void;
  /** Asked to fork. Costs a resume, which the label says rather than this hiding it. */
  fork: (session: SessionSummary) => void;
  /** Asked to delete. Confirming is the caller's business, not this list's. */
  remove: (session: SessionSummary) => void;
}

/**
 * What right-clicking a session offers.
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
          ? 'Still working. Unload once the turn finishes.'
          : undefined,
      run: () => (session.loaded ? deps.unload(session.sessionId) : deps.load(session.sessionId)),
    },
    {
      id: 'rename',
      label: 'Rename…',
      run: () => deps.rename(session),
    },
    {
      id: 'tag',
      label: 'Tags…',
      run: () => deps.tag(session),
    },
    {
      id: 'export',
      label: 'Export…',
      run: () => deps.exportTo(session),
    },
    {
      id: 'fork',
      // The cost is in the label because there is nowhere else to put it and it is the one
      // thing worth knowing before pressing: this app opens nothing it is not asked to, and
      // forking is a request that has to open the session being copied.
      label: session.loaded ? 'Fork session' : 'Fork session (loads it first)',
      // Forking mid-turn would copy a turn that is still being written, and the copy would
      // stop partway through a reply nobody sent.
      refused: deps.working.has(session.sessionId)
        ? 'Still working. Fork once the turn finishes.'
        : undefined,
      run: () => deps.fork(session),
    },
    {
      id: 'archive',
      label: deps.archived.includes(session.sessionId) ? 'Unarchive' : 'Archive',
      // Nothing on disk changes and the group is one press from open, so unlike deleting
      // this asks nothing first. What it does refuse is putting away a session mid-turn:
      // archiving lets it go, and letting go mid-turn loses the turn.
      refused: deps.working.has(session.sessionId)
        ? 'Still working. Archive once the turn finishes.'
        : undefined,
      run: () => deps.toggleArchived(session.sessionId),
    },
    {
      id: 'subagents',
      label: 'Subagents',
      // Certain, or not said at all: the reason for refusing it is that the log was read
      // to the end and held nothing, and a log too large to reach the end of says nothing.
      refused: deps.hasNoSubagents(session.sessionId) ? 'This session has not delegated anything.' : undefined,
      run: () => deps.showSubagents(session.sessionId),
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
        ? 'Still working. Delete once the turn finishes.'
        : undefined,
      run: () => deps.remove(session),
    },
  ];
}
