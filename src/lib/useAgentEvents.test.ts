// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptEvent } from '../../shared/protocol';

const getAgentTranscript = vi.fn();
vi.mock('./sidecar', () => ({ getAgentTranscript: (...args: unknown[]) => getAgentTranscript(...args) }));

const { useAgentEvents } = await import('./useAgentEvents');

const event = (content: string): TranscriptEvent =>
  ({ type: 'assistant.message', data: { content } }) as unknown as TranscriptEvent;

/** The announcement that opened a run, which is what proves a read reached its beginning. */
const started = (): TranscriptEvent => ({ type: 'subagent.started', data: {} }) as unknown as TranscriptEvent;

/** And the one that ended it, which is what proves nothing of the run is still to come. */
const finished = (): TranscriptEvent => ({ type: 'subagent.completed', data: {} }) as unknown as TranscriptEvent;

beforeEach(() => {
  getAgentTranscript.mockReset().mockResolvedValue({ events: [] });
});

/**
 * A subagent's work, read back from the log instead of held in memory (#178).
 *
 * The rule that matters is which of the two wins. A run still in flight is being written
 * as it happens, so the log is behind by design.
 */
describe('reading a subagent own events', () => {
  it('asks the log for the agent whose work is open', async () => {
    renderHook(() => useAgentEvents('s1', 'a1', []));

    await waitFor(() => expect(getAgentTranscript).toHaveBeenCalledWith('s1', 'a1'));
  });

  it('asks nothing when no subagent is open', () => {
    renderHook(() => useAgentEvents(null, null, []));

    expect(getAgentTranscript).not.toHaveBeenCalled();
  });

  it('shows what the log has once it arrives', async () => {
    getAgentTranscript.mockResolvedValue({ events: [event('one'), event('two')] });

    const { result } = renderHook(() => useAgentEvents('s1', 'a1', []));

    await waitFor(() => expect(result.current).toHaveLength(2));
  });

  /**
   * The integrity rule. Showing fewer events than the reader could already see would be a
   * regression dressed as a saving, so what is held stands until the log catches up.
   */
  it('keeps the held events while the log has fewer', async () => {
    const held = [event('a'), event('b'), event('c')];
    const answer = Promise.resolve({ events: [event('a')] });
    getAgentTranscript.mockReturnValue(answer);

    const { result } = renderHook(() => useAgentEvents('s1', 'a1', held));
    // The answer itself, so this waits for the state the read sets rather than for the
    // call that starts it - which lands a tick earlier and would prove nothing.
    await act(async () => {
      await answer;
    });

    expect(result.current).toBe(held);
  });

  it('takes the log once it has as much as is held', async () => {
    const held = [event('a')];
    getAgentTranscript.mockResolvedValue({ events: [event('a'), event('b')] });

    const { result } = renderHook(() => useAgentEvents('s1', 'a1', held));

    await waitFor(() => expect(result.current).toHaveLength(2));
  });

  // The held events are still there, so a log that cannot be read costs nothing.
  it('falls back to what is held when the log cannot be read', async () => {
    const held = [event('a')];
    const answer = Promise.reject(new Error('gone'));
    getAgentTranscript.mockReturnValue(answer);

    const { result } = renderHook(() => useAgentEvents('s1', 'a1', held));
    await act(async () => {
      await answer.catch(() => undefined);
    });

    expect(result.current).toBe(held);
  });

  /** One agent's answer must never be drawn as another's. */
  it('does not show one agent work under another', async () => {
    const held = [event('held')];
    getAgentTranscript.mockResolvedValue({ events: [event('first'), event('second')] });

    const { result, rerender } = renderHook(({ id }) => useAgentEvents('s1', id, held), {
      initialProps: { id: 'a1' },
    });
    await waitFor(() => expect(result.current).toHaveLength(2));

    getAgentTranscript.mockReturnValue(new Promise(() => undefined));
    rerender({ id: 'a2' });

    expect(result.current).toBe(held);
  });

  it('stops showing anything once the subagent is closed', async () => {
    const { result, rerender } = renderHook(({ id }) => useAgentEvents('s1', id, []), {
      initialProps: { id: 'a1' as string | null },
    });
    await waitFor(() => expect(getAgentTranscript).toHaveBeenCalled());

    rerender({ id: null });

    expect(result.current).toEqual([]);
  });
});

