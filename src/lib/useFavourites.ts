import { useMarkedSessions } from './useMarkedSessions';

/** What the choice is called in the app's own store. The CLI's is read-only here. */
export const FAVOURITES = 'favourites';

/** Sessions someone marked to keep within reach, which the sidebar puts above the rest. */
export function useFavourites() {
  const { ids, toggle } = useMarkedSessions(FAVOURITES);
  return { favourites: ids, toggle };
}
