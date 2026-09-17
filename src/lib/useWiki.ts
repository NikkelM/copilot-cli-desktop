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
   * Where the reader has been, and where they were before going back.
   *
   * A position in a list rather than two stacks: it is the model a browser uses, and it is
   * what makes forward mean anything - going back and then somewhere new has to discard
   * what was ahead, which two stacks get wrong unless they are kept in step by hand.
   *
   * Paths only. Re-reading a page costs one file read, and holding every page visited would
   * grow for as long as the browser stayed open.
   */
  const [history, setHistory] = useState<{ visited: string[]; at: number }>({ visited: [], at: -1 });
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

  /** Follow a link, which is where the reader now is and the end of anything that was ahead. */
  const go = useCallback(
    (path: string) => {
      setHistory((current) => {
        if (current.visited[current.at] === path) return current;
        // Anything ahead was reached from where the reader no longer is, so it is not a
        // future any more. This is the one rule two stacks tend to get wrong.
        const visited = [...current.visited.slice(0, current.at + 1), path];
        return { visited, at: visited.length - 1 };
      });
      read(path);
    },
    [read],
  );

  /**
   * Step through what has been read.
   *
   * The move is decided here rather than inside the state updater, which React invokes
   * twice under StrictMode and may replay from a discarded render - a read fired from in
   * there would happen more than once for one keypress.
   */
  const step = useCallback(
    (by: -1 | 1) => {
      const to = history.at + by;
      const path = history.visited[to];
      if (path === undefined) return;

      setHistory({ visited: history.visited, at: to });
      read(path);
    },
    [history, read],
  );

  const back = useCallback(() => step(-1), [step]);
  const forward = useCallback(() => step(1), [step]);

  // The first page the reader sees, chosen from what this wiki actually has rather than
  // assumed: a knowledge base may be laid out around any of these.
  useEffect(() => {
    if (!open || !pages || page || wanted.current) return;

    const entry = ENTRY.find((candidate) => pages.some((each) => each.path === candidate)) ?? pages[0]?.path;
    if (entry) go(entry);
  }, [open, pages, page, go]);

  return {
    pages,
    page,
    loading,
    failed,
    go,
    back,
    forward,
    canGoBack: history.at > 0,
    canGoForward: history.at >= 0 && history.at < history.visited.length - 1,
    /** Where the reader has been, newest last, for a trail showing how they got here. */
    trail: history.visited.slice(0, history.at + 1),
  };
}




