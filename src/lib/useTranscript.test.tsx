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

  /**
   * Opening a session used to ask for the sidecar's full cap of 500 events, which is 288ms
   * of markdown parsing on a real session against 37ms for a page of 150. The cost is the
   * parsing, not the DOM - 500 events is only about 1100 nodes - so asking for less is the
   * whole fix, and scrolling up already reaches the rest.
   */
  it('asks for a page rather than everything the sidecar would give', async () => {
    getTranscript.mockResolvedValue({ events: [], nextBefore: null });
    renderHook(() => useTranscript('s1', () => {}));

    await waitFor(() => expect(getTranscript).toHaveBeenCalled());
    const [, limit] = getTranscript.mock.calls[0] as [string, number | undefined];
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(500);
  });

  it('holds older pages to the same size', async () => {
    getTranscript.mockResolvedValueOnce({ events: [reply('newer', 'e2')], nextBefore: 40 });
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(result.current.hasOlder).toBe(true));

    getTranscript.mockResolvedValueOnce({ events: [reply('older', 'e1')], nextBefore: null });
    await act(async () => result.current.loadOlder());

    const first = getTranscript.mock.calls[0] as [string, number | undefined];
    const older = getTranscript.mock.calls[1] as [string, number | undefined, number];
    expect(older[1]).toBe(first[1]);
    expect(older[2]).toBe(40);
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

/**
 * The rows the hook puts there itself, none of which a replay will ever bring back.
 *
 * Separate from the stopped-turn remains because these are the ordinary case: a prompt
 * shown before the runtime has echoed it, a send that then failed, and the output of a
 * slash command, which is returned to whoever ran it and written down nowhere.
 */
describe('useTranscript showing what no event will bring', () => {
  beforeEach(() => {
    getTranscript.mockReset().mockResolvedValue({ events: [], nextBefore: null });
  });

  it('takes back a prompt whose send failed', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    let id = '';
    act(() => {
      id = result.current.showSent('never sent');
    });
    act(() => result.current.remove(id));

    expect(result.current.events).toEqual([]);
  });

  it('puts a command\u2019s output in the transcript', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    act(() => result.current.showLocal('local.usage', { total: 12 }));

    expect(result.current.events[0]).toMatchObject({ type: 'local.usage', data: { total: 12 }, local: true });
  });
});

describe('useTranscript when there is nothing to read', () => {
  beforeEach(() => {
    getTranscript.mockReset().mockResolvedValue({ events: [], nextBefore: null });
  });

  it('reads nothing without a session, since browsing one costs a disk read', () => {
    renderHook(() => useTranscript(null, () => {}));

    expect(getTranscript).not.toHaveBeenCalled();
  });

  it('empties what the last session left behind before the new one arrives', async () => {
    getTranscript.mockResolvedValue({ events: [reply('from the log', 'e1')], nextBefore: null });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useTranscript(id, () => {}), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    const pending = deferred();
    getTranscript.mockReturnValue(pending.promise);
    rerender({ id: 's2' });

    expect(result.current.events).toEqual([]);
    await act(async () => pending.settle({ events: [], nextBefore: null }));
  });

  it('does not ask again once it is at the start of the log', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalledTimes(1));

    act(() => result.current.loadOlder());

    expect(getTranscript).toHaveBeenCalledTimes(1);
  });

  it('stops saying it is loading when the older page fails to arrive', async () => {
    getTranscript.mockResolvedValue({ events: [reply('from the log', 'e1')], nextBefore: 40 });
    const failed = vi.fn();
    const { result } = renderHook(() => useTranscript('s1', failed));
    await waitFor(() => expect(result.current.hasOlder).toBe(true));

    getTranscript.mockRejectedValue(new Error('log truncated'));
    act(() => result.current.loadOlder());

    await waitFor(() => expect(failed).toHaveBeenCalledWith(expect.stringContaining('log truncated')));
    expect(result.current.loadingOlder).toBe(false);
  });
});

