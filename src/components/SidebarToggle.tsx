import { ChevronIcon } from './Icons';

/**
 * The control that folds the sidebar away and brings it back.
 *
 * Drawn in the sidebar's own header while there is one, and at the same corner of the window
 * once there is not: the place a reader looks for it does not move just because the thing it
 * belongs to is gone, and a control that only exists while it is not needed is no control at
 * all (#190).
 *
 * The chevron points the way the sidebar will go, which is the only thing about the two
 * states that is worth drawing differently.
 */
export function SidebarToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  const what = hidden ? 'Show the sidebar' : 'Hide the sidebar';

  return (
    <button
      type="button"
      className={hidden ? 'sidebar-toggle away' : 'sidebar-toggle'}
      onClick={onToggle}
      aria-expanded={!hidden}
      aria-label={what}
      title={`${what} (Ctrl+B)`}
    >
      {/* Rotated a quarter turn by the stylesheet: the shape already means "this way". */}
      <ChevronIcon open={!hidden} />
    </button>
  );
}
