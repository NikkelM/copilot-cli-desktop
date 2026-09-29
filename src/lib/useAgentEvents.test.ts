// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptEvent } from '../../shared/protocol';

const getAgentTranscript = vi.fn();
vi.mock('./sidecar', () => ({ getAgentTranscript: (...args: unknown[]) => getAgentTranscript(...args) }));

const { useAgentEvents } = await import('./useAgentEvents');

const event = (content: string): TranscriptEvent =>
  ({ type: 'assistant.message', data: { content } }) as unknown as TranscriptEvent;

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
