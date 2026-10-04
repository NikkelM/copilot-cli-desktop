import { useEffect, useMemo, useState } from 'react';

import { wikiTags } from './sidecar';
import { useDismissedWikiTags } from './useDismissedWikiTags';

/** A tag the wiki already uses, and how many of its pages carry it. */
export interface WikiTag {
  tag: string;
  pages: number;
}

/**
 * The words the wiki is already written in, for the picker that tags a session (#35).
 *
 * A session tagged in the wiki's own words matches the pages written in them; one tagged in
 * different words matches nothing. That is not hypothetical - a session tagged `ireland` and
 * a page tagged `dublin` were about the same thing here and never met.
 *
 * Fetched when the picker opens rather than on mount. Most sessions are worked in without
 * anybody tagging them, and a walk of the wiki nobody asked for is a walk nobody asked for.
 *
 * Refusals are applied here rather than by whoever draws them, so what to offer and what to
 * stop offering are one question with one answer. Left to the caller it was a filter nothing
 * could test, and getting it wrong showed as nothing worse than an unused variable.
 *
 * Every failure is no tags. A machine with no wiki is the common case rather than a fault,
 * and the picker goes on offering what the sessions themselves use.
 */
export function useWikiTags(open: boolean): { tags: WikiTag[]; dismiss: (tag: string) => void } {
  const [found, setFound] = useState<WikiTag[]>([]);
  const { dismissed, dismiss } = useDismissedWikiTags();

  useEffect(() => {
    if (!open) return;

    let current = true;
    wikiTags()
      .then((tags) => {
        if (current) setFound(tags);
      })
      .catch(() => {
        if (current) setFound([]);
      });

    return () => {
      current = false;
    };
  }, [open]);

  const tags = useMemo(() => found.filter(({ tag }) => !dismissed.includes(tag)), [found, dismissed]);

  return { tags, dismiss };
}
