import { useEffect } from 'react';

/**
 * The keys that move the focus about, which are the ones that scroll a list to follow it.
 *
 * Typing is deliberately not among them. A reader with the pointer resting over the sidebar
 * who writes a message and then clicks a session without ever moving the mouse would
 * otherwise lose that click, and nothing about typing drags rows under the pointer.
 */
const MOVES = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Tab',
  'F6',
]);

/**
 * Note on the document whether the keyboard is doing the work rather than the mouse.
 *
 * Arrowing down a list scrolls it to keep up, which drags rows under a pointer that has not
 * moved - so the row that happens to be under the mouse lights up and offers its tooltip
 * while the keyboard is somewhere else entirely. Two things claim to be the current row and
 * only one of them is.
 *
 * Written to the root element rather than held in state because what it changes is styling,
 * and a render on every arrow press would be a render per arrow press.
 */
export function useKeying(): void {
  useEffect(() => {
    const root = document.documentElement;
    /** Where the pointer was, to tell it being moved from the page moving under it. */
    let was: { x: number; y: number } | null = null;

    function onKeyDown(event: KeyboardEvent) {
      if (MOVES.has(event.key)) root.dataset.keying = '';
    }

    /**
     * The mouse is back, so the pointer may have the page again.
     *
     * Scrolling a list under a still pointer raises `mousemove` as well, carrying the
     * coordinates it already had - so the position is what says whether anybody moved it.
     * The first one answers nothing, having nothing to be compared against, so it is only
     * recorded: a real movement raises plenty more.
     */
    function onMouseMove(event: MouseEvent) {
      const moved = was !== null && (was.x !== event.clientX || was.y !== event.clientY);
      was = { x: event.clientX, y: event.clientY };
      if (moved) delete root.dataset.keying;
    }

    /** Reaching for either of these is reaching for the mouse, whatever the pointer did. */
    function onMouseUse() {
      delete root.dataset.keying;
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseUse);
    window.addEventListener('wheel', onMouseUse, { passive: true });

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseUse);
      window.removeEventListener('wheel', onMouseUse);
      delete root.dataset.keying;
    };
  }, []);
}
