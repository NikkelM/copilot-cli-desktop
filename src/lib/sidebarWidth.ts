/**
 * How wide the sidebar is, when a reader has said.
 *
 * Kept as a multiple of `--font-base` rather than as pixels. Dragging is done in pixels and
 * that is what the reader sees, but storing pixels would mean a width chosen at one text
 * scale becomes a different amount of sidebar at another: the list would be cut off after
 * making the text larger, which is the opposite of what asking for larger text meant (#139).
 *
 * The unset case is deliberately not a number. "Never chosen" and "chosen to be exactly the
 * default" differ: the first follows the default if it ever moves, the second does not.
 */

/** Where the width is remembered, beside the app's other choices. */
export const WIDTH_KEY = 'copilot-desktop.sidebarWidth';

/**
 * The default, as a multiple of the base.
 *
 * 18.75 is 300px at the default 16px base, which is the width the app had before this and
 * the one the stylesheet's own comment was written against.
 */
export const DEFAULT_MULTIPLE = 18.75;

/**
 * How far it can be dragged either way.
 *
 * Below about 11 the meta line under a title has no room for a date and a repository, so the
 * rows stop saying which session is which. Above 40 the sidebar is wider than most of what
 * the transcript has to show. A ceiling in vw is applied in the stylesheet as well, since a
 * width that is reasonable on this window may be the whole of a smaller one.
 */
export const NARROWEST = 11;
export const WIDEST = 40;

/** Bring a width inside what is usable, and round off the pixel noise dragging accumulates. */
export function clampWidth(multiple: number): number {
  if (!Number.isFinite(multiple)) return DEFAULT_MULTIPLE;
  return Math.round(Math.min(WIDEST, Math.max(NARROWEST, multiple)) * 100) / 100;
}

/** The width remembered from last time, or null when none was ever chosen. */
export function readWidth(store: Pick<Storage, 'getItem'> = localStorage): number | null {
  const saved = store.getItem(WIDTH_KEY);
  if (saved === null) return null;

  const parsed = Number(saved);
  return Number.isFinite(parsed) ? clampWidth(parsed) : null;
}

/**
 * Put a width into effect, or hand the column back to the stylesheet.
 *
 * Set on the document element for the same reason the scale is: it is the one place a custom
 * property can be overridden from without a rebuild. It writes the column rather than the
 * multiple, because an inline style is what outranks the stylesheet's own default.
 */
export function applyWidth(multiple: number | null, root: HTMLElement = document.documentElement): void {
  if (multiple === null) root.style.removeProperty('--sidebar-column');
  else root.style.setProperty('--sidebar-column', `calc(var(--font-base) * ${multiple})`);
}

/** Where whether the sidebar is shown at all is remembered. */
export const HIDDEN_KEY = 'copilot-desktop.sidebarHidden';

/** Whether the sidebar was hidden last time. Absent means shown, which is the default. */
export function readHidden(store: Pick<Storage, 'getItem'> = localStorage): boolean {
  return store.getItem(HIDDEN_KEY) === 'true';
}

/**
 * Take the sidebar out of the layout, or put it back.
 *
 * A class on the element rather than a width of zero, because the two are different things
 * to everything else: a hidden sidebar should not be reachable by Tab, and the grip has to
 * stay where it can be found. The width someone chose is left alone, so showing the sidebar
 * again brings back the one they had rather than the default.
 */
export function applyHidden(hidden: boolean, root: HTMLElement = document.documentElement): void {
  root.classList.toggle('sidebar-hidden', hidden);
}