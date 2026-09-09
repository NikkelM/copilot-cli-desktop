// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueuedItem } from '../../shared/protocol';

import { useQueue } from './useQueue';

const { sessionQueue } = vi.hoisted(() => ({ sessionQueue: vi.fn() }));

vi.mock('./sidecar', () => ({ sessionQueue }));

const item = (id: string, text = id): QueuedItem => ({ id, kind: 'message', text, messageId: `m-${id}` });

describe('useQueue', () => {
  beforeEach(() => {
    sessionQueue.mockReset().mockResolvedValue([]);
  });

  it('starts with nothing waiting', () => {
    const { result } = renderHook(() => useQueue());
    expect(result.current.queues).toEqual({});
  });

  // The runtime says only that its queue changed, so the answer has to be asked for.
  it('reads the runtime queue when asked', async () => {
    sessionQueue.mockResolvedValue([item('a'), item('b')]);
    const { result } = renderHook(() => useQueue());

    act(() => result.current.refresh('s1'));

    await waitFor(() => expect(result.current.queues.s1).toHaveLength(2));
    expect(result.current.queues.s1?.map((q) => q.text)).toEqual(['a', 'b']);
    expect(sessionQueue).toHaveBeenCalledWith('s1');
  });

  it('keeps each session apart', async () => {
    sessionQueue.mockImplementation((id: string) => Promise.resolve(id === 's1' ? [item('a')] : [item('b')]));
    const { result } = renderHook(() => useQueue());

    act(() => {
      result.current.refresh('s1');
      result.current.refresh('s2');
    });

    await waitFor(() => expect(result.current.queues.s2).toHaveLength(1));
    expect(result.current.queues.s1?.[0]?.text).toBe('a');
    expect(result.current.queues.s2?.[0]?.text).toBe('b');
  });

  /**
   * A turn taking three queued messages announces three changes in quick succession. Each
   * read is a round trip, and without ordering they land in whatever order they finish in,
   * leaving the queue showing a state it has already moved past.
   */
  it('ignores an answer overtaken by a later read', async () => {
    let resolveFirst: (items: QueuedItem[]) => void = () => {};
    sessionQueue
      .mockImplementationOnce(() => new Promise<QueuedItem[]>((r) => (resolveFirst = r)))
      .mockImplementationOnce(() => Promise.resolve([item('c')]));

    const { result } = renderHook(() => useQueue());

    act(() => result.current.refresh('s1'));
    act(() => result.current.refresh('s1'));
    await waitFor(() => expect(result.current.queues.s1?.[0]?.text).toBe('c'));

    // The first read finishes last, carrying the state before the second.
    await act(async () => resolveFirst([item('a'), item('b')]));
    expect(result.current.queues.s1?.map((q) => q.text)).toEqual(['c']);
  });

  it('empties a queue the runtime says is empty', async () => {
    sessionQueue.mockResolvedValueOnce([item('a')]).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useQueue());

    act(() => result.current.refresh('s1'));
    await waitFor(() => expect(result.current.queues.s1).toHaveLength(1));

    act(() => result.current.refresh('s1'));
    await waitFor(() => expect(result.current.queues.s1).toEqual([]));
  });

  /**
   * The sidebar rerenders on the queue, and a session left running announces a change on
   * every message it takes. Answering "still nothing" with a new array would rerender for
   * every one of them.
   */
  it('does not churn when nothing was waiting and nothing is', async () => {
    const { result } = renderHook(() => useQueue());

    act(() => result.current.refresh('s1'));
    await waitFor(() => expect(sessionQueue).toHaveBeenCalled());
    const before = result.current.queues;

    act(() => result.current.refresh('s1'));
    await waitFor(() => expect(sessionQueue).toHaveBeenCalledTimes(2));
    expect(result.current.queues).toBe(before);
  });

  // The session is gone before an answer could come back, and the queue went with it.
  it('forgets a session without asking', async () => {
    sessionQueue.mockResolvedValue([item('a')]);
    const { result } = renderHook(() => useQueue());

    act(() => result.current.refresh('s1'));
    await waitFor(() => expect(result.current.queues.s1).toHaveLength(1));

    sessionQueue.mockClear();
    act(() => result.current.clear('s1'));

    expect(result.current.queues.s1).toEqual([]);
    expect(sessionQueue).not.toHaveBeenCalled();
  });

  /**
   * A read that fails is a session going away, which happens whenever one is let go. Saying
   * so in the error bar would bury a real message under that noise.
   */
  it('empties rather than reporting a queue it cannot read', async () => {
    sessionQueue.mockResolvedValueOnce([item('a')]).mockRejectedValueOnce(new Error('gone'));
    const { result } = renderHook(() => useQueue());

    act(() => result.current.refresh('s1'));
    await waitFor(() => expect(result.current.queues.s1).toHaveLength(1));

    act(() => result.current.refresh('s1'));
    await waitFor(() => expect(result.current.queues.s1).toEqual([]));
  });
});