/**
 * Moving the keyboard along a list of controls (#249).
 *
 * Four lists in this app want the same thing and each would otherwise grow its own copy of
 * it. The sidebar and `Menu` already have theirs, and both are tangled up in what else those
 * two do - a roving tab stop in one, a chosen row in the other - so this is the plain version
 * for the lists that only need to be walked.
 *
 * Works from what is on screen rather than from an index held in state: a list whose rows
 * arrive, finish or are taken away while somebody is reading it would otherwise be walked by
 * a number that no longer means what it did.
 */

/** Everything of a kind inside a box that the keyboard can actually reach. */
export function within(box: HTMLElement | null, selector: string): HTMLElement[] {
  return [...(box?.querySelectorAll<HTMLElement>(selector) ?? [])].filter(
    (node) => !node.hasAttribute('disabled') && node.tabIndex !== -1,
  );
}

/**
 * Move the keyboard along a list by one, or to either end.
 *
 * Wrapping, as every list in this app does: a list short enough to be walked is quicker to
 * reach round the end than back through the middle.
 *
 * @returns whether there was anywhere to go, so a caller can leave the key alone when there
 *   was not - swallowing a press that did nothing makes a key look broken rather than spent.
 */
export function step(box: HTMLElement | null, selector: string, by: 1 | -1 | 'first' | 'last'): boolean {
  const all = within(box, selector);
  if (all.length === 0) return false;

  if (by === 'first' || by === 'last') {
    all[by === 'first' ? 0 : all.length - 1]!.focus();
    return true;
  }

  const from = all.findIndex((node) => node === document.activeElement);
  // Nowhere in the list yet, so the end being headed away from is where this starts.
  const at = from === -1 ? (by === 1 ? -1 : 0) : from;
  all[(at + by + all.length) % all.length]!.focus();
  return true;
}

/**
 * Move between the rows of a list whose rows hold several controls each.
 *
 * Up and down are about the message or the task rather than about the buttons on it, so they
 * land on the first control of the row they reach. Left and right along one row are the plain
 * `step` above, given that row alone to work in.
 *
 * Rows are taken as they are drawn rather than filtered for reachability: a row is a place
 * rather than a control, and an `li` is not focusable by nature.
 */
export function stepRows(box: HTMLElement | null, rows: string, controls: string, by: 1 | -1): boolean {
  const all = [...(box?.querySelectorAll<HTMLElement>(rows) ?? [])];
  if (all.length === 0) return false;

  const here = document.activeElement;
  const from = all.findIndex((row) => row === here || row.contains(here));
  const at = from === -1 ? (by === 1 ? -1 : 0) : from;
  const next = all[(at + by + all.length) % all.length];

  const first = within(next ?? null, controls)[0];
  if (!first) return false;

  first.focus();
  return true;
}
