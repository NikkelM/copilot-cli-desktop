import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Between the menu and the control it hangs off, and between the menu and the screen edge. */
const GAP = 4;

/** Below this there is not enough room under the control to be worth opening downwards. */
const LEAST = 160;

/** At most this much of the screen, so a long list never becomes the whole window. */
const SHARE = 0.6;

/**
 * A menu that hangs off a control without being trapped by whatever the control sits in.
 *
 * Drawn on the body rather than beside the control, because a menu nested in a pane that
 * scrolls is clipped by it: the settings window cut the model list off halfway. It is fixed
 * to where the control is instead, and follows it when anything scrolls or the window
 * resizes, so the two still move together.
 *
 * It stays a React child of whatever rendered it, which matters more than where it is
 * drawn: React sends events up the tree they were written in, not the tree they landed in,
 * so a dialog that stops clicks inside itself still stops clicks in here.
 */
export function FloatingMenu({
  anchor,
  onDismiss,
  className,
  children,
  ...rest
}: {
  /** The control the menu belongs to: both where it is drawn and what counts as inside it. */
  anchor: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'ref'>) {
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<CSSProperties | null>(null);

  const place = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;

    const below = window.innerHeight - rect.bottom - GAP * 2;
    const above = rect.top - GAP * 2;
    // Upwards only when down is too cramped to be usable and up is genuinely roomier,
    // since a menu that keeps swapping sides as the page scrolls is harder to follow.
    const up = below < LEAST && above > below;
    // Right-aligned to the control, then pulled back in if that would hang it off screen.
    const width = menu.current?.offsetWidth ?? 0;
    const right = Math.max(GAP, window.innerWidth - rect.right);

    setAt({
      right: Math.min(right, Math.max(GAP, window.innerWidth - width - GAP)),
      ...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
      maxHeight: Math.min(window.innerHeight * SHARE, up ? above : below),
    });
  }, [anchor]);

  // Before paint, so the menu is never seen anywhere but where it belongs.
  useLayoutEffect(() => {
    place();
    // Captured, so scrolling any pane the control sits in carries the menu along rather
    // than leaving it behind at the place the control used to be.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [place]);

  useEffect(() => {
    // Clicking elsewhere, or pressing Escape, is how a menu is dismissed everywhere else.
    // The control counts as inside: pressing it again is its own way of closing.
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || anchor.current?.contains(target)) return;
      onDismiss();
    };
    // Stopped here, or Escape would dismiss the menu and then carry on to close the window
    // the menu was opened in, which is two answers to one press.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onDismiss();
    };

    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [anchor, onDismiss]);

  return createPortal(
    // Hidden until measured rather than drawn at a guessed spot, though the measuring runs
    // before paint, so this only shows if a control is asked about before it has a size.
    // Every menu carries the class that puts it where and how high it belongs, since being
    // drawn on the body is this component's doing rather than any one menu's.
    <div {...rest} className={className ? `floating ${className}` : 'floating'} ref={menu} style={at ?? hidden}>
      {children}
    </div>,
    document.body,
  );
}

/** Not `display: none`, which has no size to measure. */
const hidden: CSSProperties = { visibility: 'hidden' };
