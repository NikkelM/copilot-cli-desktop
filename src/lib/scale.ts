import { read } from './store';

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

/** What the app scale is called in the settings the app keeps. */
export const SCALE_KEY = 'scale';

/** And the text size, which is a scale of its own on top of that. */
export const TEXT_SCALE_KEY = 'textScale';

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
export function readScale(): number {
  const saved = read('settings', SCALE_KEY);
  return saved === null ? 1 : clampScale(Number(saved));
}

/** The scale remembered for the text, on top of the app's own. */
export function readTextScale(): number {
  const saved = read('settings', TEXT_SCALE_KEY);
  return saved === null ? 1 : clampScale(Number(saved));
}

/**
 * Put both scales into effect.
 *
 * Set on the document element rather than written into the stylesheet, because that is the
 * one place a custom property can be overridden from without a rebuild - and every size in
 * the app is already a ratio of one of these, so nothing else has to be told.
 *
 * Two units rather than one. The app scale moves everything, including the panes, the lanes
 * and the controls; the text scale moves only the letters, on top of it. Somebody who finds
 * the text small is usually asking for the second rather than the first.
 */
export function applyScale(
  scale: number,
  textScale = 1,
  root: HTMLElement = document.documentElement,
): void {
  root.style.setProperty('--font-base', `${BASE_PX * scale}px`);
  root.style.setProperty('--font-text', `${BASE_PX * scale * textScale}px`);
}
