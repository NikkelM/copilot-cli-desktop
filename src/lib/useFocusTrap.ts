import { useEffect, type RefObject } from 'react';

/**
 * The dialogs currently open, innermost last.
 *
 * Only the innermost answers Tab. The settings window can raise a question about leaving
 * while it is itself open, and two surfaces both trying to keep hold of the keyboard would
 * hand it back and forth rather than contain it.
 */
const open: HTMLElement[] = [];

/**
 * Which open surface the keyboard belongs to.
 *
 * Not simply the last one opened: React runs a child's effects before its parent's, so a
 * dialog raised inside another registers first and the one around it would look like the
 * newer of the two. Containment is what actually settles it - a surface with another open
 * surface inside it is not the innermost, whichever of them registered first. Among surfaces
 * that hold none of the others, the most recent wins, which is what one opened over an
 * unrelated one means.
 */
function topmost(): HTMLElement | undefined {
  const leaves = open.filter((node) => !open.some((other) => other !== node && node.contains(other)));
  return leaves[leaves.length - 1];
}

/** What Tab would stop on, in the order it would reach them. */
const REACHABLE = 'a[href], button, input, select, textarea, [tabindex]';

/**
 * The controls inside a surface that the keyboard can actually get to.
 *
 * Disabled ones are drawn but refused, and the menus here draw refused actions on purpose
 * (#107), so they are not somewhere the keyboard can land. Anything with no box at all is
 * not on screen - a panel folded away still has its buttons in the document.
 */
function reachable(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(REACHABLE)].filter(
    (node) => !node.hasAttribute('disabled') && node.tabIndex !== -1 && node.getClientRects().length > 0,
  );
}

/**
 * Keep the keyboard inside a dialog, and give it back when the dialog goes (#248).
 *
 * Seven surfaces in this app declare `aria-modal="true"`, which tells anything reading the
 * screen that focus is held within them. None of them held it: Tab walked straight out into
 * the page behind, and closing one dropped the keyboard at the top of the document rather
 * than returning it to whatever had been pressed to get here. The declaration was a claim
 * the app did not honour, which is worse than not making it.
 *
 * Escape is left alone. Every one of these already answers it, and a dialog that closes on
 * Escape is a thing readers try first - taking that over here would move a decision that is
 * already made consistently in seven places.
 *
 * @param box the surface itself, not the backdrop behind it: the backdrop is a way of
 *   dismissing the thing by clicking past it, and nothing inside it is reachable.
 * @param on whether the surface is up, for one that is drawn only sometimes. A ref filled in
 *   later does not start an effect by itself, so a dialog raised inside one already open has
 *   to say when it has been.
 */
export function useFocusTrap(box: RefObject<HTMLElement | null>, on: boolean = true): void {
  useEffect(() => {
    const node = on ? box.current : null;
    if (!node) return;

    // Taken before anything inside is focused, which several of these do on opening.
    const was = document.activeElement as HTMLElement | null;
    open.push(node);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !node) return;
      // Something was opened over this one and owns the keyboard until it goes.
      if (topmost() !== node) return;

      const items = reachable(node);
      // Nothing to land on, so the surface itself holds the keyboard rather than letting it
      // leave for the page behind.
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const here = document.activeElement;

      // Outside already, which is where a press that escaped would have landed.
      if (!node.contains(here)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && here === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && here === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // Captured, so a field inside that answers Tab for itself does not get to decide whether
    // the keyboard may leave the dialog.
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      const at = open.indexOf(node);
      if (at !== -1) open.splice(at, 1);

      // Back to whatever opened it. Only if it is still there: an action taken in the dialog
      // can be what removes the control that raised it.
      if (was?.isConnected) was.focus();
    };
  }, [box, on]);
}
