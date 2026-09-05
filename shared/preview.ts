/** How much of the last message to keep for the sidebar preview. */
export const PREVIEW_LENGTH = 160;

/**
 * Collapse whitespace and clip, so the sidebar never renders a wall of text.
 *
 * Shared because previews come from two places: the sidecar reads them from the history
 * database, and the frontend derives them from live events for loaded sessions, whose
 * newest turn has not been flushed yet. They must look identical either way.
 */
export function toPreview(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
}
