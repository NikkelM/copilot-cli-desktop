import { useCallback, useEffect, useRef, useState } from 'react';

import { messageOf } from './errors';
import { listWikiPages, readWikiPage } from './sidecar';
import type { WikiPage, WikiPageContent } from '../../shared/protocol';

/** Where a reader who opens the wiki without naming a page starts. */
const ENTRY = ['index.md', 'Home.md', 'README.md'];

/**
 * The knowledge base, and the page being read.
 *
 * Fetched when the browser is first opened rather than on mount: most sessions are worked
 * in without the wiki being looked at, and a list nobody asked for is a disk walk nobody
 * asked for. Held afterwards, because which pages exist changes about as often as the
 * commands do.
 *
 * Nothing here costs a Copilot process. That is the point of it being files.
 */
export function useWiki(open: boolean) {
  const [pages, setPages] = useState<WikiPage[] | null>(null);
  const [page, setPage] = useState<WikiPageContent | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * Where the reader has been, so Back means what it does everywhere else.
   *
   * The path only. Re-reading a page costs one file read, and holding every page visited
   * would grow for as long as the browser stayed open.
   */
  const [trail, setTrail] = useState<string[]>([]);
  /** Which page is being read, tracked outside state so a fetch can tell if it is stale. */
  const wanted = useRef<string | null>(null);

  useEffect(() => {
    if (!open || pages !== null) return;

    let current = true;
    listWikiPages()
      .then((found) => {
        if (current) setPages(found);
      })
      .catch((error: unknown) => {
        if (current) setFailed(`Could not read the wiki: ${messageOf(error)}`);
      });

    return () => {
      current = false;
    };
  }, [open, pages]);

  const read = useCallback((path: string) => {
    wanted.current = path;
    setLoading(true);
    setFailed(null);

    readWikiPage(path)
      .then((found) => {
        // Another page was asked for while this one was being read.
        if (wanted.current !== path) return;
        setPage(found);
        if (!found) setFailed(`No page at ${path}`);
      })
      .catch((error: unknown) => {
        if (wanted.current === path) setFailed(`Could not read ${path}: ${messageOf(error)}`);
      })
      .finally(() => {
        if (wanted.current === path) setLoading(false);
      });
  }, []);

  /** Follow a link, remembering where it was followed from. */
  const go = useCallback(
    (path: string) => {
      setTrail((current) => (page && page.path !== path ? [...current, page.path] : current));
      read(path);
    },
    [page, read],
  );

  const back = useCallback(() => {
    setTrail((current) => {
      const previous = current[current.length - 1];
      if (previous === undefined) return current;
      read(previous);
      return current.slice(0, -1);
    });
  }, [read]);

  // The first page the reader sees, chosen from what this wiki actually has rather than
  // assumed: a knowledge base may be laid out around any of these.
  useEffect(() => {
    if (!open || !pages || page || wanted.current) return;

    const entry = ENTRY.find((candidate) => pages.some((each) => each.path === candidate)) ?? pages[0]?.path;
    if (entry) read(entry);
  }, [open, pages, page, read]);

  return { pages, page, loading, failed, go, back, canGoBack: trail.length > 0 };
}




