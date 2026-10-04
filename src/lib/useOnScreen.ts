import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Which rows a reader can actually see (#240).
 *
 * The sidebar draws every row it has rather than only the ones in view, so "on screen" is a
 * question the DOM has to answer rather than the list. An observer answers it without the
 * scroll handler that would otherwise run on every frame.
 *
 * What this is for is bounding work that used to be done per session: reading what each one
 * last said. A list of two hundred shows perhaps twenty at a time, and twenty is the number
 * that makes that affordable.
 *
 * The caller must hand each row the same `ref` callback on every render. React detaches a
 * ref whose identity changed and attaches it again, and a row detaching is how this is told
 * a row has gone - so an arrow built inline would unwatch every row on every render.
 */
export function useOnScreen(): { watch: (id: string, node: Element | null) => void; visible: string[] } {
  const [visible, setVisible] = useState<string[]>([]);
  const seen = useRef(new Map<Element, string>());
  const shown = useRef(new Set<string>());
  const observer = useRef<IntersectionObserver | null>(null);

  /**
   * The observer, built the first time there is a row to watch.
   *
   * Not built in an effect, which is the bug this replaced: React attaches a child's ref
   * before it runs the parent's effect, so every row in the first list arrived before the
   * observer existed and none of them was ever watched.
   */
  const look = useCallback((): IntersectionObserver | null => {
    if (observer.current) return observer.current;
    // jsdom has no observer, and a component that cannot watch anything should still draw.
    if (typeof IntersectionObserver === 'undefined') return null;

    observer.current = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const id = seen.current.get(entry.target);
          if (!id) continue;
          const had = shown.current.has(id);
          if (entry.isIntersecting && !had) {
            shown.current.add(id);
            changed = true;
          } else if (!entry.isIntersecting && had) {
            shown.current.delete(id);
            changed = true;
          }
        }
        if (changed) setVisible([...shown.current]);
      },
      // A row just past the fold is one scroll from being read, and asking for it early is
      // what keeps a preview from appearing after the reader has already looked at the row.
      { rootMargin: '200px' },
    );
    return observer.current;
  }, []);

  // Only to let go on the way out. Building it here would be too late for the first list.
  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );

  /**
   * Take a row, or give one back.
   *
   * A ref callback, so React says when a row arrives and when it leaves and nothing has to
   * guess which rows are still drawn.
   */
  const watch = useCallback(
    (id: string, node: Element | null) => {
      if (node) {
        seen.current.set(node, id);
        look()?.observe(node);
        return;
      }

      for (const [element, held] of seen.current) {
        if (held !== id) continue;
        observer.current?.unobserve(element);
        seen.current.delete(element);
      }
      if (shown.current.delete(id)) setVisible([...shown.current]);
    },
    [look],
  );

  return { watch, visible };
}
