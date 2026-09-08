// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useChanges } from './useChanges';

const { getChanges, getDiff } = vi.hoisted(() => ({
  getChanges: vi.fn(),
  getDiff: vi.fn(),
}));

vi.mock('./sidecar', () => ({ getChanges, getDiff }));

const change = { path: 'a.ts', status: 'modified', linesAdded: 1, linesRemoved: 0, turns: 1, changedAt: '2026-01-02T00:00:00.000Z', diffable: true };

describe('useChanges', () => {
  beforeEach(() => {
    localStorage.clear();
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
    expect(getChanges).toHaveBeenCalledWith('s1', undefined);
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

describe('useChanges, reviewing', () => {
  beforeEach(() => {
    localStorage.clear();
    getChanges.mockReset().mockResolvedValue({ changes: [change] });
    getDiff.mockReset().mockResolvedValue({ patch: '@@', stale: false });
  });

  it('has no mark until one is set', () => {
    const { result } = renderHook(() => useChanges('s1'));
    expect(result.current.reviewedAt).toBeNull();
  });

  /**
   * The newest turn on show, not the current time: a turn that lands while the panel is
   * open would otherwise be marked as reviewed without having been seen.
   */
  it('marks up to the newest turn listed', async () => {
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.changes).not.toBeNull());

    act(() => result.current.review());
    expect(result.current.reviewedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('asks only for what is newer once marked', async () => {
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.changes).not.toBeNull());
    act(() => result.current.review());

    await waitFor(() => expect(getChanges).toHaveBeenLastCalledWith('s1', '2026-01-02T00:00:00.000Z'));
  });

  it('remembers the mark for next time', async () => {
    const first = renderHook(() => useChanges('s1'));

    act(() => first.result.current.load());
    await waitFor(() => expect(first.result.current.changes).not.toBeNull());
    act(() => first.result.current.review());
    first.unmount();

    const second = renderHook(() => useChanges('s1'));
    expect(second.result.current.reviewedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('keeps each session mark to itself', async () => {
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.changes).not.toBeNull());
    act(() => result.current.review());

    const other = renderHook(() => useChanges('s2'));
    expect(other.result.current.reviewedAt).toBeNull();
  });

  it('has nothing to mark when nothing is listed', async () => {
    getChanges.mockResolvedValue({ changes: [] });
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.changes).toEqual([]));

    act(() => result.current.review());
    expect(result.current.reviewedAt).toBeNull();
  });

  it('shows the whole session again on request', async () => {
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.changes).not.toBeNull());
    act(() => result.current.review());

    act(() => result.current.setSpan(true));
    expect(result.current.showAll).toBe(true);
    await waitFor(() => expect(getChanges).toHaveBeenLastCalledWith('s1', undefined));
  });

  // A diff answering the whole session under a heading promising only what is new is worse
  // than no diff, so the ones on hand go when the span moves.
  it('drops diffs that answer the old span', async () => {
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.diff('a.ts'));
    await waitFor(() => expect(result.current.diffs['a.ts']).toBeTruthy());

    act(() => result.current.setSpan(true));
    expect(result.current.diffs).toEqual({});
  });

  it('fetches diffs over the span on show', async () => {
    localStorage.setItem('copilot-desktop.reviewed', JSON.stringify({ s1: '2026-01-01T00:00:00.000Z' }));
    const { result } = renderHook(() => useChanges('s1'));

    act(() => result.current.diff('a.ts'));
    await waitFor(() => expect(getDiff).toHaveBeenCalledWith('s1', 'a.ts', '2026-01-01T00:00:00.000Z'));
  });

  it('survives a stored mark that is not readable', () => {
    localStorage.setItem('copilot-desktop.reviewed', 'not json');
    const { result } = renderHook(() => useChanges('s1'));
    expect(result.current.reviewedAt).toBeNull();
  });
});
