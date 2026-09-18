import { useCallback, useState } from 'react';

/** Where the choice lives, beside the other things the sidebar remembers about itself. */
const COMPACT = 'copilot-desktop.compact';

interface Stored {
  /** What a row does unless it says otherwise. */
  all: boolean;
  /** Rows that disagree with it. True is open, false is collapsed, absent is neither. */
  some: Record<string, boolean>;
}

function read(): Stored {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COMPACT) ?? '{}');
    const held = parsed && typeof parsed === 'object' ? (parsed as Partial<Stored>) : {};
    return {
      all: held.all === true,
      some: held.some && typeof held.some === 'object' ? (held.some as Record<string, boolean>) : {},
    };
  } catch {
    return { all: false, some: {} };
  }
}

/**
 * How much of each session row is drawn.
 *
 * A row carries a title, a time and repository, and two lines of what was last said. That
 * is what finding a half-remembered session needs, and four times the height a list of
 * titles needs once you know which one you want (#188).
 *
 * One setting for the list and an exception per row, rather than a state per row: what
 * someone wants is nearly always all of them, and the exceptions are few enough to name.
 * Storing only the disagreements also means the record does not grow with the session list.
 */
export function useCompact() {
  const [state, setState] = useState<Stored>(read);

  const save = (next: Stored) => {
    setState(next);
    try {
      localStorage.setItem(COMPACT, JSON.stringify(next));
    } catch {
      // It still works for this run; only remembering it does not.
    }
  };

  /**
   * Whether one row is drawn short.
   *
   * Its own answer when it has one, and the list's otherwise.
   */
  const collapsed = useCallback(
    (sessionId: string) => (sessionId in state.some ? !state.some[sessionId] : state.all),
    [state],
  );

  /**
   * Turn the whole list over, and drop the exceptions.
   *
   * Asking for all of them collapsed means all of them, including the three that were
   * opened earlier - leaving those behind would make the control do nothing visible on a
   * list whose exceptions happened to be on screen.
   */
  const toggleAll = useCallback(() => save({ all: !state.all, some: {} }), [state.all]);

  /** Turn one row over, against whatever the list is doing. */
  const toggleOne = useCallback(
    (sessionId: string) => {
      const open = collapsed(sessionId);
      const some = { ...state.some };
      // Back to following the list rather than recorded as agreeing with it, so a later
      // change to the list carries this row with it.
      if (open === !state.all) delete some[sessionId];
      else some[sessionId] = open;
      save({ ...state, some });
    },
    [state, collapsed],
  );

  return { compact: state.all, collapsed, toggleAll, toggleOne };
}
