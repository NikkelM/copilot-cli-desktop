// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWikiNotes } from './useWikiNotes';
import type { WikiPage } from '../../shared/protocol';

const wikiForSession = vi.fn();

vi.mock('./sidecar', () => ({
  wikiForSession: (repository: string | null, cwd: string | null, tags: string[]) =>
    wikiForSession(repository, cwd, tags),
}));

const page = (path: string): WikiPage => ({ path, title: path });

beforeEach(() => {
  wikiForSession.mockReset().mockResolvedValue({ name: 'my-repo', pages: [page('a.md')] });
});

/**
 * The notes the open session's subject already has (#35).
 *
 * Asked once per session rather than per sidebar row, and again when its tags change -
 * tagging a session is how somebody says what it is about, and a count that ignored that
 * would answer a question nobody is asking any more.
 */
describe('the notes on a session', () => {
  it('asks what the open session already has written down', async () => {
    const { result } = renderHook(() => useWikiNotes('NikkelM/my-repo', 'C:\\repos\\my-repo', ['unity']));

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(wikiForSession).toHaveBeenCalledWith('NikkelM/my-repo', 'C:\\repos\\my-repo', ['unity']);
  });

  it('asks nothing of a session with no repository, directory or tags', () => {
    const { result } = renderHook(() => useWikiNotes(null, null, []));

    expect(wikiForSession).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  /** A session in a parent folder has no repository worth the name, and tags are all it has. */
  it('still asks for a session that has only tags', async () => {
    renderHook(() => useWikiNotes(null, null, ['ireland']));

    await waitFor(() => expect(wikiForSession).toHaveBeenCalledWith(null, null, ['ireland']));
  });

  it('asks again when the session changes', async () => {
    const { rerender } = renderHook(({ cwd }) => useWikiNotes(null, cwd, []), {
      initialProps: { cwd: 'C:\\repos\\one' },
    });
    await waitFor(() => expect(wikiForSession).toHaveBeenCalledTimes(1));

    rerender({ cwd: 'C:\\repos\\two' });

    await waitFor(() => expect(wikiForSession).toHaveBeenCalledTimes(2));
  });

  it('asks again when the session is tagged', async () => {
    const { rerender } = renderHook(({ tags }) => useWikiNotes(null, 'C:\\repos\\one', tags), {
      initialProps: { tags: ['unity'] },
    });
    await waitFor(() => expect(wikiForSession).toHaveBeenCalledTimes(1));

    rerender({ tags: ['unity', 'game'] });

    await waitFor(() => expect(wikiForSession).toHaveBeenCalledTimes(2));
  });

  /**
   * Whatever holds the tags rebuilds the array on every render, so depending on its identity
   * would ask the sidecar on every keystroke anywhere in the app.
   */
  it('does not ask again for the same tags in a new array', async () => {
    const { rerender } = renderHook(({ tags }) => useWikiNotes(null, 'C:\\repos\\one', tags), {
      initialProps: { tags: ['unity'] },
    });
    await waitFor(() => expect(wikiForSession).toHaveBeenCalledTimes(1));

    rerender({ tags: ['unity'] });
    rerender({ tags: ['unity'] });

    expect(wikiForSession).toHaveBeenCalledTimes(1);
  });

  /** The same tags in another order are the same tags. */
  it('does not ask again when the tags are merely reordered', async () => {
    const { rerender } = renderHook(({ tags }) => useWikiNotes(null, 'C:\\repos\\one', tags), {
      initialProps: { tags: ['unity', 'game'] },
    });
    await waitFor(() => expect(wikiForSession).toHaveBeenCalledTimes(1));

    rerender({ tags: ['game', 'unity'] });

    expect(wikiForSession).toHaveBeenCalledTimes(1);
  });

  /**
   * A machine with no wiki is the common case rather than a fault, and a header that cannot
   * say how many notes there are should say nothing at all.
   */
  it('says nothing rather than failing when the wiki cannot be read', async () => {
    wikiForSession.mockRejectedValue(new Error('no wiki here'));
    const { result } = renderHook(() => useWikiNotes(null, 'C:\\repos\\one', []));

    await waitFor(() => expect(wikiForSession).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  /** An answer landing after the reader has moved on would describe the session they left. */
  it('ignores an answer that arrives after the session changed', async () => {
    let settle: ((value: { name: string | null; pages: WikiPage[] }) => void) | undefined;
    wikiForSession.mockReturnValueOnce(
      new Promise<{ name: string | null; pages: WikiPage[] }>((resolve) => {
        settle = resolve;
      }),
    );

    const { result, rerender } = renderHook(({ cwd }) => useWikiNotes(null, cwd, []), {
      initialProps: { cwd: 'C:\\repos\\one' },
    });

    wikiForSession.mockResolvedValue({ name: 'two', pages: [page('two.md')] });
    rerender({ cwd: 'C:\\repos\\two' });
    await waitFor(() => expect(result.current.map((p) => p.path)).toEqual(['two.md']));

    // The first session's answer, arriving late. Flushed before asserting: without this the
    // check runs before the promise callback and passes whether or not it is guarded.
    await act(async () => {
      settle?.({ name: 'one', pages: [page('one.md'), page('stale.md')] });
      await Promise.resolve();
    });

    expect(result.current.map((p) => p.path)).toEqual(['two.md']);
  });

  it('forgets what it had when the session has nothing to ask about', async () => {
    const { result, rerender } = renderHook(({ cwd }) => useWikiNotes(null, cwd, []), {
      initialProps: { cwd: 'C:\\repos\\one' as string | null },
    });
    await waitFor(() => expect(result.current).toHaveLength(1));

    rerender({ cwd: null });

    await waitFor(() => expect(result.current).toEqual([]));
  });
});
