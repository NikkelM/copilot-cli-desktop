import { describe, expect, it } from 'vitest';

import { PREVIEW_LENGTH, toPlainText, toPreview } from './preview.js';

describe('toPreview', () => {
  it('collapses whitespace so multi-line replies stay on one line', () => {
    expect(toPreview('one\n\n  two\tthree ')).toBe('one two three');
  });

  it('clips long text and marks the truncation', () => {
    const preview = toPreview('x'.repeat(500));
    expect(preview).toHaveLength(PREVIEW_LENGTH);
    expect(preview?.endsWith('…')).toBe(true);
  });

  it('treats empty and whitespace-only input as no preview', () => {
    expect(toPreview('')).toBeNull();
    expect(toPreview('   \n ')).toBeNull();
    expect(toPreview(null)).toBeNull();
    expect(toPreview(undefined)).toBeNull();
  });
});

describe('toPlainText', () => {
  const plain = (markdown: string) => toPlainText(markdown).replace(/\s+/g, ' ').trim();

  it('drops emphasis and keeps the words', () => {
    expect(plain('**Recovered:** the `f1ec2c40` session')).toBe('Recovered: the f1ec2c40 session');
    expect(plain('*italic*, _also italic_, ***both***, ~~gone~~')).toBe('italic, also italic, both, gone');
  });

  it('drops heading, quote and list marks', () => {
    expect(plain('## Findings\n\n- first\n- second')).toBe('Findings first second');
    expect(plain('> quoted line')).toBe('quoted line');
    expect(plain('1. one\n2. two')).toBe('one two');
  });

  it('keeps the words of a link and drops its target', () => {
    expect(plain('see [the docs](https://example.com/a_b_c) now')).toBe('see the docs now');
    expect(plain('![a diagram](x.png)')).toBe('a diagram');
    expect(plain('a [reference][ref] link')).toBe('a reference link');
  });

  it('keeps code but not its fences', () => {
    expect(plain('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  /**
   * The traps. Both of these appear in ordinary messages, and a transform that treats
   * every asterisk and underscore as emphasis quietly rewrites what was said.
   */
  it('leaves arithmetic and identifiers alone', () => {
    expect(plain('Asterisks in math: 2 * 3 * 4 = 24')).toBe('Asterisks in math: 2 * 3 * 4 = 24');
    expect(plain('Underscores_inside_words_should_not_be_italic.')).toBe(
      'Underscores_inside_words_should_not_be_italic.',
    );
    expect(plain('call snake_case_name and other_name')).toBe('call snake_case_name and other_name');
  });

  it('leaves an unclosed marker as written', () => {
    expect(plain('a ** b')).toBe('a ** b');
    expect(plain('2 ** 8 is 256')).toBe('2 ** 8 is 256');
  });

  it('strips html that survived', () => {
    expect(plain('<details><summary>More</summary>hidden</details>')).toBe('Morehidden');
  });
});

describe('toPreview with markdown', () => {
  it('previews the words rather than the syntax', () => {
    expect(toPreview('## Done\n\n**Recovered:** `f1ec2c40` is back')).toBe('Done Recovered: f1ec2c40 is back');
  });

  it('still clips to length after stripping', () => {
    const long = `**${'word '.repeat(60)}**`;
    expect(toPreview(long)?.length).toBe(PREVIEW_LENGTH);
  });
});

/**
 * A caller that draws more than two lines says how much it can use.
 *
 * 160 characters is about three lines in a sidebar at its default width, so a reader asking
 * for five lines of the last reply would be given three however wide they dragged it.
 */
describe('toPreview with a limit of its own', () => {
  it('clips at the length it was given rather than the default', () => {
    expect(toPreview('x'.repeat(1000), 500)).toHaveLength(500);
  });

  it('marks it as clipped there too', () => {
    expect(toPreview('x'.repeat(1000), 500)?.endsWith('…')).toBe(true);
  });

  it('leaves a reply shorter than the limit whole', () => {
    expect(toPreview('Short', 500)).toBe('Short');
  });

  it('still clips at 160 for a caller that says nothing', () => {
    expect(toPreview('x'.repeat(1000))).toHaveLength(PREVIEW_LENGTH);
  });

  it('says nothing for an empty reply whatever the limit', () => {
    expect(toPreview('   ', 500)).toBeNull();
  });
});
