// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { existingSessions } = vi.hoisted(() => ({ existingSessions: vi.fn() }));
vi.mock('./sidecar', () => ({ existingSessions: (ids: string[]) => existingSessions(ids) }));

const ARCHIVED = 'copilot-desktop.archived';
const FAVOURITES = 'copilot-desktop.favourites';

/** The module remembers which sets it has pruned, which is per install rather than per hook. */
async function load() {
  vi.resetModules();
  return {
    ...(await import('./useArchived')),
    ...(await import('./useFavourites')),
  };
}

beforeEach(() => {
  localStorage.clear();
  existingSessions.mockReset().mockImplementation((ids: string[]) => Promise.resolve(ids));
});

describe('the sessions someone has put away', () => {
  it('starts with none', async () => {
    const { useArchived } = await load();

    expect(renderHook(() => useArchived()).result.current.archived).toEqual([]);
  });

  it('puts one away and takes it back', async () => {
    const { useArchived } = await load();
    const { result } = renderHook(() => useArchived());

    act(() => result.current.toggle('s1'));
    expect(result.current.archived).toEqual(['s1']);

    act(() => result.current.toggle('s1'));
    expect(result.current.archived).toEqual([]);
  });

  it('is still put away next time', async () => {
    localStorage.setItem(ARCHIVED, JSON.stringify(['s1']));
    const { useArchived } = await load();

    expect(renderHook(() => useArchived()).result.current.archived).toEqual(['s1']);
  });

  /**
   * The two sets are kept by the same code, so the thing worth proving is that they are
   * still two sets: archiving a session must not also put it among the favourites.
   */
  it('is a separate decision from favouriting', async () => {
    const { useArchived, useFavourites } = await load();
    const archived = renderHook(() => useArchived());
    const favourites = renderHook(() => useFavourites());

    act(() => archived.result.current.toggle('s1'));

    expect(archived.result.current.archived).toEqual(['s1']);
    expect(favourites.result.current.favourites).toEqual([]);
    expect(localStorage.getItem(FAVOURITES)).toBeNull();
  });

  it('can be both, since being kept within reach says nothing about being finished with', async () => {
    const { useArchived, useFavourites } = await load();
    const archived = renderHook(() => useArchived());
    const favourites = renderHook(() => useFavourites());

    act(() => archived.result.current.toggle('s1'));
    act(() => favourites.result.current.toggle('s1'));

    expect(archived.result.current.archived).toEqual(['s1']);
    expect(favourites.result.current.favourites).toEqual(['s1']);
  });

  it('forgets a session that is no longer on disk', async () => {
    localStorage.setItem(ARCHIVED, JSON.stringify(['gone', 'here']));
    existingSessions.mockResolvedValue(['here']);
    const { useArchived } = await load();

    const { result } = renderHook(() => useArchived());

    await waitFor(() => expect(result.current.archived).toEqual(['here']));
  });

  it('prunes its own set rather than the favourites', async () => {
    localStorage.setItem(ARCHIVED, JSON.stringify(['gone']));
    localStorage.setItem(FAVOURITES, JSON.stringify(['gone']));
    existingSessions.mockResolvedValue([]);
    const { useArchived } = await load();

    const { result } = renderHook(() => useArchived());

    await waitFor(() => expect(result.current.archived).toEqual([]));
    expect(localStorage.getItem(FAVOURITES)).toBe(JSON.stringify(['gone']));
  });
  it('is pruned even when the favourites were pruned first', async () => {
    // The two sets are tracked separately, or whichever mounted first would be the only one
    // ever cleaned up and the other would grow for the life of the install.
    localStorage.setItem(ARCHIVED, JSON.stringify(['gone']));
    existingSessions.mockResolvedValue([]);
    const { useArchived, useFavourites } = await load();

    renderHook(() => useFavourites());
    const { result } = renderHook(() => useArchived());

    await waitFor(() => expect(result.current.archived).toEqual([]));
  });
});