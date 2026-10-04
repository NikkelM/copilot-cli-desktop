// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DISMISSED_WIKI_TAGS, useDismissedWikiTags } from './useDismissedWikiTags';
import { read, save } from './store';

/**
 * Words from the wiki this app should stop offering (#35).
 *
 * A wiki's commonest tags include the ones it is organised by rather than the ones that say
 * what a thing is about - `hades-ii` is on 67 of 117 pages here. Those are not wrong, they
 * are just never the answer, and a list that keeps offering them gets ignored.
 */
describe('refusing a word the wiki uses', () => {
  it('starts with nothing refused', () => {
    expect(renderHook(() => useDismissedWikiTags()).result.current.dismissed).toEqual([]);
  });

  it('holds one that was refused', () => {
    const { result } = renderHook(() => useDismissedWikiTags());

    act(() => result.current.dismiss('hades-ii'));

    expect(result.current.dismissed).toEqual(['hades-ii']);
  });

  /** Refusing is a decision, and a decision that lasted one sitting would be made weekly. */
  it('writes it down, so the next run still knows', () => {
    const { result } = renderHook(() => useDismissedWikiTags());

    act(() => result.current.dismiss('modding'));

    expect(JSON.parse(read('sessions', DISMISSED_WIKI_TAGS) ?? '[]')).toEqual(['modding']);
  });

  it('reads back what was written before', () => {
    save('sessions', DISMISSED_WIKI_TAGS, JSON.stringify(['boons']));

    expect(renderHook(() => useDismissedWikiTags()).result.current.dismissed).toEqual(['boons']);
  });

  it('gathers several', () => {
    const { result } = renderHook(() => useDismissedWikiTags());

    act(() => result.current.dismiss('one'));
    act(() => result.current.dismiss('two'));

    expect(result.current.dismissed).toEqual(['one', 'two']);
  });

  it('refuses the same word once', () => {
    const { result } = renderHook(() => useDismissedWikiTags());

    act(() => result.current.dismiss('hades-ii'));
    act(() => result.current.dismiss('hades-ii'));

    expect(result.current.dismissed).toEqual(['hades-ii']);
  });

  /** The same word written differently is the same word, as everywhere else tags are read. */
  it('reads a word however it was written', () => {
    const { result } = renderHook(() => useDismissedWikiTags());

    act(() => result.current.dismiss('  Hades-II  '));

    expect(result.current.dismissed).toEqual(['hades-ii']);
  });

  it('refuses nothing for an empty word', () => {
    const { result } = renderHook(() => useDismissedWikiTags());

    act(() => result.current.dismiss('   '));

    expect(result.current.dismissed).toEqual([]);
  });

  /**
   * A store that cannot be read is one nobody can fix from here, and offering every
   * suggestion is a smaller failure than offering none.
   */
  it('offers everything again rather than nothing when the record is unreadable', () => {
    save('sessions', DISMISSED_WIKI_TAGS, 'not json at all');

    expect(renderHook(() => useDismissedWikiTags()).result.current.dismissed).toEqual([]);
  });

  it('ignores a record holding something other than a list', () => {
    save('sessions', DISMISSED_WIKI_TAGS, JSON.stringify({ hades: true }));

    expect(renderHook(() => useDismissedWikiTags()).result.current.dismissed).toEqual([]);
  });
});
