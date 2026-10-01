import type { SessionSummary } from '../../shared/protocol';
import type { SessionAction } from '../components/SessionMenu';

/** What acting on several sessions at once needs to be able to do (#63). */
export interface BulkActionDeps {
  archived: readonly string[];
  toggleArchived: (sessionId: string) => void;
  favourites: readonly string[];
  toggleFavourite: (sessionId: string) => void;
  /** Release one from memory. A session that was never resumed is simply skipped. */
  unload: (sessionId: string) => void;
  /** Put the whole set to the reader before anything is removed. */
  remove: (sessions: SessionSummary[]) => void;
  /** Write them all out, which means asking for a folder rather than a file. */
  exportAll: (sessions: SessionSummary[]) => void;
}

/** `3 sessions`, or `1 session` - said in full because it is what the action acts on. */
function count(many: number): string {
  return `${many} ${many === 1 ? 'session' : 'sessions'}`;
}

/**
 * What a marked set of sessions offers (#63).
 *
 * One decision per action rather than one per session: marking four sessions and being
 * asked four times about each of them is not bulk anything. So an action that toggles -
 * favourite, archive - reads the set and moves all of it the same way, with the label
 * saying which way that is.
 *
 * Deliberately a shorter list than a single session's menu. Renaming, forking and opening a
 * directory are about one conversation and mean nothing said four times over, and leaving
 * them out is clearer than showing them refused.
 */
export function bulkActions(sessions: SessionSummary[], deps: BulkActionDeps): SessionAction[] {
  const ids = sessions.map((session) => session.sessionId);
  // The set moves the way the majority is not: marking a mix and choosing Favourite means
  // making them all favourites, which is the only reading that leaves the set in one state.
  const allFavourite = ids.every((id) => deps.favourites.includes(id));
  const allArchived = ids.every((id) => deps.archived.includes(id));
  const loaded = sessions.filter((session) => session.loaded);

  return [
    {
      id: 'bulk-favourite',
      label: allFavourite ? `Unfavourite ${count(ids.length)}` : `Favourite ${count(ids.length)}`,
      run: () => ids.forEach((id) => (deps.favourites.includes(id) === allFavourite ? deps.toggleFavourite(id) : undefined)),
    },
    {
      id: 'bulk-unload',
      label: `Unload ${count(loaded.length)} from memory`,
      // Nothing to release, rather than a button that would do nothing. The count says so
      // already, so this only has to explain why it is greyed.
      refused: loaded.length === 0 ? 'None of these are in memory.' : undefined,
      run: () => loaded.forEach((session) => deps.unload(session.sessionId)),
    },
    {
      id: 'bulk-export',
      label: `Export ${count(ids.length)}…`,
      run: () => deps.exportAll(sessions),
    },
    {
      id: 'bulk-archive',
      label: allArchived ? `Bring back ${count(ids.length)}` : `Archive ${count(ids.length)}`,
      tone: 'caution',
      run: () => ids.forEach((id) => (deps.archived.includes(id) === allArchived ? deps.toggleArchived(id) : undefined)),
    },
    {
      id: 'bulk-delete',
      label: `Delete ${count(ids.length)}`,
      tone: 'danger',
      run: () => deps.remove(sessions),
    },
  ];
}
