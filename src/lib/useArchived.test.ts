// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { read, save } from './store';

const { existingSessions } = vi.hoisted(() => ({ existingSessions: vi.fn() }));
vi.mock('./sidecar', () => ({ existingSessions: (ids: string[]) => existingSessions(ids) }));

const ARCHIVED = 'archived';
const FAVOURITES = 'favourites';

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
    save('sessions', ARCHIVED, JSON.stringify(['s1']));
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
    expect(read('sessions', FAVOURITES)).toBeNull();
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
    save('sessions', ARCHIVED, JSON.stringify(['gone', 'here']));
    existingSessions.mockResolvedValue(['here']);
    const { useArchived } = await load();

    const { result } = renderHook(() => useArchived());

    await waitFor(() => expect(result.current.archived).toEqual(['here']));
  });

  it('prunes its own set rather than the favourites', async () => {
    save('sessions', ARCHIVED, JSON.stringify(['gone']));
    save('sessions', FAVOURITES, JSON.stringify(['gone']));
    existingSessions.mockResolvedValue([]);
    const { useArchived } = await load();

    const { result } = renderHook(() => useArchived());

    await waitFor(() => expect(result.current.archived).toEqual([]));
    expect(read('sessions', FAVOURITES)).toBe(JSON.stringify(['gone']));
  });
  it('is pruned even when the favourites were pruned first', async () => {
    // The two sets are tracked separately, or whichever mounted first would be the only one
    // ever cleaned up and the other would grow for the life of the install.
    save('sessions', ARCHIVED, JSON.stringify(['gone']));
    existingSessions.mockResolvedValue([]);
    const { useArchived, useFavourites } = await load();

    renderHook(() => useFavourites());
    const { result } = renderHook(() => useArchived());

    await waitFor(() => expect(result.current.archived).toEqual([]));
  });
});

/**
 * Using an archived session takes it back out. Archiving evicts, so everything in there is
 * cold, and loading one again says plainly that it is not finished with - leaving it archived
 * would drop it back into a folded group the moment it was unloaded.
 */
describe('taking a session back out of the archive', () => {
  it('takes one out', async () => {
    save('sessions', ARCHIVED, JSON.stringify(['s1', 's2']));
    const { useArchived } = await load();
    const { result } = renderHook(() => useArchived());

    act(() => result.current.unarchive(['s1']));

    expect(result.current.archived).toEqual(['s2']);
  });

  it('remembers it next time, rather than putting it back on restart', async () => {
    save('sessions', ARCHIVED, JSON.stringify(['s1', 's2']));
    const { useArchived } = await load();
    const { result } = renderHook(() => useArchived());

    act(() => result.current.unarchive(['s1']));

    expect(read('sessions', ARCHIVED)).toBe(JSON.stringify(['s2']));
  });

  it('takes several out at once, since anything loaded qualifies', async () => {
    save('sessions', ARCHIVED, JSON.stringify(['s1', 's2', 's3']));
    const { useArchived } = await load();
    const { result } = renderHook(() => useArchived());

    act(() => result.current.unarchive(['s1', 's3']));

    expect(result.current.archived).toEqual(['s2']);
  });

  /**
   * It is called with every loaded session on each list refresh, so the common case is that
   * none of them is archived. That has to change nothing, or the identity of the array would
   * change on every refresh and whatever depends on it would run forever.
   */
  it('changes nothing when none of them was archived', async () => {
    save('sessions', ARCHIVED, JSON.stringify(['s1']));
    const { useArchived } = await load();
    const { result } = renderHook(() => useArchived());
    const before = result.current.archived;

    act(() => result.current.unarchive(['s2', 's3']));

    expect(result.current.archived).toBe(before);
  });

  it('leaves the favourites alone', async () => {
    save('sessions', ARCHIVED, JSON.stringify(['s1']));
    save('sessions', FAVOURITES, JSON.stringify(['s1']));
    const { useArchived, useFavourites } = await load();
    const archived = renderHook(() => useArchived());
    const favourites = renderHook(() => useFavourites());

    act(() => archived.result.current.unarchive(['s1']));

    expect(archived.result.current.archived).toEqual([]);
    expect(favourites.result.current.favourites).toEqual(['s1']);
  });
});