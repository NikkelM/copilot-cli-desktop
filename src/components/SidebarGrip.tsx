import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

/** How far one arrow press moves the edge, in multiples of the text size. */
const STEP = 1;

/**
 * The edge between the sidebar and the session, which can be taken hold of.
 *
 * Over the boundary rather than beside it, so neither pane gives up a column to it: the grid
 * has two, and a third for this would mean the sidebar and the divider disagreeing about
 * where the sidebar ends.
 *
 * Arrow keys do the same job for a reader who is not using a pointer, and Home returns to
 * the app's own width, which is also what double-clicking does (#189).
 */
export function SidebarGrip({
  hidden = false,
  dragging,
  onStart,
  onNudge,
  onReset,
}: {
  /** Whether the sidebar is folded away, leaving no edge between two panes to take hold of. */
  hidden?: boolean;
  dragging: boolean;
  onStart: () => void;
  onNudge: (steps: number) => void;
  onReset: () => void;
}) {
  const grab = (event: ReactPointerEvent) => {
    // The window's own drag-select would otherwise run alongside, selecting the transcript
    // as the pointer crosses it.
    event.preventDefault();
    onStart();
  };

  const key = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowLeft') onNudge(-STEP);
    else if (event.key === 'ArrowRight') onNudge(STEP);
    else if (event.key === 'Home') onReset();
    else return;

    // Arrows would otherwise scroll whatever is behind this as well as moving the edge.
    event.preventDefault();
  };

  return (
    <div
      className={dragging ? 'sidebar-grip dragging' : 'sidebar-grip'}
      // Folded away there is no boundary to describe and no width to nudge: all that is left
      // is pulling the sidebar back, and the chevron beside it already offers the keyboard
      // that. So it stops being a stop on the way round, while a pointer can still take hold
      // of the edge to ask for the sidebar again (#190).
      role={hidden ? undefined : 'separator'}
      aria-orientation={hidden ? undefined : 'vertical'}
      aria-label={hidden ? undefined : 'Resize the sidebar'}
      tabIndex={hidden ? -1 : 0}
      onPointerDown={grab}
      onDoubleClick={onReset}
      onKeyDown={key}
    />
  );
}
