import { useMarkedSessions } from './useMarkedSessions';

/** Where the choice lives, beside the favourites and kept the same way. */
export const ARCHIVED = 'archived';

/**
 * Sessions put away: finished with, but not worth destroying.
 *
 * Most of a long-lived install is done. Deleting those loses what they knew and leaving them
 * means scrolling past them forever, so this is the middle: out of the way, still there, and
 * nothing on disk is touched (#101).
 */
export function useArchived() {
  const { ids, toggle } = useMarkedSessions(ARCHIVED);
  return { archived: ids, toggle };
}