import { useCallback, useState } from 'react';

import { read as readStore, save } from './store';
import { normalise } from './useTags';

/**
 * Words from the wiki that are not worth offering again (#35).
 *
 * The suggestions are the wiki's commonest tags, and a wiki's commonest tags include the
 * ones it is organised by rather than the ones that say what a thing is about - `hades-ii`
 * is on 67 of 117 pages here. Those are not wrong, they are just never the answer, and a
 * list that keeps offering them is a list that gets ignored.
 *
 * Kept rather than retired: nothing is done to the wiki, which is somebody else's file. This
 * only says what this app should stop suggesting.
 */
export const DISMISSED_WIKI_TAGS = 'dismissedWikiTags';

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(readStore('sessions', DISMISSED_WIKI_TAGS) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((tag): tag is string => typeof tag === 'string').map(normalise))].filter(Boolean);
  } catch {
    // A store that cannot be read is one nobody can fix from here, and offering every
    // suggestion is a smaller failure than offering none.
    return [];
  }
}

export function useDismissedWikiTags() {
  const [dismissed, setDismissed] = useState<string[]>(read);

  const dismiss = useCallback((raw: string) => {
    const tag = normalise(raw);
    if (!tag) return;

    setDismissed((current) => {
      if (current.includes(tag)) return current;
      const next = [...current, tag];
      save('sessions', DISMISSED_WIKI_TAGS, JSON.stringify(next));
      return next;
    });
  }, []);

  return { dismissed, dismiss };
}
