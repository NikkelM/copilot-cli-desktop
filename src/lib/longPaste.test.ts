import { describe, expect, it } from 'vitest';

import {
  COLLAPSE_OVER_LINES,
  countLines,
  humanSize,
  placeholder,
  reference,
  restore,
  worthCollapsing,
  worthWriting,
} from './longPaste';

const lines = (count: number) => Array.from({ length: count }, (_, at) => `line ${at + 1}`).join('\n');

const held = (entries: [number, string][]) =>
  new Map(entries.map(([id, text]) => [id, { text, lines: countLines(text) }]));

describe('what counts as a long paste', () => {
  // A few lines read perfectly well in the box, and hiding them takes something for nothing.
  it('leaves a short paste alone', () => {
    expect(worthCollapsing(lines(COLLAPSE_OVER_LINES))).toBe(false);
  });

  it('collapses one line past that', () => {
    expect(worthCollapsing(lines(COLLAPSE_OVER_LINES + 1))).toBe(true);
  });

  it('counts a single line as one', () => {
    expect(countLines('just this')).toBe(1);
  });

  // A trailing newline is a line somebody can put a cursor on.
  it('counts the line a trailing newline opens', () => {
    expect(countLines('one\n')).toBe(2);
  });
});

describe('what belongs in a file', () => {
  it('leaves an ordinary paste as a message', () => {
    expect(worthWriting('x'.repeat(1000))).toBe(false);
  });

  it('writes down one too large to be a message', () => {
    expect(worthWriting('x'.repeat(300 * 1024))).toBe(true);
  });

  /**
   * The bytes it will occupy rather than its length. A threshold about what is being
   * carried has to count what is carried, and a character outside ASCII is more than one
   * byte of it - so a string of them is larger than its length suggests.
   */
  it('measures what it will weigh, not how many characters it has', () => {
    // Three bytes each in UTF-8, so a third as many characters reaches the same size.
    const wide = '✓'.repeat(100 * 1024);

    expect(wide.length).toBeLessThan(256 * 1024);
    expect(worthWriting(wide)).toBe(true);
  });
});

describe('the placeholder that stands in the box', () => {
  it('names the paste and how much of it there is', () => {
    expect(placeholder(3, 420)).toBe('[Paste #3 - 420 lines]');
  });
});

describe('putting the text back', () => {
  it('replaces a placeholder with what it stood for', () => {
    const text = restore('look at [Paste #1 - 2 lines] please', held([[1, 'a\nb']]), 'sent');

    expect(text).toBe('look at a\nb please');
  });

  it('replaces several at once, each with its own', () => {
    const text = restore('[Paste #1 - 1 lines] and [Paste #2 - 1 lines]', held([[1, 'first'], [2, 'second']]), 'sent');

    expect(text).toBe('first and second');
  });

  /**
   * Somebody can type something that looks like a placeholder, and one can outlive the
   * pastes it belonged to. Inventing a paste would be worse than sending the line as
   * written, so an unheld placeholder is left exactly as it is.
   */
  it('leaves a placeholder nothing is holding exactly as it is', () => {
    const text = restore('see [Paste #9 - 3 lines]', held([[1, 'a']]), 'sent');

    expect(text).toBe('see [Paste #9 - 3 lines]');
  });

  // The CLI's own pattern allows one without a count, so ours has to find one too.
  it('finds a placeholder written without a count', () => {
    expect(restore('[Paste #1]', held([[1, 'text']]), 'sent')).toBe('text');
  });

  it('leaves text with no placeholder in it untouched', () => {
    expect(restore('an ordinary message', held([[1, 'a']]), 'sent')).toBe('an ordinary message');
  });

  /**
   * A paste written to a file is named rather than quoted - the point of writing it down
   * was not to send it - but only once the write has landed.
   */
  it('names the file for a paste that was written down', () => {
    const written = new Map([[1, { text: 'a\nb', lines: 2, file: 'C:\\p\\a.txt', size: '300 KB' }]]);

    expect(restore('[Paste #1 - 2 lines]', written, 'sent')).toBe(
      '<pasted_content file="C:\\p\\a.txt" size="300 KB" lines="2" />',
    );
  });

  // Sent before the write landed, which carries what it would have carried anyway.
  it('puts the text back while the file is still being written', () => {
    expect(restore('[Paste #1 - 2 lines]', held([[1, 'a\nb']]), 'sent')).toBe('a\nb');
  });
});

/**
 * What the conversation shows once the message has gone (#55).
 *
 * Held text is put back, so the reader sees what was asked rather than a placeholder. A
 * paste written to a file is only named: it went to a file because it was too big to read
 * in a message, and it is no smaller in the conversation.
 */
describe('putting a paste back for the reader', () => {
  it('shows the text of a paste small enough to have been held', () => {
    expect(restore('look at [Paste #1 - 2 lines]', held([[1, 'a\nb']]), 'shown')).toBe('look at a\nb');
  });

  it('names a written paste instead of showing it', () => {
    const big = new Map([[1, { text: '', lines: 9000, file: 'C:\\p\\a.txt', size: '412 KB' }]]);

    expect(restore('[Paste #1 - 9000 lines]', big, 'shown')).toBe(
      '[Saved pasted content to workspace (412 KB) id=1]',
    );
  });

  /**
   * The conversation renders markdown, and an unknown tag is not simply dropped there: it
   * swallows everything after it, so showing the agent's reference would cut the message
   * off at the paste. Measured, not assumed.
   */
  it('shows a written paste as something a renderer cannot swallow', () => {
    const big = new Map([[1, { text: '', lines: 9, file: 'C:\\p\\a.txt', size: '1 KB' }]]);

    const shown = restore('before [Paste #1 - 9 lines] after', big, 'shown');

    expect(shown).not.toContain('<');
    expect(shown).toContain('after');
  });

  it('still shows the text of a paste whose file has not landed yet', () => {
    expect(restore('[Paste #1 - 2 lines]', held([[1, 'a\nb']]), 'shown')).toBe('a\nb');
  });
});

describe('the reference the agent reads', () => {
  it('names the file, its size and how long it is', () => {
    expect(reference('C:\\pastes\\a.txt', '12 KB', 400)).toBe(
      '<pasted_content file="C:\\pastes\\a.txt" size="12 KB" lines="400" />',
    );
  });

  /**
   * The filename comes from the clipboard by way of the filesystem, so it is not ours to
   * assume anything about. A quote in it would end the attribute early and the rest would
   * read as markup.
   */
  it('makes a name safe to put in an attribute', () => {
    const tag = reference('a"b<c>&d.txt', '1 KB', 1);

    expect(tag).toContain('a&quot;b&lt;c&gt;&amp;d.txt');
    // Nothing raw survives to end the attribute early and let the rest read as markup.
    expect(tag.slice('<pasted_content file="'.length, tag.indexOf('" size='))).not.toMatch(/["<>&](?!quot;|lt;|gt;|amp;)/);
  });
});

describe('a size somebody would read', () => {
  it.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [1024 * 1024 * 3, '3.0 MB'],
  ])('reads %i as %s', (bytes, said) => {
    expect(humanSize(bytes)).toBe(said);
  });
});
