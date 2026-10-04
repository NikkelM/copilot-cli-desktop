import { useEffect, useMemo, useState } from 'react';

import { sessionPreviews } from './sidecar';

/** How long to let the list settle before asking, so scrolling is not a read per frame. */
const SETTLE_MS = 150;

/**
 * What the sessions on screen last said (#240).
 *
 * This existed once and was removed for what it cost: it read the tail of every session
 * whose log had moved, on every refresh of a list of two hundred, and rewrote the whole
 * session array on every streamed reply so one row could change. The shape here is the
 * answer to both halves of that.
 *
 * Asked only about the rows a reader can actually see, which somebody scrolling a long list
 * never makes more than a screenful. Held apart from the sessions themselves, so a preview
 * arriving changes one map rather than two hundred objects.
 *
 * Nothing at all is read when no lines are being drawn. A setting of zero is not a narrower
 * row, it is a feature that is switched off.
 */
export function useSessionPreviews(visible: readonly string[], lines: number): Record<string, string> {
  const [previews, setPreviews] = useState<Record<string, string>>({});

  // What is on screen changes identity on every scroll event, so the effect depends on what
  // is in it. Sorted, because the same rows in another order are the same question.
  const wanted = useMemo(() => (lines > 0 ? [...visible].sort().join('\u0000') : ''), [visible, lines]);

  useEffect(() => {
    if (!wanted) {
      // Kept rather than cleared: turning the lines back on should not blank every row
      // while the same answers are fetched again.
      return;
    }

    let current = true;
    const ids = wanted.split('\u0000');

    // After the list settles. Scrolling through a hundred rows should ask once, not a
    // hundred times, and the rows passed on the way are not rows anybody looked at.
    const timer = setTimeout(() => {
      sessionPreviews(ids)
        .then((found) => {
          if (!current) return;
          // Merged rather than replaced, so scrolling back up does not refetch what is
          // already here and does not blank it in the meantime.
          setPreviews((before) => ({ ...before, ...found }));
        })
        .catch(() => {
          // A log that cannot be read is a row without a preview, which is how most rows
          // look anyway. Nothing here is worth interrupting anybody for.
        });
    }, SETTLE_MS);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [wanted]);

  return previews;
}
