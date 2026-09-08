// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useChanges } from './useChanges';

const { getChanges, getDiff } = vi.hoisted(() => ({
  getChanges: vi.fn(),
  getDiff: vi.fn(),
}));

vi.mock('./sidecar', () => ({ getChanges, getDiff }));

const change = { path: 'a.ts', status: 'modified', linesAdded: 1, linesRemoved: 0, turns: 1, changedAt: '', diffable: true };

describe('useChanges', () => {
  beforeEach(() => {
    getChanges.mockReset().mockResolvedValue({ changes: [change] });
    getDiff.mockReset().mockResolvedValue({ patch: '@@', stale: false });
  });

  /**
   * Reading the store costs half a second on a long session. Selecting a session in the
   * sidebar must stay instant, so nothing is read until the panel is actually opened.
   */
  it('reads nothing until asked', () => {
    renderHook(() => useChanges('s1'));
    expect(getChanges).not.toHaveBeenCalled();
  });

  it('reads when asked', async () => {
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.changes).toEqual([change]));
    expect(getChanges).toHaveBeenCalledWith('s1');
  });

  it('has nothing to read without a session', () => {
    const { result } = renderHook(() => useChanges(null));

    act(() => result.current.load());
    expect(getChanges).not.toHaveBeenCalled();
  });

  it('reports a failed read rather than staying empty', async () => {
    getChanges.mockRejectedValue(new Error('no such session'));
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.failed).toContain('no such session'));
    expect(result.current.loading).toBe(false);
  });

  // Another session changed other files; keeping the last one's would say something false.
  it('forgets what it read when the session changes', async () => {
    const { result, rerender } = renderHook(({ id }) => useChanges(id), {
      initialProps: { id: 's1' },
    });

    act(() => result.current.load());
    await waitFor(() => expect(result.current.changes).not.toBeNull());

    rerender({ id: 's2' });
    expect(result.current.changes).toBeNull();
    expect(result.current.diffs).toEqual({});
  });

  it('fetches a diff one file at a time', async () => {
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.diff('a.ts'));
    await waitFor(() => expect(result.current.diffs['a.ts']).toEqual({ patch: '@@', stale: false }));
  });

  // Opening, closing and reopening a row is common, and each fetch is a whole file twice.
  it('does not fetch a diff it already holds', async () => {
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.diff('a.ts'));
    await waitFor(() => expect(result.current.diffs['a.ts']).toBeTruthy());

    act(() => result.current.diff('a.ts'));
    expect(getDiff).toHaveBeenCalledTimes(1);
  });
});
