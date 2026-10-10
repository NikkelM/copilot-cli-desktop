import { describe, expect, it } from 'vitest';

import { typedMention, withMention } from './mentions';

/** The caret written as `|`, which is how a test says where it is without counting. */
const at = (written: string) => ({ value: written.replace('|', ''), caret: written.indexOf('|') });

/** The mention under the caret in a piece of text written with `|` for the caret. */
const found = (written: string) => {
  const { value, caret } = at(written);
  return typedMention(value, caret);
};

describe('the mention the caret is in', () => {
  it('is the path after an @ at the start of a message', () => {
    expect(found('@src/App|')).toEqual({ at: 0, path: 'src/App' });
  });

  it('is empty when only the @ has been typed', () => {
    expect(found('look at @|')).toEqual({ at: 8, path: '' });
  });

  it('is nothing when there is no @ at all', () => {
    expect(found('look at this|')).toBeNull();
  });

  /** A space ends one, so two mentions in a sentence are two rather than one long one. */
  it('ends at a space', () => {
    expect(found('@one.ts and @two|')).toEqual({ at: 12, path: 'two' });
  });

  it('is nothing once the mention has been finished and left', () => {
    expect(found('@src/App.tsx is broken|')).toBeNull();
  });

  /** An email address, a handle, the middle of a word: none of them wants a file menu. */
  it('is nothing when the @ has a word in front of it', () => {
    expect(found('someone@example|')).toBeNull();
  });

  it.each([' ', '(', '[', '"', ','])('is a mention when the @ follows %s', (before) => {
    expect(found(`x${before}@src|`)).toEqual({ at: 2, path: 'src' });
  });

  /** A path written inside brackets should not swallow what encloses it. */
  it.each(['"', ')', ']'])('does not reach back past %s', (character) => {
    expect(found(`@one${character}two|`)).toBeNull();
  });

  /** What matters is the word being written now, not one finished earlier. */
  it('reads back from the caret rather than from the end', () => {
    const { value } = at('@one.ts and more');

    expect(typedMention(value, 4)).toEqual({ at: 0, path: 'one' });
  });

  it('takes only what is before the caret', () => {
    const { value, caret } = at('@src/Ap|p.tsx');

    expect(typedMention(value, caret)).toEqual({ at: 0, path: 'src/Ap' });
  });

  it.each([-5, 500])('survives a caret at %s, which is nowhere in the text', (caret) => {
    expect(() => typedMention('@src', caret)).not.toThrow();
  });
});

describe('putting a path into the message', () => {
  const put = (written: string, path: string, finished?: boolean) => {
    const { value, caret } = at(written);
    return withMention(value, typedMention(value, caret)!, path, caret, finished);
  };

  /**
   * The marker is how this app was asked for the menu, not something the agent reads. A
   * message carrying `@../Music/readme.txt` was answered by looking on the wrong drive,
   * because what arrived was a token to guess at rather than a path to resolve.
   */
  it('leaves a plain path behind, with no marker', () => {
    expect(put('look at @src/Ap|', 'src/App.tsx').value).toBe('look at src/App.tsx ');
  });

  it('leaves what was written after it alone', () => {
    expect(put('@src/Ap| and fix it', 'src/App.tsx').value).toBe('src/App.tsx  and fix it');
  });

  it('puts the caret after what it wrote', () => {
    expect(put('look at @src|', 'src/App.tsx').caret).toBe(8 + 'src/App.tsx '.length);
  });

  /** A folder is not finished: the reader is still walking into it. */
  it('adds no space to a folder being walked into', () => {
    expect(put('@sr|', 'src/', false).value).toBe('@src/');
  });

  /**
   * And keeps the marker there, because that half-written state is what the menu reads to
   * know it is still wanted. Strip it and the menu closes on the way into the folder.
   */
  it('leaves a folder still being mentioned', () => {
    const walked = put('@sr|', 'src/', false);

    expect(typedMention(walked.value, walked.caret)).toEqual({ at: 0, path: 'src/' });
  });

  it('leaves a finished file no longer being mentioned', () => {
    const done = put('@sr|', 'src/App.tsx');

    expect(typedMention(done.value, done.caret)).toBeNull();
  });

  it('writes over the whole of what was typed, not only what matched', () => {
    expect(put('@completely-wrong|', 'src/App.tsx').value).toBe('src/App.tsx ');
  });

  /** Named in full where it has to be, which is the caller's decision rather than this one's. */
  it('takes whatever path it is given', () => {
    expect(put('@..|', 'C:\\Users\\me\\Music\\readme.txt').value).toBe('C:\\Users\\me\\Music\\readme.txt ');
  });
});
