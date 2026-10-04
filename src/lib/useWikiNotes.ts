import { useEffect, useMemo, useState } from 'react';

import { wikiForSession } from './sidecar';
import type { WikiPage } from '../../shared/protocol';

/**
 * The notes the open session's subject already has (#35).
 *
 * Asked once per session rather than per row: the sidebar is the part of this app that must
 * cost nothing, and two hundred rows each walking the wiki is exactly the kind of work it
 * exists to avoid. One session is open at a time, and it is the only one whose subject
 * anybody is looking at.
 *
 * Asked again when its tags change, because tagging a session is how somebody says what it
 * is about, and a count that ignored that would be answering a question nobody is asking
 * any more.
 *
 * Every failure is no pages. A machine with no wiki is the common case rather than a fault,
 * and a header that cannot say how many notes there are should say nothing at all.
 */
export function useWikiNotes(repository: string | null, cwd: string | null, tags: readonly string[] = []) {
  const [pages, setPages] = useState<WikiPage[]>([]);

  // Whatever holds the tags rebuilds the array on every render, so the effect depends on
  // what is in it rather than on its identity. Depending on the array itself re-ran this on
  // every render, which is a request per render and, under test, a loop that never settles.
  const named = useMemo(() => [...tags].sort().join('\u0000'), [tags]);

  useEffect(() => {
    if (!repository && !cwd && !named) {
      setPages([]);
      return;
    }

    // Answers landing after the reader has moved on would describe the session they left.
    let current = true;
    wikiForSession(repository, cwd, named ? named.split('\u0000') : [])
      .then((found) => {
        if (current) setPages(found.pages);
      })
      .catch(() => {
        if (current) setPages([]);
      });

    return () => {
      current = false;
    };
  }, [repository, cwd, named]);

  return pages;
}
