// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { save } from './store';

const { existingSessions } = vi.hoisted(() => ({ existingSessions: vi.fn() }));
vi.mock('./sidecar', () => ({ existingSessions: (ids: string[]) => existingSessions(ids) }));

const KEY = 'favourites';

/** The module remembers that it has pruned, which is per install rather than per hook. */
async function load() {
  vi.resetModules();
  return import('./useFavourites');
}

beforeEach(() => {
  localStorage.clear();
  existingSessions.mockReset().mockImplementation((ids: string[]) => Promise.resolve(ids));
});

describe('the sessions someone has favourited', () => {
  it('starts with none', async () => {
    const { useFavourites } = await load();

    const { result } = renderHook(() => useFavourites());

    expect(result.current.favourites).toEqual([]);
  });

  it('remembers one', async () => {
    const { useFavourites } = await load();
    const { result } = renderHook(() => useFavourites());

    act(() => result.current.toggle('a'));

    expect(result.current.favourites).toEqual(['a']);
  });

  it('takes one back off', async () => {
    const { useFavourites } = await load();
    const { result } = renderHook(() => useFavourites());
    act(() => result.current.toggle('a'));

    act(() => result.current.toggle('a'));

    expect(result.current.favourites).toEqual([]);
  });

  it('survives a restart', async () => {
    const first = await load();
    const one = renderHook(() => first.useFavourites());
    act(() => one.result.current.toggle('a'));
    one.unmount();

    const again = await load();
    const { result } = renderHook(() => again.useFavourites());

    expect(result.current.favourites).toEqual(['a']);
  });

  // Anything could be in there, including something another version of the app wrote.
  it('ignores stored rubbish', async () => {
    save('sessions', KEY, 'not json');
    const { useFavourites } = await load();

    const { result } = renderHook(() => useFavourites());

    expect(result.current.favourites).toEqual([]);
  });

  it('ignores entries that are not ids', async () => {
    save('sessions', KEY, JSON.stringify(['a', 7, null]));
    const { useFavourites } = await load();

    const { result } = renderHook(() => useFavourites());

    expect(result.current.favourites).toEqual(['a']);
  });

  /**
   * Nothing else removes an entry, so without this the list grows for the life of the
   * install and keeps state about sessions that are gone (#152).
   */
  it('drops a session that no longer exists', async () => {
    save('sessions', KEY, JSON.stringify(['gone', 'here']));
    existingSessions.mockResolvedValue(['here']);
    const { useFavourites } = await load();

    const { result } = renderHook(() => useFavourites());

    await waitFor(() => expect(result.current.favourites).toEqual(['here']));
  });

  it('asks about the ones it holds, and only those', async () => {
    save('sessions', KEY, JSON.stringify(['a', 'b']));
    const { useFavourites } = await load();

    renderHook(() => useFavourites());

    await waitFor(() => expect(existingSessions).toHaveBeenCalledWith(['a', 'b']));
  });

  it('asks nothing when it holds nothing', async () => {
    const { useFavourites } = await load();

    renderHook(() => useFavourites());

    await waitFor(() => expect(existingSessions).not.toHaveBeenCalled());
  });

  /** Absence from the sidebar is deliberately not the test; only what is on disk is. */
  it('keeps one that is merely not on screen', async () => {
    save('sessions', KEY, JSON.stringify(['quiet']));
    const { useFavourites } = await load();

    const { result } = renderHook(() => useFavourites());

    await waitFor(() => expect(existingSessions).toHaveBeenCalled());
    expect(result.current.favourites).toEqual(['quiet']);
  });

  // The reader may favourite something while the sidecar is still answering, and that is newer.
  it('keeps a new favourite while the prune was in flight', async () => {
    save('sessions', KEY, JSON.stringify(['gone']));
    let answer: (ids: string[]) => void = () => {};
    existingSessions.mockReturnValue(new Promise<string[]>((resolve) => (answer = resolve)));
    const { useFavourites } = await load();
    const { result } = renderHook(() => useFavourites());

    act(() => result.current.toggle('fresh'));
    await act(async () => answer([]));

    expect(result.current.favourites).toContain('fresh');
  });

  it('prunes once for the install rather than once per hook', async () => {
    save('sessions', KEY, JSON.stringify(['a']));
    const { useFavourites } = await load();

    renderHook(() => useFavourites());
    await waitFor(() => expect(existingSessions).toHaveBeenCalledTimes(1));
    renderHook(() => useFavourites());

    expect(existingSessions).toHaveBeenCalledTimes(1);
  });
});
