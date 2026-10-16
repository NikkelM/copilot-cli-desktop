import { useCallback, useEffect, useState } from 'react';

import type { WikiPage } from '../../shared/protocol';

/**
 * Wiki notes and session plans share one column and replace each other
 *
 * Changing sessions closes the column, while browsing the wiki only hides it until returning
 */
export function useNotesColumn(sessionId: string | null, notes: readonly WikiPage[], browsing = false) {
  const [wanted, setWanted] = useState<'notes' | 'plan' | null>(null);

  useEffect(() => setWanted(null), [sessionId]);

  const show = useCallback((kind: 'notes' | 'plan' = 'notes') => setWanted(kind), []);
  const hide = useCallback(() => setWanted(null), []);
  const open = wanted !== null && !browsing && (wanted === 'plan' || notes.length > 0);

  return {
    open,
    kind: open ? wanted : null,
    show,
    hide,
  };
}
