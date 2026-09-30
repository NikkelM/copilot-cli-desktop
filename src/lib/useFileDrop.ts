import { useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import { useTauriEvent } from './useTauriEvent';

/**
 * Files dragged onto the window, wherever in it they are let go (#231).
 *
 * The webview's own drag events are no use here. HTML drag-and-drop hands over a `File`
 * with no path, and a path is exactly what an attachment is - the app attaches a file
 * where it lies rather than copying it, so an attachment without one is nothing. The
 * runtime's own drag events carry absolute paths, so they are what this listens to.
 *
 * The whole window is the target rather than the composer. Dropping a screenshot is aimed
 * at the conversation, not at a particular few hundred pixels of it, and a target that has
 * to be found is a target that gets missed.
 *
 * @param onDrop what was let go, once, with absolute paths
 * @param enabled whether a drop would go anywhere, so nothing is promised that cannot happen
 */
export function useFileDrop(onDrop: (paths: string[]) => void, enabled: boolean): boolean {
  const [over, setOver] = useState(false);

  /**
   * Read inside the subscription rather than closed over.
   *
   * Re-subscribing on every change would tear down the listener mid-drag, and a `leave`
   * arriving at a listener that no longer exists leaves the overlay up for ever.
   */
  const latest = useRef({ onDrop, enabled });
  latest.current = { onDrop, enabled };

  // Subscribed once and never again, which is what the ref above is for.
  useTauriEvent(
    () =>
      getCurrentWebview().onDragDropEvent((event) => {
        const drag = event.payload;

        if (drag.type === 'enter' || drag.type === 'over') {
          // Nothing is offered where a drop would have nowhere to go, so the overlay never
          // invites something the app would then have to refuse.
          setOver(latest.current.enabled);
          return;
        }

        // Down on both, since the drag is over either way: a drop that is acted on still
        // ends the drag, and leaving the overlay up would say it had not.
        setOver(false);
        if (drag.type === 'drop' && latest.current.enabled && drag.paths.length > 0) {
          latest.current.onDrop(drag.paths);
        }
      }),
    [],
  );

  return over;
}
