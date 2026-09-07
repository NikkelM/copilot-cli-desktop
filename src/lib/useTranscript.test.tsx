// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useTranscript } from './useTranscript';

const getTranscript = vi.fn();
vi.mock('./sidecar', () => ({ getTranscript: (...args: unknown[]) => getTranscript(...args) }));

const reply = (content: string, id: string) => ({ type: 'assistant.message', data: { content }, id });
const bodies = (events: { data: unknown }[]) => events.map((e) => (e.data as { content?: string }).content);

/** A reply that only lands when told to, so a request can be left in flight. */
function deferred() {
  let settle: (value: unknown) => void = () => {};
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle: (value: unknown) => settle(value) };
}

describe('useTranscript', () => {
  beforeEach(() => {
    getTranscript.mockReset();
  });

  it('replays the log of the session it is given', async () => {
    getTranscript.mockResolvedValue({ events: [reply('from the log', 'e1')], nextBefore: null });

    const { result } = renderHook(() => useTranscript('s1', () => {}));

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.hasOlder).toBe(false);
  });

  /**
   * The bug behind #71. A replay describes the log when it was requested, so one that
   * lands after the user has typed used to overwrite what they sent.
   */
  it('keeps a prompt sent while the replay was still in flight', async () => {
    const pending = deferred();
    getTranscript.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => result.current.showSent('do the thing'));
    expect(bodies(result.current.events)).toEqual(['do the thing']);

    await act(async () => {
      pending.settle({ events: [reply('from the log', 'e1')], nextBefore: null });
    });

    expect(bodies(result.current.events)).toEqual(['from the log', 'do the thing']);
  });

  it('lets the echo of a prompt replace the one shown early', async () => {
    getTranscript.mockResolvedValue({ events: [], nextBefore: null });
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => result.current.showSent('hello'));
    act(() => result.current.push({ type: 'user.message', data: { content: 'hello' }, id: 'server-1' }));

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]!.local).toBeUndefined();
  });

  // The reply describes a session that is no longer on screen.
  it('drops a replay that arrives after another session was opened', async () => {
    const first = deferred();
    getTranscript.mockReturnValueOnce(first.promise);
    getTranscript.mockResolvedValue({ events: [reply('second session', 'b1')], nextBefore: null });

    const { result, rerender } = renderHook(({ id }) => useTranscript(id, () => {}), {
      initialProps: { id: 's1' },
    });

    rerender({ id: 's2' });
    await waitFor(() => expect(bodies(result.current.events)).toEqual(['second session']));

    await act(async () => {
      first.settle({ events: [reply('first session', 'a1')], nextBefore: 10 });
    });

    expect(bodies(result.current.events)).toEqual(['second session']);
  });

  it('prepends an older page and follows the cursor back', async () => {
    getTranscript.mockResolvedValueOnce({ events: [reply('newer', 'e2')], nextBefore: 40 });
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(result.current.hasOlder).toBe(true));

    getTranscript.mockResolvedValueOnce({ events: [reply('older', 'e1')], nextBefore: null });
    await act(async () => result.current.loadOlder());

    expect(bodies(result.current.events)).toEqual(['older', 'newer']);
    expect(result.current.hasOlder).toBe(false);
  });

  it('will not splice one session\u2019s page into another', async () => {
    getTranscript.mockResolvedValueOnce({ events: [reply('newer', 'e2')], nextBefore: 40 });
    const { result, rerender } = renderHook(({ id }) => useTranscript(id, () => {}), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(result.current.hasOlder).toBe(true));

    const page = deferred();
    getTranscript.mockReturnValueOnce(page.promise);
    act(() => result.current.loadOlder());

    getTranscript.mockResolvedValue({ events: [reply('second session', 'b1')], nextBefore: null });
    rerender({ id: 's2' });
    await waitFor(() => expect(bodies(result.current.events)).toEqual(['second session']));

    await act(async () => {
      page.settle({ events: [reply('page of the first', 'a0')], nextBefore: null });
    });

    expect(bodies(result.current.events)).toEqual(['second session']);
  });

  it('reports a replay that failed rather than showing an empty session', async () => {
    getTranscript.mockRejectedValue(new Error('log unreadable'));
    const onError = vi.fn();

    renderHook(() => useTranscript('s1', onError));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(String(onError.mock.calls[0]?.[0])).toContain('log unreadable');
  });
});

/**
 * A stopped turn is the one case where what was on screen is never written down: the
 * runtime records streamed text only when a turn finishes.
 */
describe('useTranscript keeping what a stopped turn had said', () => {
  const streaming = (text: string, messageId = 'm1') => ({
    type: 'assistant.message_delta',
    data: { messageId, deltaContent: text },
    id: `d-${text}`,
  });
  const stop = (id: string) => ({ type: 'abort', data: { reason: 'user_initiated' }, id });

  beforeEach(() => {
    getTranscript.mockReset();
    getTranscript.mockResolvedValue({ events: [], nextBefore: null });
  });

  it('keeps the text against the abort that ended it', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    act(() => result.current.push(streaming('half a thought')));
    act(() => result.current.push(stop('a1')));

    expect(result.current.abandoned?.get('a1')).toBe('half a thought');
  });

  // Otherwise it would be shown twice: once from the live list, once from what was kept.
  it('takes the text out of the live list', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    act(() => result.current.push(streaming('half a thought')));
    act(() => result.current.push(stop('a1')));

    expect(result.current.events.some((e) => e.type === 'assistant.message_delta')).toBe(false);
  });

  // The whole point: leaving the session and coming back used to lose it.
  it('still has the text after the reader looks elsewhere and returns', async () => {
    const { result, rerender } = renderHook(({ id }) => useTranscript(id, () => {}), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());
    act(() => result.current.push(streaming('half a thought')));
    act(() => result.current.push(stop('a1')));

    rerender({ id: 's2' });
    rerender({ id: 's1' });

    expect(result.current.abandoned?.get('a1')).toBe('half a thought');
  });

  it('keeps each session\u2019s remains to itself', async () => {
    const { result, rerender } = renderHook(({ id }) => useTranscript(id, () => {}), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());
    act(() => result.current.push(streaming('from one')));
    act(() => result.current.push(stop('a1')));

    rerender({ id: 's2' });

    expect(result.current.abandoned?.get('a1')).toBeUndefined();
  });

  // Whole replies, kept for as long as the app is open: a session stopped a hundred times
  // would otherwise hold a hundred of them.
  it('keeps only the last few stopped replies of a session', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    for (let index = 0; index < 25; index++) {
      act(() => result.current.push(streaming(`reply ${index}`, `m${index}`)));
      act(() => result.current.push(stop(`a${index}`)));
    }

    expect(result.current.abandoned?.size).toBe(20);
    expect(result.current.abandoned?.get('a0')).toBeUndefined();
    expect(result.current.abandoned?.get('a24')).toBe('reply 24');
  });
  it('keeps nothing when the turn was stopped before it spoke', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    act(() => result.current.push(stop('a1')));

    expect(result.current.abandoned?.get('a1')).toBeUndefined();
  });

  // A turn that finished sent its whole message, which replaced the run of deltas; there
  // is nothing left over to keep.
  it('keeps nothing from a turn that finished before it was stopped', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    act(() => result.current.push(streaming('half a thought')));
    act(() =>
      result.current.push({ type: 'assistant.message', data: { messageId: 'm1', content: 'the whole thought' }, id: 'm' }),
    );
    act(() => result.current.push(stop('a1')));

    expect(result.current.abandoned?.get('a1')).toBeUndefined();
  });
});
