import { useCallback, useState } from 'react';
import { read as readStore, save } from './store';

/**
 * Whether deleting still asks first.
 *
 * Its own key rather than part of a settings object: it is not a preference someone sets, it
 * is one they turn off in passing while doing something else, and the only way back is
 * through the app's settings. Keeping it separate means a future settings file can carry it
 * without this having waited for one.
 */
const CONFIRM_DELETE = 'confirmDelete';

function read(): boolean {
  // Absent means ask. Only the exact stored false turns it off, so a key holding anything
  // unexpected leaves the question in place rather than silently skipping it.
  return readStore('settings', CONFIRM_DELETE) !== 'false';
}

export function useConfirmDelete() {
  const [confirms, setConfirms] = useState(read);

  const stopAsking = useCallback(() => {
    save('settings', CONFIRM_DELETE, 'false');
    setConfirms(false);
  }, []);

  return { confirms, stopAsking };
}
