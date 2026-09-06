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
