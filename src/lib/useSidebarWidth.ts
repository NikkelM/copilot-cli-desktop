import { useCallback, useEffect, useRef, useState } from 'react';

import { BASE_PX } from './scale';
import { DEFAULT_MULTIPLE, WIDTH_KEY, applyWidth, clampWidth, readWidth } from './sidebarWidth';

/**
 * The sidebar's width, dragged in pixels and remembered as a multiple of the text size.
 *
 * The drag reads the pointer's distance from the window's left edge, which is where the
 * sidebar starts, rather than accumulating deltas: a pointer that leaves the window and
 * comes back would otherwise have moved the edge by however far it travelled outside.
 */
export function useSidebarWidth() {
  const [multiple, setMultiple] = useState(readWidth);
  const [dragging, setDragging] = useState(false);
  /** The base in force, so a drag in pixels can be turned into multiples of it. */
  const base = useRef(BASE_PX);

  // On every change including the first, so a remembered width is in force before the
  // sidebar is drawn at the default and then jumps.
  useEffect(() => {
    applyWidth(multiple);
    if (multiple === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(multiple));
  }, [multiple]);

  const start = useCallback(() => {
    // Read now rather than per move: it cannot change mid-drag, and getComputedStyle is the
    // expensive kind of read to do on every pointer event.
    const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    base.current = Number.isFinite(size) && size > 0 ? size : BASE_PX;
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent) => setMultiple(clampWidth(event.clientX / base.current));
    const stop = () => setDragging(false);

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
  const reset = useCallback(() => setMultiple(null), []);

  /**
   * Move the edge by a step, for a keyboard.
   *
   * From the width in force rather than from the stored one, which is null until someone has
   * chosen: the first press should move the edge from where it is, not jump to a default.
   */
  const nudge = useCallback((steps: number) => {
    setMultiple((current) => clampWidth((current ?? measure()) + steps));
  }, []);

  return { multiple, dragging, start, reset, nudge };
}

/**
 * The width the sidebar currently has, in multiples of the base.
 *
 * Measured from the element rather than read from the custom property: a custom property
 * comes back from getComputedStyle as it was written, so the stylesheet's own default reads
 * as the string "calc(160px + ...)" rather than as a number of pixels. The element knows,
 * and it also accounts for the vw ceiling, so a press moves the edge from where the reader
 * can see it.
 */
function measure(): number {
  const base = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const pixels = document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0;

  if (!Number.isFinite(pixels) || pixels <= 0 || !Number.isFinite(base) || base <= 0) return DEFAULT_MULTIPLE;
  return pixels / base;
}
