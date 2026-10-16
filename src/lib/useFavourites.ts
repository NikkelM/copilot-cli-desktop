import { useMarkedSessions } from './useMarkedSessions';
import { useState } from 'react';
import { read, save } from './store';

/** What the choice is called in the app's own store. The CLI's is read-only here. */
export const FAVOURITES = 'favourites';

/** Sessions someone marked to keep within reach, which the sidebar puts above the rest. */
export function useFavourites() {
  const { ids, toggle, reorder } = useMarkedSessions(FAVOURITES);
  const [manual, setManual] = useState(() => read('sessions', 'favouritesManuallyOrdered') === 'true');
  const move = (sessionId: string, targetId: string, after = false, visibleOrder?: readonly string[]) => {
    if (sessionId === targetId || !ids.includes(sessionId) || !ids.includes(targetId)) return;
    setManual(true);
    save('sessions', 'favouritesManuallyOrdered', 'true');
    reorder(sessionId, targetId, after, visibleOrder);
  };
  return { favourites: ids, toggle, reorder: move, order: manual ? ids : undefined };
}
