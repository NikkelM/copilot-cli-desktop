import { useEffect, useState } from 'react';

import { searchSessions } from './sidecar';
import type { SessionMatch } from '../../shared/protocol';

/**
 * How long to wait after a keystroke before asking.
 *
 * The query itself costs single-digit milliseconds, so this is about the round trip to the
 * sidecar rather than about the search: holding a key down should not queue a request per
 * character. The same wait the id lookup beside it uses.
 */
const SETTLE = 200;

/**
 * The shortest query worth asking about.
 *
 * One or two characters match almost everything that was ever said, which would put the whole
 * list back on screen under the guise of having found something. The metadata half of the
 * filter still answers at any length, because a two-letter folder name is a real thing to
 * look for and a two-letter phrase is not.
 */
const ENOUGH = 3;

const NOTHING: ReadonlyMap<string, SessionMatch> = new Map();

/**
 * Which sessions said what was typed, by id.
 *
 * A map rather than a list because the sidebar asks about one session at a time, while it is
 * already walking the list it has.
 *
 * Kept while a new answer is fetched rather than cleared, so rows do not empty and refill on
 * every keystroke. What is on screen is a query or two behind for a moment, which reads as
 * the list catching up; clearing first reads as the search breaking and recovering.
 */
export function useSessionSearch(query: string): ReadonlyMap<string, SessionMatch> {
  const [found, setFound] = useState<ReadonlyMap<string, SessionMatch>>(NOTHING);
  const wanted = query.trim();
  const worth = wanted.length >= ENOUGH;

  useEffect(() => {
    if (!worth) {
      setFound(NOTHING);
      return;
    }

    let current = true;
    const timer = setTimeout(() => {
      searchSessions(wanted)
        .then((matches) => {
          if (current) setFound(new Map(matches.map((match) => [match.sessionId, match])));
        })
        // A search nobody can run is a list filtered by name alone rather than an error over
        // it: the metadata half is still true, and is what the box did before this existed.
        .catch(() => undefined);
    }, SETTLE);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [wanted, worth]);

  return found;
}
