import { beforeEach, describe, expect, it } from 'vitest';

import { PLAIN, broken, matcher, readFindMode, saveFindMode, type FindMode } from './findMode';
import { resetStores } from './store';

/**
 * How the words are matched, as the three toggles a reader knows from everywhere else.
 *
 * One matcher serves both the row search and the word marks, so what is counted and what is
 * painted cannot disagree about what a match is.
 */
describe('how the words are matched', () => {
  const on = (over: Partial<FindMode>) => ({ ...PLAIN, ...over });

  it('ignores case unless asked not to', () => {
    const re = matcher('Fox', PLAIN)!;

    expect(re.test('a fox')).toBe(true);
  });

  it('minds it when it is', () => {
    expect(matcher('Fox', on({ matchCase: true }))!.test('a fox')).toBe(false);
    expect(matcher('Fox', on({ matchCase: true }))!.test('a Fox')).toBe(true);
  });

  it('matches inside a word unless whole words were asked for', () => {
    expect(matcher('fox', PLAIN)!.test('foxglove')).toBe(true);
  });

  it('matches only whole words when they were', () => {
    expect(matcher('fox', on({ wholeWord: true }))!.test('foxglove')).toBe(false);
    expect(matcher('fox', on({ wholeWord: true }))!.test('a fox ran')).toBe(true);
  });

  /** `\bfox|cat\b` would mean a whole `fox` or any word ending in `cat`, which is not the ask. */
  it('bounds the whole pattern rather than each alternative', () => {
    const re = matcher('fox|cat', on({ wholeWord: true, regex: true }))!;

    expect(re.test('a cat sat')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('a scat song'), 'the end of a word is not a whole one').toBe(false);
  });

  it('reads a pattern as letters unless it was told otherwise', () => {
    expect(matcher('f.x', PLAIN)!.test('fox')).toBe(false);
    expect(matcher('f.x', PLAIN)!.test('f.x')).toBe(true);
  });

  it('reads it as a pattern when it was', () => {
    expect(matcher('f.x', on({ regex: true }))!.test('fox')).toBe(true);
  });

  it.each(['', '   '])('is nothing for %s, which is not a search', (query) => {
    expect(matcher(query, PLAIN)).toBeNull();
  });

  /** A half-typed pattern is not a failure worth reporting anywhere but in the box. */
  it('is nothing for a pattern that will not compile', () => {
    expect(matcher('fox(', on({ regex: true }))).toBeNull();
  });

  it('says which of those two it was', () => {
    expect(broken('fox(', on({ regex: true })), 'a pattern nobody can use').toBe(true);
    expect(broken('fox(', PLAIN), 'the same letters, read as letters').toBe(false);
    expect(broken('', on({ regex: true })), 'nothing typed is not a mistake').toBe(false);
  });

  it('is global, so every mention can be walked to', () => {
    expect(matcher('fox', PLAIN)!.global).toBe(true);
  });
});

/** Off unless the reader turned it on, and still on the next time they look. */
describe('remembering how they searched', () => {
  beforeEach(resetStores);

  it('starts with all three off', () => {
    expect(readFindMode()).toEqual(PLAIN);
  });

  it('reads back what was saved', () => {
    saveFindMode({ matchCase: true, wholeWord: false, regex: true });

    expect(readFindMode()).toEqual({ matchCase: true, wholeWord: false, regex: true });
  });

  it('turns one back off again', () => {
    saveFindMode({ matchCase: true, wholeWord: true, regex: true });
    saveFindMode({ matchCase: false, wholeWord: true, regex: true });

    expect(readFindMode().matchCase).toBe(false);
  });
});
