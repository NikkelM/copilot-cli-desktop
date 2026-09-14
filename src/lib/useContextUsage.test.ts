// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useContextUsage } from './useContextUsage';
import type { SessionContextUsage, TranscriptEvent } from '../../shared/protocol';

const sessionContext = vi.fn();

vi.mock('./sidecar', () => ({
  sessionContext: (sessionId: string) => sessionContext(sessionId),
}));

const usage: SessionContextUsage = {
  totalTokens: 34_000,
  promptTokenLimit: 128_000,
  compactionThreshold: 102_400,
  categories: {
    systemPrompt: 4000,
    customInstructions: 1000,
    systemTools: 8000,
    mcpTools: 2000,
    messages: 19_000,
    freeSpace: 94_000,
  },
  compactions: 0,
};

/** A promise that can be settled from the test, for checking what happens mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const event = (type: string): TranscriptEvent => ({ type, data: {} }) as TranscriptEvent;

beforeEach(() => {
  sessionContext.mockReset().mockResolvedValue(usage);
});

describe('useContextUsage', () => {
  it('asks about the session it is opened on', async () => {
    const { result } = renderHook(() => useContextUsage('s1'));

    await waitFor(() => expect(result.current.usage).toEqual(usage));
    expect(sessionContext).toHaveBeenCalledWith('s1');
  });

  it('asks nothing when there is no session open', () => {
    renderHook(() => useContextUsage(null));
    expect(sessionContext).not.toHaveBeenCalled();
  });

  // A cold session is answered with nothing, which is the meter's cue to show the model's
  // own size instead of a reading it does not have.
  it('holds nothing for a session the runtime is not holding', async () => {
    sessionContext.mockResolvedValue(null);
    const { result } = renderHook(() => useContextUsage('cold'));

    await waitFor(() => expect(sessionContext).toHaveBeenCalled());
    expect(result.current.usage).toBeNull();
  });

  it('asks again about the session it is moved to', async () => {
    const { result, rerender } = renderHook(({ id }) => useContextUsage(id), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(result.current.usage).toEqual(usage));

    rerender({ id: 's2' });

    await waitFor(() => expect(sessionContext).toHaveBeenLastCalledWith('s2'));
  });

  /**
   * The previous session's figures must not linger over the new one even for a frame: they
   * would read as that session's own, and the two are rarely close.
   */
  it('drops what it held the moment the session changes', async () => {
    const slow = deferred<SessionContextUsage | null>();
    const { result, rerender } = renderHook(({ id }) => useContextUsage(id), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(result.current.usage).toEqual(usage));

    sessionContext.mockReturnValueOnce(slow.promise);
    rerender({ id: 's2' });

    expect(result.current.usage).toBeNull();
  });

  /**
   * A read started for a session the reader has since left must not land. Without the guard
   * the slow answer arrives after the switch and reports the old session's window as the
   * new one's.
   */
  it('ignores an answer about a session no longer open', async () => {
    const slow = deferred<SessionContextUsage | null>();
    sessionContext.mockReturnValueOnce(slow.promise);

    const { result, rerender } = renderHook(({ id }) => useContextUsage(id), {
      initialProps: { id: 's1' },
    });

    sessionContext.mockResolvedValue(null);
    rerender({ id: 's2' });
    await act(async () => {
      slow.resolve(usage);
      await slow.promise;
    });

    expect(result.current.usage).toBeNull();
  });

  /**
   * Closing to no session at all, rather than moving to another one.
   *
   * The counter that makes a stale answer recognisable is only bumped by asking, and there
   * is nothing to ask about once no session is open - so this is the one case where a read
   * in flight comes back still looking current, and only the session it was for tells them
   * apart.
   */
  it('ignores an answer that arrives after the last session closes', async () => {
    const slow = deferred<SessionContextUsage | null>();
    sessionContext.mockReturnValueOnce(slow.promise);

    const { result, rerender } = renderHook(({ id }) => useContextUsage(id), {
      initialProps: { id: 's1' as string | null },
    });

    rerender({ id: null });
    await act(async () => {
      slow.resolve(usage);
      await slow.promise;
    });

    expect(result.current.usage).toBeNull();
  });

  describe('when it asks again', () => {
    it('asks when a reply finishes', async () => {
      const { result } = renderHook(() => useContextUsage('s1'));
      await waitFor(() => expect(sessionContext).toHaveBeenCalledTimes(1));

      act(() => result.current.observe(event('session.idle')));

      await waitFor(() => expect(sessionContext).toHaveBeenCalledTimes(2));
    });

    // The one thing that makes the number go down, and it lands mid-request rather than at
    // the end of one, so waiting for idle would show the old figure while it mattered most.
    it('asks when history is compacted away', async () => {
      const { result } = renderHook(() => useContextUsage('s1'));
      await waitFor(() => expect(sessionContext).toHaveBeenCalledTimes(1));

      act(() => result.current.observe(event('session.compaction_complete')));

      await waitFor(() => expect(sessionContext).toHaveBeenCalledTimes(2));
    });

    /**
     * A request that calls tools starts and ends a turn many times over. Asking on each would
     * spend a round trip per hop on a number the reader sees move once.
     */
    it('does not ask on every round trip within a reply', async () => {
      const { result } = renderHook(() => useContextUsage('s1'));
      await waitFor(() => expect(sessionContext).toHaveBeenCalledTimes(1));

      act(() => {
        result.current.observe(event('assistant.turn_start'));
        result.current.observe(event('assistant.turn_end'));
        result.current.observe(event('tool.execution_complete'));
        result.current.observe(event('assistant.message_delta'));
      });

      expect(sessionContext).toHaveBeenCalledTimes(1);
    });

    it('asks once a session is woken', async () => {
      sessionContext.mockResolvedValue(null);
      const { result } = renderHook(() => useContextUsage('s1'));
      await waitFor(() => expect(sessionContext).toHaveBeenCalledTimes(1));

      sessionContext.mockResolvedValue(usage);
      act(() => result.current.observeLoaded(true));

      await waitFor(() => expect(result.current.usage).toEqual(usage));
    });

    // The runtime that held the count went with it, so there is nothing left to ask.
    it('drops the reading when a session is let go, without asking', async () => {
      const { result } = renderHook(() => useContextUsage('s1'));
      await waitFor(() => expect(result.current.usage).toEqual(usage));

      act(() => result.current.observeLoaded(false));

      expect(result.current.usage).toBeNull();
      expect(sessionContext).toHaveBeenCalledTimes(1);
    });

    /**
     * A read already in flight when the session is let go must not land afterwards and put
     * a reading back on a session that is no longer holding one.
     */
    it('ignores an answer that arrives after the session was let go', async () => {
      const slow = deferred<SessionContextUsage | null>();
      sessionContext.mockReturnValueOnce(slow.promise);
      const { result } = renderHook(() => useContextUsage('s1'));

      act(() => result.current.observeLoaded(false));
      await act(async () => {
        slow.resolve(usage);
        await slow.promise;
      });

      expect(result.current.usage).toBeNull();
    });
  });

  // A window that cannot be measured is not something the reader can act on, and a session
  // going away is the usual reason it cannot be.
  it('keeps quiet when the read fails', async () => {
    sessionContext.mockRejectedValue(new Error('gone'));
    const { result } = renderHook(() => useContextUsage('s1'));

    await waitFor(() => expect(sessionContext).toHaveBeenCalled());
    expect(result.current.usage).toBeNull();
  });
});
