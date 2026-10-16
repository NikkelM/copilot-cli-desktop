import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

/** How far one arrow press moves the edge, in multiples of the text size. */
const STEP = 1;

/**
 * The edge between the session and the notes beside it, which can be taken hold of (#35).
 *
 * Over the boundary rather than beside it, so neither pane gives up a column to it - the
 * same arrangement as the sidebar's grip, and for the same reason.
 *
 * Arrows are reversed against that one: this column's own edge is on its left, so left is
 * wider here where left is narrower there. Home returns to the app's own width, which is
 * also what double-clicking does.
 */
export function NotesGrip({
  dragging,
  onStart,
  onNudge,
  onReset,
  label = 'Resize the notes',
}: {
  dragging: boolean;
  onStart: () => void;
  onNudge: (steps: number) => void;
  onReset: () => void;
  label?: string;
}) {
  const grab = (event: ReactPointerEvent) => {
    // The window's own drag-select would otherwise run alongside, selecting the transcript
    // as the pointer crosses it.
    event.preventDefault();
    onStart();
  };

  const key = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowLeft') onNudge(STEP);
    else if (event.key === 'ArrowRight') onNudge(-STEP);
    else if (event.key === 'Home') onReset();
    else return;

    // Arrows would otherwise scroll whatever is behind this as well as moving the edge.
    event.preventDefault();
  };

  return (
    <div
      className={dragging ? 'notes-grip dragging' : 'notes-grip'}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={grab}
      onDoubleClick={onReset}
      onKeyDown={key}
    />
  );
}
