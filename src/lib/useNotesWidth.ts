import { useCallback, useEffect, useRef, useState } from 'react';

import { BASE_PX } from './scale';
import {
  DEFAULT_NOTES_MULTIPLE,
  NOTES_WIDTH_KEY,
  WIDEST_NOTES,
  applyNotesWidth,
  clampNotesWidth,
  readNotesWidth,
  roomForNotes,
} from './notesWidth';
import { forget, save } from './store';

/**
 * The notes column's width, dragged in pixels and remembered as a multiple of the text size.
 *
 * The drag reads the pointer's distance from the window's *right* edge, which is where this
 * column ends, rather than accumulating deltas: a pointer that leaves the window and comes
 * back would otherwise have moved the edge by however far it travelled outside. That is the
 * one real difference from the sidebar's, whose column starts at the left edge instead.
 */
export function useNotesWidth() {
  const [multiple, setMultiple] = useState(readNotesWidth);
  const [dragging, setDragging] = useState(false);
  /** The base in force, so a drag in pixels can be turned into multiples of it. */
  const base = useRef(BASE_PX);
  /** Where the edge has been dragged to but not yet told React about. */
  const latest = useRef<number | null>(null);
  /**
   * The most the column may take, read when a drag starts.
   *
   * Clamped here as well as in the stylesheet, which would otherwise stop the column
   * growing while the number kept climbing - so dragging back would do nothing until the
   * pointer caught up with where the edge actually is.
   */
  const room = useRef(WIDEST_NOTES);

  // On every change including the first, so a remembered width is in force before the
  // column is drawn at the default and then jumps.
  useEffect(() => {
    applyNotesWidth(multiple);
    if (multiple === null) forget('settings', NOTES_WIDTH_KEY);
    else save('settings', NOTES_WIDTH_KEY, String(multiple));
  }, [multiple]);

  const start = useCallback(() => {
    // Read now rather than per move: neither can change mid-drag, and both are the
    // expensive kind of read to do on every pointer event.
    const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    base.current = Number.isFinite(size) && size > 0 ? size : BASE_PX;
    room.current = roomForNotes(base.current);
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    /**
     * Written straight to the document rather than through React.
     *
     * A drag is one pointer event a frame, and a render of this app is a render of the
     * transcript, the sidebar and whatever page the notes column is holding. Putting the
     * width through state made every frame of a drag re-render all of it, which is what
     * made this stutter. The column is a custom property, so the DOM can be told directly
     * and React told once, at the end.
     */
    const move = (event: PointerEvent) => {
      // From the right edge: this column ends there, so its width is whatever is left
      // between the pointer and the window's edge.
      const to = clampNotesWidth((window.innerWidth - event.clientX) / base.current, room.current);
      latest.current = to;
      applyNotesWidth(to);
    };

    const stop = () => {
      setDragging(false);
      // Now React is told, once, which is also what writes it down for next time.
      if (latest.current !== null) setMultiple(latest.current);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    // A drag interrupted by anything else ends rather than following the pointer invisibly.
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragging]);

  /** Back to the app's own width, which is the cheapest way out of one someone regrets. */
  const reset = useCallback(() => {
    latest.current = null;
    // Cleared here as well as by the effect. A drag writes the property directly, so the
    // state may already be null with a width still on the document, and setting null again
    // would change nothing and leave it there.
    applyNotesWidth(null);
    setMultiple(null);
  }, []);

  /**
   * Move the edge by a step, for a keyboard.
   *
   * From the width in force rather than from the stored one, which is null until somebody
   * has chosen: the first press should move the edge from where it is, not jump to a
   * default. Left is wider here, because the column's own edge is the one on the left.
   */
  const nudge = useCallback((steps: number) => {
    setMultiple((current) => {
      const base = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || BASE_PX;
      const to = clampNotesWidth((current ?? measure()) + steps, roomForNotes(base));
      latest.current = to;
      return to;
    });
  }, []);

  return { multiple, dragging, start, reset, nudge };
}

/**
 * The width the column currently has, in multiples of the base.
 *
 * Measured from the element rather than read from the custom property, which comes back from
 * getComputedStyle as it was written: the stylesheet's own default reads as the string
 * `calc(...)` rather than as a number of pixels.
 */
function measure(): number {
  const base = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const pixels = document.querySelector('.notes')?.getBoundingClientRect().width ?? 0;

  if (!Number.isFinite(pixels) || pixels <= 0 || !Number.isFinite(base) || base <= 0) return DEFAULT_NOTES_MULTIPLE;
  return pixels / base;
}
