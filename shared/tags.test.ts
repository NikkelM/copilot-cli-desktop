import { describe, expect, it } from 'vitest';

import { tagSlug } from './tags.js';

/**
 * The one spelling of a tag, for sessions and for wiki pages alike (#35).
 *
 * Both halves of the app ask the same question - is this the same word as that one - and
 * they have to answer identically, or a session tagged `Timeless Manor` never finds a page
 * tagged `timeless-manor`.
 */
describe('how a tag is spelled', () => {
  it('lowercases it, so one word is not two', () => {
    expect(tagSlug('Bug')).toBe('bug');
    expect(tagSlug('HADES')).toBe('hades');
  });

  it('writes a space as a dash, which is what a wiki writes', () => {
    expect(tagSlug('needs review')).toBe('needs-review');
    expect(tagSlug('Timeless Manor')).toBe('timeless-manor');
  });

  it('writes a run of anything as one dash', () => {
    expect(tagSlug('needs   review')).toBe('needs-review');
    expect(tagSlug('needs - review')).toBe('needs-review');
    expect(tagSlug('needs_review')).toBe('needs-review');
  });

  it('leaves one already written that way alone', () => {
    expect(tagSlug('needs-review')).toBe('needs-review');
    expect(tagSlug('hades-ii')).toBe('hades-ii');
  });

  /** A tag written three ways before now is one tag from here on. */
  it('settles the spellings of one word on the same answer', () => {
    const spellings = ['Timeless Manor', 'timeless manor', 'TIMELESS-MANOR', 'Timeless  Manor'];

    expect(new Set(spellings.map(tagSlug)).size).toBe(1);
  });

  it('trims what would otherwise be a dash at either end', () => {
    expect(tagSlug('  bug  ')).toBe('bug');
    expect(tagSlug('-bug-')).toBe('bug');
    expect(tagSlug('!bug!')).toBe('bug');
  });

  it('keeps digits, which plenty of tags are mostly made of', () => {
    expect(tagSlug('Hades II')).toBe('hades-ii');
    expect(tagSlug('2026 review')).toBe('2026-review');
  });

  /** Empty is how a caller tells a tag from a keypress. */
  it('comes back empty for a string with no word in it', () => {
    expect(tagSlug('')).toBe('');
    expect(tagSlug('   ')).toBe('');
    expect(tagSlug('---')).toBe('');
    expect(tagSlug('!!!')).toBe('');
  });

  it('is settled by one pass, so storing what it returns changes nothing', () => {
    for (const tag of ['Needs Review', 'hades ii', '  spaced  out  ']) {
      expect(tagSlug(tagSlug(tag))).toBe(tagSlug(tag));
    }
  });
});
