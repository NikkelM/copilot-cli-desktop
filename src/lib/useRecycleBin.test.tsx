// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRecycleBin } from './useRecycleBin';
import type { BinnedSession } from '../../shared/protocol';

const { binnedSessions, restoreBinned, purgeBinned } = vi.hoisted(() => ({
  binnedSessions: vi.fn(),
  restoreBinned: vi.fn(),
  purgeBinned: vi.fn(),
}));
vi.mock('./sidecar', () => ({ binnedSessions, restoreBinned, purgeBinned }));

const waiting: BinnedSession[] = [
  { sessionId: 'a', title: 'A session', binnedAt: '2026-03-01T00:00:00.000Z', updatedAt: null, bytes: 10 },
];

beforeEach(() => {
  binnedSessions.mockReset().mockResolvedValue(waiting);
  restoreBinned.mockReset().mockResolvedValue(true);
  purgeBinned.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('the recycle bin', () => {
  // Looked at rarely, so a listing nobody opened is a listing nobody needed.
  it('reads nothing until it is asked', () => {
    const { result } = renderHook(() => useRecycleBin());

    expect(result.current.binned).toBeNull();
    expect(binnedSessions).not.toHaveBeenCalled();
  });

  it('answers with what is waiting', async () => {
    const { result } = renderHook(() => useRecycleBin());

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.binned).toEqual(waiting));
  });

  /** A window stuck reading for ever is worse than one that says the bin is empty. */
  it('reads as empty when the bin cannot be read', async () => {
    binnedSessions.mockRejectedValue(new Error('no such directory'));
    const { result } = renderHook(() => useRecycleBin());

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.binned).toEqual([]));
  });

  /**
   * What is drawn stays true until the answer arrives (#217).
   *
   * Emptying it first collapses the settings panel, which clamps its scroll to the top and
   * then drops it back when the rows return - a jump for every delete. The first read has
   * nothing on screen to keep, and says it is reading because `binned` starts null anyway.
   */
  it('keeps what is on screen while it reads again', async () => {
    const { result } = renderHook(() => useRecycleBin());
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.binned).toEqual(waiting));

    let settle: (sessions: BinnedSession[]) => void = () => {};
    binnedSessions.mockReturnValue(new Promise<BinnedSession[]>((resolve) => (settle = resolve)));
    act(() => result.current.refresh());

    expect(result.current.binned).toEqual(waiting);
    await act(async () => settle([]));
    expect(result.current.binned).toEqual([]);
  });

  // Nothing has been read yet, so there is nothing to keep and nothing to say but that.
  it('says it is reading before anything has been read', () => {
    const { result } = renderHook(() => useRecycleBin());

    expect(result.current.binned).toBeNull();
  });

  describe('putting one back', () => {
    it('tells whoever keeps the session list to look again', async () => {
      const onRestored = vi.fn();
      const { result } = renderHook(() => useRecycleBin(onRestored));

      await act(async () => result.current.restore('a'));

      expect(restoreBinned).toHaveBeenCalledExactlyOnceWith('a');
      await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
    });

    /** Nothing came back, so there is nothing new for the list to find. */
    it('says nothing when it did not go back', async () => {
      restoreBinned.mockResolvedValue(false);
      const onRestored = vi.fn();
      const { result } = renderHook(() => useRecycleBin(onRestored));

      await act(async () => result.current.restore('a'));

      expect(onRestored).not.toHaveBeenCalled();
    });

    // The only other sign is a row that stays where it was, which reads as a dead button.
    it('says why it did not go back', async () => {
      restoreBinned.mockResolvedValue(false);
      const onError = vi.fn();
      const { result } = renderHook(() => useRecycleBin(undefined, onError));

      await act(async () => result.current.restore('a'));

      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('already exists'));
    });

    it('reports a failure rather than leaving it unhandled', async () => {
      restoreBinned.mockRejectedValue(new Error('in the way'));
      const onError = vi.fn();
      const { result } = renderHook(() => useRecycleBin(undefined, onError));

      await act(async () => result.current.restore('a'));

      await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('in the way')));
    });

    it('reads the bin again, so the row it took goes', async () => {
      const { result } = renderHook(() => useRecycleBin());

      await act(async () => result.current.restore('a'));

      await waitFor(() => expect(binnedSessions).toHaveBeenCalled());
    });

    it('reads it again even when putting it back failed', async () => {
      restoreBinned.mockRejectedValue(new Error('in the way'));
      const { result } = renderHook(() => useRecycleBin());

      await act(async () => result.current.restore('a'));

      await waitFor(() => expect(binnedSessions).toHaveBeenCalled());
    });
  });

  describe('deleting one for good', () => {
    it('asks for it and reads the bin again', async () => {
      const { result } = renderHook(() => useRecycleBin());

      await act(async () => result.current.purge('a'));

      expect(purgeBinned).toHaveBeenCalledExactlyOnceWith('a');
      await waitFor(() => expect(binnedSessions).toHaveBeenCalled());
    });

    it('reports a failure rather than leaving it unhandled', async () => {
      purgeBinned.mockRejectedValue(new Error('still in use'));
      const onError = vi.fn();
      const { result } = renderHook(() => useRecycleBin(undefined, onError));

      await act(async () => result.current.purge('a'));

      await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('still in use')));
    });

    it('leaves the session list alone', async () => {
      const onRestored = vi.fn();
      const { result } = renderHook(() => useRecycleBin(onRestored));

      await act(async () => result.current.purge('a'));

      expect(onRestored).not.toHaveBeenCalled();
    });
  });
});
