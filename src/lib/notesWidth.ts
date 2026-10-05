/**
 * How wide the notes column is, when a reader has said (#35).
 *
 * Kept as a multiple of `--font-base` for the reason the sidebar's width is: dragging is in
 * pixels and that is what the reader sees, but storing pixels would make a width chosen at
 * one text scale a different amount of column at another.
 *
 * Its own value rather than the sidebar's. They are read at the same time and against each
 * other, and the width that suits a list of session titles is not the width that suits a
 * page of prose.
 */

import { read } from './store';

/** What the width is called in the settings the app keeps. */
export const NOTES_WIDTH_KEY = 'notesWidth';

/**
 * The default, as a multiple of the base.
 *
 * 34 is 544px at the default 16px base. Measured against the wiki here that holds about
 * seventy characters a line, which is where prose is comfortable, and it is wide enough for
 * the tables and fenced blocks the pages are full of. 400px was narrower than those need.
 */
export const DEFAULT_NOTES_MULTIPLE = 34;

/**
 * How far it can be dragged either way.
 *
 * Below about 15 a line of prose breaks every four or five words and a table cannot be read
 * at all. The upper end is not really this number: what actually stops the column is the
 * window, since the session keeps a fifth of it and the sidebar has already taken its
 * share. This is only here so a stored value cannot be absurd.
 */
export const NARROWEST_NOTES = 15;
export const WIDEST_NOTES = 120;

/**
 * The share of the window the session keeps, whatever the two side columns are doing.
 *
 * Matched by `.app.with-notes`, which subtracts the sidebar from this to size the column.
 * A fifth is enough for a transcript to still be read rather than merely be present.
 */
export const SESSION_SHARE = 0.2;

/** Bring a width inside what is usable, and round off the pixel noise dragging accumulates. */
export function clampNotesWidth(multiple: number, most: number = WIDEST_NOTES): number {
  if (!Number.isFinite(multiple)) return DEFAULT_NOTES_MULTIPLE;
  const ceiling = Math.min(WIDEST_NOTES, Number.isFinite(most) ? most : WIDEST_NOTES);
  // The floor wins over the ceiling: a column too narrow to read is worse than one that
  // leaves the session a little less than its share on a very small window.
  return Math.round(Math.max(NARROWEST_NOTES, Math.min(ceiling, multiple)) * 100) / 100;
}

/**
 * The most this column may take right now, in multiples of the base.
 *
 * The window, less the share the session keeps, less whatever the sidebar is using. Read
 * from the sidebar as drawn rather than from its setting, which is null until somebody has
 * dragged it and does not account for its own ceiling.
 */
export function roomForNotes(base: number, root: Document = document): number {
  const sidebar = root.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0;
  return (window.innerWidth * (1 - SESSION_SHARE) - sidebar) / base;
}

/** The width remembered from last time, or null when none was ever chosen. */
export function readNotesWidth(): number | null {
  const saved = read('settings', NOTES_WIDTH_KEY);
  if (saved === null) return null;

  const parsed = Number(saved);
  return Number.isFinite(parsed) ? clampNotesWidth(parsed) : null;
}

/**
 * Put a width into effect, or hand the column back to the stylesheet.
 *
 * Set on the document element for the same reason the scale is: it is the one place a custom
 * property can be overridden from without a rebuild.
 */
export function applyNotesWidth(multiple: number | null, root: HTMLElement = document.documentElement): void {
  if (multiple === null) root.style.removeProperty('--notes-column');
  else root.style.setProperty('--notes-column', `calc(var(--font-base) * ${multiple})`);
}
