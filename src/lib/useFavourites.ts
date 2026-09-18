import { useMarkedSessions } from './useMarkedSessions';

/** Where the choice lives. The CLI owns its own store and this app only ever reads it. */
export const FAVOURITES = 'copilot-desktop.favourites';

/** Sessions someone marked to keep within reach, which the sidebar puts above the rest. */
export function useFavourites() {
  const { ids, toggle } = useMarkedSessions(FAVOURITES);
  return { favourites: ids, toggle };
}
