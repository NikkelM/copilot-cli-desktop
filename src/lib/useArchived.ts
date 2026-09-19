import { useMarkedSessions } from './useMarkedSessions';

/** Where the choice lives, beside the favourites and kept the same way. */
export const ARCHIVED = 'archived';

/**
 * Sessions put away: finished with, but not worth destroying.
 *
 * Most of a long-lived install is done. Deleting those loses what they knew and leaving them
 * means scrolling past them forever, so this is the middle: out of the way, still there, and
 * nothing on disk is touched (#101).
 *
 * Using one takes it back out. Archiving evicts, so a session in here is cold; loading it
 * again is a clear enough statement that it is not finished with. Leaving it archived would
 * mean it vanished back into a folded group the moment it was unloaded, having just been
 * worked in.
 */
export function useArchived() {
  const { ids, toggle, drop } = useMarkedSessions(ARCHIVED);
  return { archived: ids, toggle, unarchive: drop };
}