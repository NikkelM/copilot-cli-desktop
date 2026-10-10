// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { clearMatches, paintMatches, rangesIn } from './findHighlight';

let root: HTMLElement;

/** A tree to look through, written as the markup a rendered row would be. */
const given = (html: string) => {
  root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
};

afterEach(() => root?.remove());

/** What each range actually covers, which is the whole of what a mark is. */
const covered = (query: string) => rangesIn(root, query).map((range) => range.toString());

describe('where the words are', () => {
  it('finds one in plain text', () => {
    given('<p>a line that is long</p>');

    expect(covered('long')).toEqual(['long']);
  });

  it('finds every one of them', () => {
    given('<p>long and long again</p>');

    expect(covered('long')).toEqual(['long', 'long']);
  });

  /** The rows are rendered markdown, so the words sit among emphasis, code and links. */
  it('finds them under whatever is wrapped round them', () => {
    given('<p>a <em>long</em> line and <code>longer</code> still</p>');

    expect(covered('long')).toEqual(['long', 'long']);
  });

  it('keeps the case it found, having ignored it while looking', () => {
    given('<p>A Long Line</p>');

    expect(covered('long')).toEqual(['Long']);
  });

  it('finds nothing for words nobody said', () => {
    given('<p>a line</p>');

    expect(covered('elephant')).toEqual([]);
  });

  it.each(['', '   '])('finds nothing for %s, rather than everything', (query) => {
    given('<p>a line</p>');

    expect(covered(query)).toEqual([]);
  });

  it('ignores space around the words, as the count does', () => {
    given('<p>a long line</p>');

    expect(covered('  long  ')).toEqual(['long']);
  });

  /** `aa` in `aaa` is one match followed by a stray letter, not two overlapping ones. */
  it('does not count overlapping starts twice', () => {
    given('<p>aaa</p>');

    expect(covered('aa')).toHaveLength(1);
  });

  it('says nothing about a tree that is not there', () => {
    expect(rangesIn(null, 'long')).toEqual([]);
  });

  /** A range is what the browser is given, so it has to point at the text rather than at it. */
  it('points into the text node itself', () => {
    given('<p>a long line</p>');

    const [range] = rangesIn(root, 'long');

    expect(range?.startContainer.nodeType).toBe(Node.TEXT_NODE);
    expect(range?.startOffset).toBe(2);
    expect(range?.endOffset).toBe(6);
  });

  /** Which row a mark is in decides whether it is the one being walked to. */
  it('leaves each range in the row it was found in', () => {
    given('<ul><li id="one">a long line</li><li id="two">another long one</li></ul>');
    const two = document.getElementById('two')!;

    const inTwo = rangesIn(root, 'long').filter((range) => two.contains(range.startContainer));

    expect(inTwo).toHaveLength(1);
  });
});

/**
 * The registry is recent, and a webview without it should lose the word marks rather than
 * the find. jsdom has neither half of the API, which is what makes this the case under test.
 */
describe('where the browser cannot mark words', () => {
  it('paints nothing rather than failing', () => {
    given('<p>a long line</p>');

    expect(() => paintMatches(root, null, 'long')).not.toThrow();
  });

  it('clears nothing rather than failing', () => {
    expect(() => clearMatches()).not.toThrow();
  });
});
