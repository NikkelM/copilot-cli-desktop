import { useEffect, useRef } from 'react';

/** One thing the menu can do to a session. */
export interface SessionAction {
  id: string;
  label: string;
  /** Absent when the action can be taken. Present to say why it cannot, in place of doing it. */
  refused?: string;
  /**
   * How much the action takes back, for the ones drawn apart at the foot of the menu.
   *
   * `caution` puts a session away and is undone by pressing again; `danger` destroys a
   * conversation. Two colours rather than one, because they are not the same risk and a
   * reader deciding between them is deciding exactly that.
   */
  tone?: 'caution' | 'danger';
  run: () => void;
}

/**
 * The actions a session row offers on right-click.
 *
 * At the pointer rather than at the row, which is where every other context menu on the
 * machine appears and is the only position that does not depend on where the row happens to
 * be scrolled to.
 *
 * Actions that cannot be taken are shown and refused rather than left out. A menu whose
 * items move depending on state makes the reader check what is there before pointing, and
 * the reason a thing is unavailable is usually the thing they wanted to know (#107).
 */
export function SessionMenu({
  at,
  actions,
  onClose,
}: {
  /** Where the pointer was, in client coordinates. */
  at: { x: number; y: number };
  actions: SessionAction[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    // Capture, so a click that would select a session behind the menu closes it instead of
    // doing both.
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  useEffect(() => {
    const menu = box.current;
    if (!menu) return;

    // Placed after it is measured, because a menu opened near the bottom or the right edge
    // of a window would otherwise be drawn partly outside it and cut off.
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - height - 4))}px`;
  }, [at]);

  // The rule drawn above the foot of the menu belongs to whichever toned action comes
  // first, not to each of them: two would draw two lines and make a group of one.
  const apart = actions.findIndex((action) => action.tone !== undefined);

  return (
    <div className="session-menu" ref={box} role="menu">
      {actions.map((action, index) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className={`session-menu-item${action.tone ? ` ${action.tone}` : ''}${index === apart ? ' apart' : ''}`}
          disabled={action.refused !== undefined}
          title={action.refused}
          onClick={() => {
            action.run();
            onClose();
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