/**
 * Which copy to believe once the log can be shown to hold the whole run (#262).
 *
 * A subagent's transcript was showing prompts the reader had sent to the session itself, and
 * not showing the instruction the session gave the subagent. The two copies were compared by
 * length, which is the wrong question: a held copy carrying something that is not this
 * agent's work is not a better copy for being longer, it is a worse one, and it was winning.
 */
describe('a log that reached the start of the run', () => {
  /** The whole point: fewer events, and still the one to believe. */
  it('wins even when more is held', async () => {
    const held = [event('a'), event('b'), event('c')];
    const answer = Promise.resolve({ events: [started(), event('a'), finished()] });
    getAgentTranscript.mockReturnValue(answer);

    const { result } = renderHook(() => useAgentEvents('s1', 'a1', held));
    await act(async () => {
      await answer;
    });

    expect(result.current).toHaveLength(3);
    expect(result.current).not.toBe(held);
  });

  /**
   * The log is read once, when the view opens, and a run that has not finished goes on being
   * written afterwards. Preferring a copy that cannot grow over the one the events are
   * arriving on showed the run as it was at the moment it was opened, and the reader had to
   * leave and come back to see it move.
   */
  it('follows a run still working rather than the read that opened it', async () => {
    const answer = Promise.resolve({ events: [started(), event('a')] });
    getAgentTranscript.mockReturnValue(answer);

    const { result, rerender } = renderHook(({ held }) => useAgentEvents('s1', 'a1', held), {
      initialProps: { held: [started(), event('a')] },
    });
    await act(async () => {
      await answer;
    });

    // The run writes two more lines while the view stays open.
    rerender({ held: [started(), event('a'), event('b'), event('c')] });

    expect(result.current).toHaveLength(4);
  });

  /**
   * The start is what proves the read reached the beginning of the run. An outcome without
   * one is a read that caught the end and may be missing everything before it, which is the
   * half of the test that keeps a short read from replacing a fuller held copy.
   */
  it('is not whole on an outcome with no start behind it', async () => {
    const held = [event('a'), event('b'), event('c')];
    const answer = Promise.resolve({ events: [event('a'), finished()] });
    getAgentTranscript.mockReturnValue(answer);

    const { result } = renderHook(() => useAgentEvents('s1', 'a1', held));
    await act(async () => {
      await answer;
    });

    expect(result.current).toBe(held);
  });

  /** A run that failed has ended as surely as one that completed. */
  it('counts a run that failed as ended', async () => {
    const held = [event('a'), event('b'), event('c')];
    const failed = { type: 'subagent.failed', data: {} } as unknown as TranscriptEvent;
    const answer = Promise.resolve({ events: [started(), failed] });
    getAgentTranscript.mockReturnValue(answer);

    const { result } = renderHook(() => useAgentEvents('s1', 'a1', held));
    await act(async () => {
      await answer;
    });

    expect(result.current).toHaveLength(2);
  });

  /** Without that proof the old rule still applies, so a run in flight is not cut short. */
  it('leaves the held copy alone while the read has not reached the start', async () => {
    const held = [event('a'), event('b'), event('c')];
    const answer = Promise.resolve({ events: [event('a')] });
    getAgentTranscript.mockReturnValue(answer);

    const { result } = renderHook(() => useAgentEvents('s1', 'a1', held));
    await act(async () => {
      await answer;
    });

    expect(result.current).toBe(held);
  });

  it('is still the one to believe when it has more as well', async () => {
    const answer = Promise.resolve({ events: [started(), event('a'), event('b')] });
    getAgentTranscript.mockReturnValue(answer);

    const { result } = renderHook(() => useAgentEvents('s1', 'a1', [event('a')]));
    await act(async () => {
      await answer;
    });

    expect(result.current).toHaveLength(3);
  });
});
