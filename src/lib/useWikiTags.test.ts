// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWikiTags } from './useWikiTags';

const wikiTags = vi.fn();

vi.mock('./sidecar', () => ({
  wikiTags: () => wikiTags(),
}));

beforeEach(() => {
  wikiTags.mockReset().mockResolvedValue([
    { tag: 'dublin', pages: 3 },
    { tag: 'hades-ii', pages: 67 },
  ]);
});

/**
 * The words the wiki is already written in, for the picker that tags a session (#35).
 *
 * Fetched when the picker opens rather than on mount: most sessions are worked in without
 * anybody tagging them, and a walk of the wiki nobody asked for is a walk nobody asked for.
 */
describe('the tags the wiki already uses', () => {
  it('asks nothing until the picker opens', () => {
    const { result } = renderHook(() => useWikiTags(false));

    expect(wikiTags).not.toHaveBeenCalled();
    expect(result.current.tags).toEqual([]);
  });

  it('reads them once it is open', async () => {
    const { result } = renderHook(() => useWikiTags(true));

    await waitFor(() => expect(result.current.tags).toHaveLength(2));
  });

  it('reads them when it opens', async () => {
    const { rerender } = renderHook(({ open }) => useWikiTags(open), { initialProps: { open: false } });
    expect(wikiTags).not.toHaveBeenCalled();

    rerender({ open: true });

    await waitFor(() => expect(wikiTags).toHaveBeenCalledOnce());
  });

  /**
   * A machine with no wiki is the common case rather than a fault, and the picker goes on
   * offering what the sessions themselves use.
   */
  it('offers nothing rather than failing when there is no wiki', async () => {
    wikiTags.mockRejectedValue(new Error('no wiki here'));
    const { result } = renderHook(() => useWikiTags(true));

    await waitFor(() => expect(wikiTags).toHaveBeenCalled());
    expect(result.current.tags).toEqual([]);
  });

  /**
   * What to offer and what to stop offering are one question, answered here.
   *
   * Left to whoever draws them it was a filter nothing could test, and getting it wrong
   * showed as nothing worse than an unused variable.
   */
  describe('a word that was refused', () => {
    it('stops being offered', async () => {
      const { result } = renderHook(() => useWikiTags(true));
      await waitFor(() => expect(result.current.tags).toHaveLength(2));

      act(() => result.current.dismiss('hades-ii'));

      expect(result.current.tags.map(({ tag }) => tag)).toEqual(['dublin']);
    });

    it('takes none of the others with it', async () => {
      const { result } = renderHook(() => useWikiTags(true));
      await waitFor(() => expect(result.current.tags).toHaveLength(2));

      act(() => result.current.dismiss('dublin'));

      expect(result.current.tags.map(({ tag }) => tag)).toEqual(['hades-ii']);
    });

    /** Refusing is a decision, and one that lasted a single sitting would be made weekly. */
    it('is still refused the next time the picker opens', async () => {
      const first = renderHook(() => useWikiTags(true));
      await waitFor(() => expect(first.result.current.tags).toHaveLength(2));
      act(() => first.result.current.dismiss('hades-ii'));

      const second = renderHook(() => useWikiTags(true));

      await waitFor(() => expect(second.result.current.tags.map(({ tag }) => tag)).toEqual(['dublin']));
    });
  });
});
