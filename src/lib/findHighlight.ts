import { matcher, PLAIN, type FindMode } from './findMode';

/**
 * Marking the found words themselves, not only the row holding them (#209).
 *
 * The rows are rendered markdown, which React owns: wrapping matches in elements would mean
 * editing a tree that is about to be rebuilt from its source, and the marks would be lost or
 * duplicated on the next render. These are `Range`s over the text instead, handed to the
 * browser's own highlight registry - nothing in the document changes, so there is nothing
 * for React to undo and nothing to clean up but the registry entry.
 */

/** Every place the words appear under this element, in the order they are read. */
export function rangesIn(root: Node | null, query: string, mode: FindMode = PLAIN): Range[] {
  const wanted = matcher(query, mode);
  if (!root || !wanted) return [];

  const found: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    if (!text) continue;

    // Put back for each text node, since the expression is global and would otherwise carry
    // on from wherever the last node left it.
    wanted.lastIndex = 0;
    for (let hit = wanted.exec(text); hit; hit = wanted.exec(text)) {
      // A pattern that can match nothing at all would never advance, so the walk would
      // never end. Stepping past it is what every `exec` loop has to do.
      if (hit[0] === '') {
        wanted.lastIndex += 1;
        continue;
      }

      const range = document.createRange();
      range.setStart(node, hit.index);
      range.setEnd(node, hit.index + hit[0].length);
      found.push(range);
    }
  }

  return found;
}

/** The two names this app registers its highlights under. */
const ALL = 'find-words';
const HERE = 'find-words-here';

/**
 * What the registry looks like where there is one.
 *
 * Read through a guard rather than assumed: the API is recent, and a webview without it
 * should lose the word marks rather than the find.
 */
interface Highlights {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

function registry(): Highlights | null {
  const api = (CSS as unknown as { highlights?: Highlights }).highlights;
  const Make = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return api && Make ? api : null;
}

/**
 * Mark every mention under `root`, and those inside `current` more strongly.
 *
 * Two registrations rather than one, because the row being walked to has to look different
 * from the others: the reader is being told both where the word is and which one they are on.
 */
export function paintMatches(root: Node | null, current: Element | null, query: string, mode: FindMode = PLAIN): void {
  const api = registry();
  if (!api) return;

  api.delete(ALL);
  api.delete(HERE);

  const ranges = rangesIn(root, query, mode);
  if (ranges.length === 0) return;

  const Make = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  const here = ranges.filter((range) => current?.contains(range.startContainer));
  const rest = ranges.filter((range) => !current?.contains(range.startContainer));

  if (rest.length > 0) api.set(ALL, new Make(...rest));
  if (here.length > 0) api.set(HERE, new Make(...here));
}

/** Take the marks away, for when the find is closed or the words are gone. */
export function clearMatches(): void {
  const api = registry();
  if (!api) return;

  api.delete(ALL);
  api.delete(HERE);
}
