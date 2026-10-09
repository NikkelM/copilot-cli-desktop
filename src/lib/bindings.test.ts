import { describe, expect, it } from 'vitest';

import {
  BINDINGS,
  REBINDABLE,
  bind,
  canRebind,
  chordsOf,
  readOverrides,
  refuse,
  refused,
  resolveBindings,
  writeOverrides,
  type Overrides,
} from './bindings';
import { parseChord } from './chords';

/** The chord a test means, written the way a reader would. */
const chord = (text: string) => parseChord(text)!;

describe('which keys can be changed', () => {
  it('is every key the app itself implements', () => {
    for (const binding of BINDINGS) {
      if (binding.id === undefined) continue;
      expect(canRebind(binding) || binding.id === 'escape-twice', `${binding.keys} (${binding.id})`).toBe(true);
    }
  });

  /**
   * A press repeated is not a press with modifiers, so there is nothing to record. Listed
   * here so the day it becomes rebindable is a day this test is changed on purpose.
   */
  it('is not esc esc, which is not a chord at all', () => {
    expect(REBINDABLE.some((binding) => binding.id === 'escape-twice')).toBe(false);
  });

  it('is not the keys readline provides, which this app only passes through', () => {
    const keys = REBINDABLE.map((binding) => binding.keys);

    expect(keys).not.toContain('ctrl+u');
    expect(keys).not.toContain('up/down');
    expect(keys).not.toContain('ctrl+wheel');
  });

  it('includes the two the composer owns, which a reader cannot tell apart from the rest', () => {
    const ids = REBINDABLE.map((binding) => binding.id);

    expect(ids).toContain('cycle-mode');
    expect(ids).toContain('attach');
  });
});

describe('what a reader changed', () => {
  it('survives being written down and read back', () => {
    const changed: Overrides = { sidebar: 'ctrl+shift+b', wiki: '' };

    expect(readOverrides(writeOverrides(changed))).toEqual(changed);
  });

  it('is nothing when there is nothing stored', () => {
    expect(readOverrides('')).toEqual({});
  });

  it.each(['not json at all', '[]', '"a string"', 'null'])('is nothing when the file holds %s', (stored) => {
    expect(readOverrides(stored)).toEqual({});
  });

  /**
   * One bad entry should cost that one shortcut its change, not the whole set. A key from a
   * later version lands here too, and leaving it out is how it stays harmless.
   */
  it('drops what it cannot make sense of and keeps the rest', () => {
    const stored = JSON.stringify({ sidebar: 'ctrl+shift+b', wiki: 'ctrl+wheel', 'from-the-future': 'ctrl+j', help: 7 });

    expect(readOverrides(stored)).toEqual({ sidebar: 'ctrl+shift+b' });
  });

  /** Cleared on purpose is not the same as never changed, so the empty string is kept. */
  it('keeps a key that was cleared', () => {
    expect(readOverrides(JSON.stringify({ wiki: '' }))).toEqual({ wiki: '' });
  });

  it('will not take a change for a key that cannot be changed', () => {
    expect(readOverrides(JSON.stringify({ 'escape-twice': 'ctrl+q' }))).toEqual({});
  });
});

describe('the bindings as they actually are', () => {
  it('shows what was changed rather than what it was', () => {
    const shown = resolveBindings({ sidebar: 'ctrl+shift+b' });

    expect(shown.find((binding) => binding.id === 'sidebar')?.keys).toBe('ctrl+shift+b');
  });

  it('leaves the rest alone', () => {
    const shown = resolveBindings({ sidebar: 'ctrl+shift+b' });

    expect(shown.find((binding) => binding.id === 'wiki')?.keys).toBe('ctrl+shift+k');
    expect(shown).toHaveLength(BINDINGS.length);
  });

  /** The row stays so the reader can see what the key would do, with nothing against it. */
  it('keeps a cleared key in the list with no keys', () => {
    const shown = resolveBindings({ wiki: '' });

    expect(shown.find((binding) => binding.id === 'wiki')?.keys).toBe('');
  });

  it('gives a cleared key no chord, so nothing answers it', () => {
    expect(chordsOf({ wiki: '' }).has('wiki')).toBe(false);
    expect(chordsOf({}).get('wiki')).toEqual(chord('ctrl+shift+k'));
  });

  it('gives every chord a key that is not cleared', () => {
    expect(chordsOf({}).size).toBe(REBINDABLE.length);
  });
});

describe('refusing a chord that is not free', () => {
  it('allows one nothing else has', () => {
    expect(refuse('sidebar', chord('ctrl+shift+b'), {})).toBeNull();
  });

  it('says what already has it', () => {
    expect(refuse('sidebar', chord('ctrl+shift+k'), {})).toEqual({
      why: 'taken',
      by: expect.objectContaining({ id: 'wiki' }),
    });
  });

  /** Its own chord is not a clash, so saving a row that was not changed is not refused. */
  it('does not count the key being changed', () => {
    expect(refuse('sidebar', chord('ctrl+b'), {})).toBeNull();
  });

  /**
   * The composer hands these to the CLI's readline rather than implementing them, so a
   * clash costs the reader a key with nothing on screen to say where it went.
   */
  it.each(['ctrl+u', 'ctrl+k', 'ctrl+r', 'alt+left'])('refuses %s, which the CLI uses', (keys) => {
    expect(refuse('sidebar', chord(keys), {})).toEqual({ why: 'taken', by: expect.objectContaining({ keys }) });
  });

  /**
   * These fire wherever the keyboard is, so an unmodified one would take a letter away.
   * Shift alone does not count: shift+b types `B` and shift+enter a newline, both of which
   * someone is in the middle of doing when the shortcut would fire.
   */
  it.each(['b', 'shift+b', 'shift+enter', '?'])('refuses %s, which has nothing to stop it being typed', (keys) => {
    expect(refuse('sidebar', chord(keys), {})).toEqual({ why: 'unmodified' });
  });

  it('counts what was changed, not what it started as', () => {
    const changed: Overrides = { wiki: 'ctrl+shift+j' };

    expect(refuse('sidebar', chord('ctrl+shift+k'), changed), 'the wiki no longer has it').toBeNull();
    expect(refuse('sidebar', chord('ctrl+shift+j'), changed), 'but it has this').toEqual({
      why: 'taken',
      by: expect.objectContaining({ id: 'wiki' }),
    });
  });

  it('does not count a key that was cleared', () => {
    expect(refuse('sidebar', chord('ctrl+shift+k'), { wiki: '' })).toBeNull();
  });
});

describe('giving a key a chord', () => {
  it('records it', () => {
    const result = bind('sidebar', chord('ctrl+shift+b'), {});

    expect(refused(result)).toBe(false);
    expect(result).toEqual({ sidebar: 'ctrl+shift+b' });
  });

  it('keeps what else was changed', () => {
    const result = bind('sidebar', chord('ctrl+shift+b'), { wiki: '' });

    expect(result).toEqual({ sidebar: 'ctrl+shift+b', wiki: '' });
  });

  /** The old key is kept, which is the whole point of refusing rather than taking. */
  it('changes nothing when the chord is taken', () => {
    const result = bind('sidebar', chord('ctrl+shift+k'), {});

    expect(refused(result)).toBe(true);
    expect(result).toEqual({ why: 'taken', by: expect.objectContaining({ id: 'wiki' }) });
  });
});
