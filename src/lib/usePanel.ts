import { useCallback, useEffect, useState } from 'react';

/**
 * The tall panels that open under a transcript.
 *
 * `changes` is what the agent edited, `repository` is the working tree including the
 * reader's own edits, `todos` is what the agent says it is doing, and `environment` is what
 * the session can reach. Deliberately separate things rather than one, since acting on one
 * must never be mistaken for acting on another.
 */
export type Panel = 'changes' | 'environment' | 'repository' | 'todos';

/**
 * The panels that describe what a session is doing rather than offer somewhere to act.
 *
 * These can be read side by side, and often want to be: what the agent says it is doing and
 * what it has actually changed are the same question asked twice, and checking one against
 * the other meant closing one to see the other.
 *
 * The other two are deliberately not in here. `repository` stages and commits, `environment`
 * turns things on and off; they are places to act rather than things to read, they are much
 * taller, and stacking that kind is what pushed the transcript off the screen (#87).
 */
const SHARE = new Set<Panel>(['changes', 'todos']);

/**
 * Which panels are open, in the order they were opened.
 *
 * Oldest first, so the newest is drawn at the bottom - nearest the composer, which is where
 * somebody who has just opened one is already looking. Opening one that is already open
 * moves it there rather than doing nothing, since asking for it again is asking to look at
 * it.
 *
 * A list rather than one value, and a list rather than a flag each. Three booleans could say
 * that two panels were open when only one may be, which is what this used to get wrong: as
 * three flags it was intended and half-implemented, so `/git` followed by the Changes button
 * showed both (#87). Saying it in one place makes the rule enforceable rather than merely
 * intended, whichever way the rule goes.
 */
export function usePanel(sessionId: string | null) {
  const [open, setOpen] = useState<Panel[]>([]);

  /**
   * A panel describes the session it was opened on, so moving to another closes them all.
   *
   * One rule rather than one effect per panel, which is the other thing three flags cost:
   * a fifth panel would have needed somebody to remember this, and the one that was added
   * last is exactly the one that would be forgotten.
   */
  useEffect(() => setOpen([]), [sessionId]);

  const show = useCallback(
    (panel: Panel) =>
      setOpen((current) =>
        // One that shares keeps the other sharers and goes to the bottom. One that does not
        // takes the whole space, which is the only way it fits.
        SHARE.has(panel) ? [...current.filter((each) => each !== panel && SHARE.has(each)), panel] : [panel],
      ),
    [],
  );

  /** Close one, or all of them when told none. */
  const hide = useCallback(
    (panel?: Panel) => setOpen((current) => (panel ? current.filter((each) => each !== panel) : [])),
    [],
  );

  const showing = useCallback((panel: Panel) => open.includes(panel), [open]);

  return { open, showing, show, hide };
}
