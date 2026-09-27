// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RewindPoint, RewindResult, RewindUnavailable } from '../../shared/protocol';

const { getRewindPoints, previewRewind, rewindSession } = vi.hoisted(() => ({
  getRewindPoints: vi.fn(),
  previewRewind: vi.fn(),
  rewindSession: vi.fn(),
}));

vi.mock('./sidecar', () => ({
  getRewindPoints: (sessionId: string) => getRewindPoints(sessionId),
  previewRewind: (sessionId: string, eventId: string) => previewRewind(sessionId, eventId),
  rewindSession: (sessionId: string, eventId: string, files: boolean) =>
    rewindSession(sessionId, eventId, files),
}));

import { useRewind } from './useRewind';

const point = (eventId: string): RewindPoint => ({
  eventId,
  message: `asked ${eventId}`,
  at: '2026-09-27T10:00:00.000Z',
  canRestoreFiles: true,
  fileCount: 1,
  linesAdded: 2,
  linesRemoved: 0,
});

/** What the sidecar would answer, so a test says what it means rather than satisfying a type. */
const answers = (points: RewindPoint[], unavailable?: RewindUnavailable) =>
  getRewindPoints.mockResolvedValue({ points, ...(unavailable ? { unavailable } : {}) });

const rewindsWith = (outcome: RewindResult['outcome']) =>
  rewindSession.mockResolvedValue({ outcome, restoredFiles: [], skippedFiles: [] });

beforeEach(() => {
  vi.clearAllMocks();
  answers([]);
  rewindsWith('success');
  previewRewind.mockResolvedValue({ available: true, files: [] });
});

describe('putting a session back to an earlier turn', () => {
  /**
   * Reading the points resumes the session, which is the opposite of what this app is for.
   * Nothing is asked until somebody looks.
   */
  it('asks nothing until it is asked to', () => {
    renderHook(() => useRewind('s1'));

    expect(getRewindPoints).not.toHaveBeenCalled();
  });

  it('keys the turns by the event that begins them, as the transcript keys its rows', async () => {
    answers([point('e1'), point('e2')]);
    const { result } = renderHook(() => useRewind('s1'));

    act(() => result.current.load());

    await waitFor(() => expect(result.current.points.size).toBe(2));
    expect(result.current.points.get('e2')?.message).toBe('asked e2');
  });

  it('carries why a session cannot be rewound', async () => {
    answers([], 'busy');
    const { result } = renderHook(() => useRewind('s1'));

    act(() => result.current.load());

    await waitFor(() => expect(result.current.unavailable).toBe('busy'));
  });

  it('says why when the runtime refuses to answer', async () => {
    getRewindPoints.mockRejectedValue(new Error('no such session'));
    const { result } = renderHook(() => useRewind('s1'));

    act(() => result.current.load());

    await waitFor(() => expect(result.current.failed).toBe('no such session'));
  });

  /**
   * The discarded turns are gone, so every point from the one rewound to onwards has
   * stopped existing. Keeping them would offer a way back to a turn that is no longer there.
   */
  it('forgets the turns once one has been rewound to', async () => {
    answers([point('e1'), point('e2')]);
    const { result } = renderHook(() => useRewind('s1'));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.points.size).toBe(2));

    await act(async () => {
      await result.current.rewind('e1', true);
    });

    expect(result.current.points.size).toBe(0);
  });

  // A rewind that was refused changed nothing, so what it was offering is all still good.
  it.each(['busy', 'untracked', 'remote'] as const)('keeps the turns when it was refused as %s', async (outcome) => {
    answers([point('e1')]);
    rewindsWith(outcome);
    const { result } = renderHook(() => useRewind('s1'));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.points.size).toBe(1));

    await act(async () => {
      await result.current.rewind('e1', true);
    });

    expect(result.current.points.size).toBe(1);
  });

  /**
   * A partial failure still discarded something, so the points it was offering have moved
   * even though it did not simply work.
   */
  it('forgets the turns after a rewind that partly happened', async () => {
    answers([point('e1')]);
    rewindsWith('truncation-failed');
    const { result } = renderHook(() => useRewind('s1'));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.points.size).toBe(1));

    await act(async () => {
      await result.current.rewind('e1', true);
    });

    expect(result.current.points.size).toBe(0);
  });

  it('asks for the files only when they were wanted', async () => {
    const { result } = renderHook(() => useRewind('s1'));

    await act(async () => {
      await result.current.rewind('e1', false);
    });

    expect(rewindSession).toHaveBeenCalledWith('s1', 'e1', false);
  });

  // The turns belong to the session they were read for.
  it('forgets the turns when the session changes', async () => {
    answers([point('e1')]);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useRewind(id), {
      initialProps: { id: 's1' },
    });
    act(() => result.current.load());
    await waitFor(() => expect(result.current.points.size).toBe(1));

    rerender({ id: 's2' });

    expect(result.current.points.size).toBe(0);
  });

  /**
   * A reply already on its way when the session changes describes the session being left.
   * Filing it under the new one would offer turns from somebody else's conversation.
   */
  it('drops an answer that arrives after the session has changed', async () => {
    let answer: (value: { points: RewindPoint[] }) => void = () => {};
    getRewindPoints.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ id }: { id: string }) => useRewind(id), {
      initialProps: { id: 's1' },
    });
    act(() => result.current.load());

    rerender({ id: 's2' });
    await act(async () => {
      answer({ points: [point('e1')] });
    });

    expect(result.current.points.size).toBe(0);
  });
});