describe('giving back history reached by scrolling up', () => {
  beforeEach(() => {
    getTranscript.mockReset();
  });

  /** Opens on one page, then reaches back for two more. */
  async function scrolledBack() {
    getTranscript.mockResolvedValueOnce({ events: [reply('page 0', 'e0')], nextBefore: 100 });
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    getTranscript.mockResolvedValueOnce({ events: [reply('page 1', 'e1')], nextBefore: 50 });
    await act(async () => result.current.loadOlder());
    getTranscript.mockResolvedValueOnce({ events: [reply('page 2', 'e2')], nextBefore: 20 });
    await act(async () => result.current.loadOlder());

    return result;
  }

  it('keeps only the page the session opened with', async () => {
    const result = await scrolledBack();
    expect(bodies(result.current.events)).toEqual(['page 2', 'page 1', 'page 0']);

    act(() => result.current.dropOlder());

    expect(bodies(result.current.events)).toEqual(['page 0']);
  });

  // Otherwise the next scroll up would fetch from where the discarded pages left off, and
  // splice a run of events on top of history that no longer reaches them.
  it('puts the cursor back to where the opening page left off', async () => {
    const result = await scrolledBack();

    act(() => result.current.dropOlder());

    getTranscript.mockResolvedValueOnce({ events: [reply('page 1', 'e1')], nextBefore: 50 });
    await act(async () => result.current.loadOlder());

    expect(getTranscript).toHaveBeenLastCalledWith('s1', 150, 100);
    expect(bodies(result.current.events)).toEqual(['page 1', 'page 0']);
  });

  it('says there is something to give back only once there is', async () => {
    getTranscript.mockResolvedValueOnce({ events: [reply('page 0', 'e0')], nextBefore: 100 });
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.extraPages).toBe(false);

    getTranscript.mockResolvedValueOnce({ events: [reply('page 1', 'e1')], nextBefore: 50 });
    await act(async () => result.current.loadOlder());

    expect(result.current.extraPages).toBe(true);
  });

  it('has nothing to give back once it has', async () => {
    const result = await scrolledBack();

    act(() => result.current.dropOlder());

    expect(result.current.extraPages).toBe(false);
  });

  // A page fetched to sit above history that is about to go would land with a hole beneath it.
  it('refuses while a page is still being fetched', async () => {
    const result = await scrolledBack();
    const pending = deferred();
    getTranscript.mockReturnValueOnce(pending.promise);

    act(() => result.current.loadOlder());
    act(() => result.current.dropOlder());

    expect(bodies(result.current.events)).toEqual(['page 2', 'page 1', 'page 0']);

    await act(async () => {
      pending.settle({ events: [reply('page 3', 'e3')], nextBefore: 10 });
    });

    expect(bodies(result.current.events)).toEqual(['page 3', 'page 2', 'page 1', 'page 0']);
  });

  it('leaves a session that never reached back alone', async () => {
    getTranscript.mockResolvedValueOnce({ events: [reply('page 0', 'e0')], nextBefore: null });
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    act(() => result.current.dropOlder());

    expect(bodies(result.current.events)).toEqual(['page 0']);
    expect(result.current.hasOlder).toBe(false);
  });

  // What has happened since the session was opened is not re-readable from anywhere.
  it('never touches what arrived live', async () => {
    const result = await scrolledBack();
    act(() => result.current.showSent('said just now'));

    act(() => result.current.dropOlder());

    expect(bodies(result.current.events)).toEqual(['page 0', 'said just now']);
  });
});
/**
 * A subagent's work is not this conversation, live any more than replayed.
 *
 * The replayed half is filtered in the sidecar, and for a while that was the only half: live
 * events are pushed straight to the timeline and never go near it, so a subagent running
 * right now still filled the conversation that delegated it while opening the same session
 * afterwards looked correct (#11).
 *
 * The streaming deltas matter most here. They are ephemeral, so they reach no log at all and
 * nothing read from disk could ever have caught them.
 */
describe('a subagent streaming into the session that delegated it', () => {
  beforeEach(() => {
    getTranscript.mockReset().mockResolvedValue({ events: [], truncated: false, nextBefore: null });
  });

  const live = (type: string, data: unknown, agentId?: string) =>
    ({ type, data, id: `${type}-${Math.random()}`, ...(agentId ? { agentId } : {}) }) as Parameters<
      ReturnType<typeof useTranscript>['push']
    >[0];

  it('keeps the subagent out of the conversation', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.push(live('assistant.message', { content: 'the session speaking' }));
      result.current.push(live('assistant.message', { content: 'a subagent speaking' }, 'agent-1'));
    });

    const said = result.current.events.map((e) => (e.data as { content?: string }).content);
    expect(said).toContain('the session speaking');
    expect(said).not.toContain('a subagent speaking');
  });

  it('keeps its streamed text out too, which reaches no log to be filtered from', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.push(live('assistant.message_delta', { messageId: 'm1', deltaContent: 'thinking aloud' }, 'agent-1'));
      result.current.push(live('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'reasoning' }, 'agent-1'));
    });

    expect(result.current.events).toHaveLength(0);
  });

  it('keeps its tool calls out', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.push(live('tool.execution_start', { toolName: 'powershell', toolCallId: 'c1' }, 'agent-1'));
      result.current.push(live('tool.execution_complete', { toolCallId: 'c1' }, 'agent-1'));
    });

    expect(result.current.events).toHaveLength(0);
  });

  /** The parent still has to say a task was delegated and how it went. */
  it('keeps the lifecycle, which is what the delegating row reports', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.push(live('subagent.started', { toolCallId: 'c1', agentName: 'explore' }, 'agent-1'));
      result.current.push(live('subagent.completed', { toolCallId: 'c1' }, 'agent-1'));
    });

    expect(result.current.events.map((e) => e.type)).toEqual(['subagent.started', 'subagent.completed']);
  });

  // The rows the app writes itself carry no agentId and must survive the same guard.
  it('still shows what the app puts there itself', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.showSent('a prompt');
      result.current.showLocal('command.output', { text: 'some output' });
    });

    expect(result.current.events).toHaveLength(2);
  });
});
