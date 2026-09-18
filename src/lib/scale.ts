/**
 * How large everything is drawn, as one scale rather than a size per element.
 *
 * The whole app is sized off `--font-base` through a set of ratios, and those ratios are
 * deliberate - letting each size be set separately would only let them be broken (#139). So
 * one number moves all of them.
 *
 * Kept as a multiplier rather than a pixel size. The base is a decision about what the app
 * looks like by default and may change; what a reader chose is "a bit bigger than whatever
 * that is", which survives the default moving under them.
 */

/** Where the scale is remembered, in the same place the app keeps its other choices. */
export const SCALE_KEY = 'copilot-desktop.scale';

/** The base every ratio in the stylesheet is derived from. */
export const BASE_PX = 16;

/**
 * How far it can be taken either way.
 *
 * Below three quarters the smallest ratio lands under 9px, which is not readable at any
 * distance; above twice it, two panes no longer fit side by side on a laptop screen and the
 * app stops being usable in a different way.
 */
export const SMALLEST = 0.75;
export const LARGEST = 2;

/** One press. An eighth is small enough to tune with and large enough to notice. */
export const STEP = 0.125;

/** Bring a scale inside what is usable, and round off the float noise steps accumulate. */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.round(Math.min(LARGEST, Math.max(SMALLEST, scale)) * 1000) / 1000;
}

/** The scale remembered from last time, or 1 when there is none or it is unreadable. */
export function readScale(store: Pick<Storage, 'getItem'> = localStorage): number {
  const saved = store.getItem(SCALE_KEY);
  return saved === null ? 1 : clampScale(Number(saved));
}

/**
 * Put a scale into effect.
 *
 * Set on the document element rather than written into the stylesheet, because that is the
 * one place a custom property can be overridden from without a rebuild - and every size in
 * the app is already a ratio of it, so nothing else has to be told.
 */
export function applyScale(scale: number, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--font-base', `${BASE_PX * scale}px`);
}
