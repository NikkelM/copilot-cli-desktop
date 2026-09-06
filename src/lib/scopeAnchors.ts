import type { Root, Element } from 'hast';
import { visit } from 'unist-util-visit';

/**
 * Keep one reply's anchors from colliding with another's.
 *
 * Headings get ids from their text, and a transcript is full of replies that use the same
 * headings - Findings, What changed, Worth deciding. Left alone, a link to one would jump
 * to whichever reply happened to be first in the document. Prefixing by message makes each
 * reply's anchors its own.
 */
export function scopeAnchors(prefix: string) {
  return () => (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      const id = node.properties?.id;
      if (typeof id === 'string') node.properties!.id = `${prefix}-${id}`;

      const href = node.properties?.href;
      if (typeof href === 'string' && href.startsWith('#')) {
        node.properties!.href = `#${prefix}-${href.slice(1)}`;
      }
    });
  };
}
