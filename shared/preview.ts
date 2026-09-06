/** How much of the last message to keep for the sidebar preview. */
export const PREVIEW_LENGTH = 160;

/**
 * Reduce markdown to the words it is made of.
 *
 * A preview has two lines, and the syntax is the least useful thing that could fill them:
 * a preview beginning `## ` says nothing about which session it belongs to. This is a
 * display transform rather than a parser - it is wrong on constructions nobody writes in
 * a chat message, and it is careful about the ones people do write by accident.
 */
export function toPlainText(markdown: string): string {
  return (
    markdown
      // Fence lines go; the code between them is still words worth previewing.
      .replace(/^[ \t]*(?:```|~~~).*$/gm, '')
      // Images before links: the syntax differs by one character, and the alt text is
      // the only part of an image that can be read.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      // A footnote marker is a number with nothing to point at once the reply is a line.
      .replace(/\[\^[^\]]+\]/g, '')
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
      .replace(/^[ \t]*\|/gm, ' ')
      .replace(/`+([^`]+)`+/g, '$1')
      // Emphasis has to leave alone the asterisks and underscores people write for other
      // reasons: `2 * 3 * 4` is arithmetic, and `snake_case_name` is a name. Requiring
      // the run to close on a non-space, and underscores to sit outside a word, is what
      // markdown itself asks for and is what keeps both intact.
      .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/\*(?=\S)([^*]*\S)\*/g, '$1')
      .replace(/(^|[^\w\\])_(?=\S)([^_]*\S)_(?!\w)/g, '$1$2')
      // Whatever HTML survived is markup rather than words.
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
  );
}

/**
 * Collapse whitespace and clip, so the sidebar never renders a wall of text.
 *
 * Shared because previews come from two places: the sidecar reads them from the history
 * database, and the frontend derives them from live events for loaded sessions, whose
 * newest turn has not been flushed yet. They must look identical either way.
 */
export function toPreview(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const flat = toPlainText(raw).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
}
