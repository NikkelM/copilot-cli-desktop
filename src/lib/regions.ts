/**
 * Moving the focus between the parts of the window (#250).
 *
 * Nothing in the app moved focus before this: getting from the composer to the sidebar meant
 * tabbing through everything in between, which is the first thing anyone coming from a
 * terminal notices. Regions are found by a `data-region` attribute rather than by class, so
 * what counts as one is stated where it is drawn instead of guessed at from styling.
 */

/** The regions, in the order a region key walks them - roughly left to right, then down. */
export const REGIONS = ['sidebar', 'transcript', 'panel', 'composer'] as const;

export type Region = (typeof REGIONS)[number];

/**
 * Somewhere focus can be sent.
 *
 * The filter box is one of these without being a region: a key aims straight at it, but
 * walking between regions treats it as part of the sidebar it sits in.
 */
export type Spot = Region | 'sidebar-search';

/**
 * What a region puts the focus on, or null when that region is not on screen.
 *
 * The sidebar aims at the row carrying the tab stop rather than at the list around it, so
 * arriving leaves the arrows ready to move. The filter box stands in when there are no rows
 * to land on, which is also where somebody who came to find a session wants to be.
 */
export function targetOf(region: Spot, root: ParentNode = document): HTMLElement | null {
  if (region === 'sidebar') {
    return (
      root.querySelector<HTMLElement>('[data-region="sidebar"] .session-row[tabindex="0"]') ??
      root.querySelector<HTMLElement>('[data-region="sidebar-search"]')
    );
  }

  return root.querySelector<HTMLElement>(`[data-region="${region}"]`);
}

/** Put the focus in a region, answering whether there was one to go to. */
export function focusRegion(region: Spot, root: ParentNode = document): boolean {
  const target = targetOf(region, root);
  if (!target) return false;

  target.focus();
  return true;
}

/**
 * Which region the focus is in, by asking what it sits inside.
 *
 * The filter box is its own region for the sake of a key that aims at it, but for walking
 * between regions it is part of the sidebar: stepping out of the box should leave the
 * sidebar rather than move to the rows below it.
 */
export function regionOf(node: Element | null): Region | null {
  const held = node?.closest<HTMLElement>('[data-region]');
  const name = held?.dataset.region;
  if (name === 'sidebar-search') return 'sidebar';

  return REGIONS.includes(name as Region) ? (name as Region) : null;
}

/**
 * Move the focus one region on, skipping any that are not on screen.
 *
 * Wraps, because the regions are a ring rather than a row: a panel open on the right is
 * between the transcript and the composer on the way round, and closing it should not strand
 * anybody at the end of a list. Answers whether it found somewhere to go, so a key can be
 * left alone when there is nowhere.
 */
export function stepRegion(by: 1 | -1, root: ParentNode = document): boolean {
  const from = regionOf(root instanceof Document ? root.activeElement : document.activeElement);
  // Nowhere in particular sits just outside the ring, at whichever end the first press is
  // heading away from, so that press lands somewhere rather than doing nothing.
  const at = from !== null ? REGIONS.indexOf(from) : by === 1 ? -1 : REGIONS.length;

  for (let step = 1; step <= REGIONS.length; step += 1) {
    const index = (((at + by * step) % REGIONS.length) + REGIONS.length) % REGIONS.length;
    const next = REGIONS[index];
    if (next && next !== from && focusRegion(next, root)) return true;
  }

  return false;
}
