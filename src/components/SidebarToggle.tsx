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
export function SidebarToggle({
  hidden,
  waiting = 0,
  onToggle,
}: {
  hidden: boolean;
  /** Sessions stopped on a question. Only drawn while hidden, where the count is out of reach. */
  waiting?: number;
  onToggle: () => void;
}) {
  const what = hidden ? 'Show the sidebar' : 'Hide the sidebar';
  // Only while hidden: with the sidebar open the count itself is a few pixels away, and two
  // marks saying the same thing beside each other says it less clearly than one.
  const marked = hidden && waiting > 0;
  const why = marked
    ? `${waiting} session${waiting === 1 ? '' : 's'} waiting for an answer. ${what} (Ctrl+B)`
    : `${what} (Ctrl+B)`;

  return (
    <button
      type="button"
      className={hidden ? 'sidebar-toggle away' : 'sidebar-toggle'}
      onClick={onToggle}
      aria-expanded={!hidden}
      aria-label={marked ? `${what}, ${waiting} waiting for an answer` : what}
      data-tip={why}
    >
      {/* Rotated a quarter turn by the stylesheet: the shape already means "this way". */}
      <ChevronIcon open={!hidden} />
      {marked && <span className="toggle-waiting" aria-hidden />}
    </button>
  );
}
