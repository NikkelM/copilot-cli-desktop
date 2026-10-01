import type { SessionSummary } from '../../shared/protocol';
import type { SessionAction } from '../components/SessionMenu';

/** What acting on several sessions at once needs to be able to do (#63). */
export interface BulkActionDeps {
  archived: readonly string[];
  toggleArchived: (sessionId: string) => void;
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
 * them out is clearer than showing them refused. Favouriting is left out for a different
 * reason: a favourite is a session somebody reaches for, which is a judgement made one at a
 * time, and a set of them made favourites together is a top of the list nobody chose.
 */
export function bulkActions(sessions: SessionSummary[], deps: BulkActionDeps): SessionAction[] {
  const ids = sessions.map((session) => session.sessionId);
  // The set moves the way the majority is not: marking a mix and choosing Archive means
  // putting them all away, which is the only reading that leaves the set in one state.
  const allArchived = ids.every((id) => deps.archived.includes(id));
  const loaded = sessions.filter((session) => session.loaded);

  return [
    {
      id: 'bulk-unload',
      label: `Unload ${count(loaded.length)} from memory`,
      brief: 'Unload',
      // Nothing to release, rather than a button that would do nothing. The count says so
      // already, so this only has to explain why it is greyed.
      refused: loaded.length === 0 ? 'None of these are in memory.' : undefined,
      run: () => loaded.forEach((session) => deps.unload(session.sessionId)),
    },
    {
      id: 'bulk-export',
      label: `Export ${count(ids.length)}…`,
      brief: 'Export…',
      run: () => deps.exportAll(sessions),
    },
    {
      id: 'bulk-archive',
      label: allArchived ? `Bring back ${count(ids.length)}` : `Archive ${count(ids.length)}`,
      brief: allArchived ? 'Bring back' : 'Archive',
      tone: 'caution',
      run: () => ids.forEach((id) => (deps.archived.includes(id) === allArchived ? deps.toggleArchived(id) : undefined)),
    },
    {
      id: 'bulk-delete',
      label: `Delete ${count(ids.length)}`,
      brief: 'Delete',
      tone: 'danger',
      run: () => deps.remove(sessions),
    },
  ];
}
