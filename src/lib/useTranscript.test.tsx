// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';

import { useTranscript } from './useTranscript';
import { toEntries } from './transcriptEntries';
import { showsInTranscript } from '../../shared/protocol';

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
/**
 * #186: a sitting only ever appends to the live list, so anything held is held for as long
 * as the session stays open. Most of what a long session receives are turn markers, hook
 * markers and session bookkeeping with no row in the transcript - held at roughly 2 kB
 * each, walked on every chunk, and drawn never.
 */
describe('useTranscript holding only what the transcript shows', () => {
  const marker = (type: string, id: string) => ({ type, data: {}, id });
  const said = (content: string, id: string) => ({ type: 'assistant.message', data: { content }, id });

  beforeEach(() => {
    getTranscript.mockReset();
    getTranscript.mockResolvedValue({ events: [], nextBefore: null });
  });

  it.each([
    ['assistant.turn_start', 'a turn marker the busy clock reads as it passes'],
    ['assistant.turn_end', 'the other turn marker'],
    ['hook.start', 'a hook firing'],
    ['hook.end', 'a hook finishing'],
    ['session.plan_changed', 'session bookkeeping, which history never held either'],
    ['session.binary_asset', 'an asset the transcript has no row for'],
    ['system.message', 'the commonest of them'],
  ])('does not hold %s: %s', async (type) => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    act(() => result.current.push(marker(type, 'x1')));

    expect(result.current.events).toEqual([]);
  });

  it('holds what the transcript shows, so the drop is about the type and not about pushing', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    act(() => result.current.push(marker('assistant.turn_start', 'x1')));
    act(() => result.current.push(said('an answer', 'e1')));
    act(() => result.current.push(marker('assistant.turn_end', 'x2')));

    expect(result.current.events.map((event) => event.id)).toEqual(['e1']);
  });

  /**
   * The same rule the sidecar reads history through, or the two would disagree about what a
   * transcript is: an event dropped from every page fetched from the log but kept forever
   * when it arrived live.
   */
  it('keeps exactly what a page read from the log would have kept', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    const arriving = [
      marker('assistant.turn_start', 'x1'),
      { type: 'user.message', data: { content: 'a question' }, id: 'e1' },
      marker('session.plan_changed', 'x2'),
      said('an answer', 'e2'),
      marker('hook.end', 'x3'),
    ];
    for (const event of arriving) act(() => result.current.push(event));

    expect(result.current.events.map((event) => event.id)).toEqual(
      arriving.filter((event) => showsInTranscript(event.type)).map((event) => event.id),
    );
  });

  // What is held is what is drawn, so the rows must come out the same as before.
  it('draws the same rows as holding everything would have', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    const all = [
      marker('assistant.turn_start', 'x1'),
      { type: 'user.message', data: { content: 'a question' }, id: 'e1' },
      marker('hook.start', 'x2'),
      said('an answer', 'e2'),
      marker('hook.end', 'x3'),
      marker('assistant.turn_end', 'x4'),
    ];
    for (const event of all) act(() => result.current.push(event));

    expect(toEntries(result.current.events, null)).toEqual(toEntries(all, null));
  });

  /**
   * The one interaction that could have broken: a stopped turn is rescued by scanning the
   * live list backwards, and a turn always ends with markers after the last delta.
   */
  it('still rescues a stopped reply with markers interleaved', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    act(() => result.current.push(marker('assistant.turn_start', 'x1')));
    act(() =>
      result.current.push({
        type: 'assistant.message_delta',
        data: { messageId: 'm1', deltaContent: 'half a thought' },
        id: 'd1',
      }),
    );
    act(() => result.current.push(marker('hook.start', 'x2')));
    act(() => result.current.push({ type: 'abort', data: { reason: 'user_initiated' }, id: 'a1' }));

    expect(result.current.abandoned?.get('a1')).toBe('half a thought');
  });

  // A row this app invented is not an event, so it does not go through the same gate.
  it('still shows a prompt before the runtime has echoed it', async () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));
    await waitFor(() => expect(getTranscript).toHaveBeenCalled());

    act(() => result.current.showSent('do the thing'));

    expect(result.current.events).toHaveLength(1);
  });
});

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
 * A subagent's work is nested inside the row that delegated it, so a delegating turn can be
 * watched as it happens rather than reported once it is over (#11).
 *
 * The streaming deltas matter most here. They are ephemeral, so they reach no log at all and
 * nothing verified by replaying a session could ever have covered them.
 */
describe('a subagent streaming into the session that delegated it', () => {
  beforeEach(() => {
    getTranscript.mockReset().mockResolvedValue({ events: [], nextBefore: null });
  });

  const live = (type: string, data: unknown, agentId?: string) =>
    ({ type, data, id: `${type}-${Math.random()}`, ...(agentId ? { agentId } : {}) }) as Parameters<
      ReturnType<typeof useTranscript>['push']
    >[0];

  /** The parent keeps its own thread: the subagent's rows belong to the task, not the flow. */
  it('keeps the subagent out of the parent flow', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.push(live('tool.execution_start', { toolName: 'task', toolCallId: 'c1' }));
      result.current.push(live('subagent.started', { toolCallId: 'c1', agentName: 'explore' }, 'agent-1'));
      result.current.push(live('assistant.message', { content: 'a subagent speaking' }, 'agent-1'));
      result.current.push(live('assistant.message', { content: 'the session speaking' }));
    });

    const entries = toEntries(result.current.events, null);
    const bodies = entries.flatMap((e) => (e.kind === 'message' ? [e.body] : []));
    expect(bodies).toContain('the session speaking');
    expect(bodies).not.toContain('a subagent speaking');
  });

  it('nests the subagent inside the row that delegated it', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.push(live('tool.execution_start', { toolName: 'task', toolCallId: 'c1' }));
      result.current.push(live('subagent.started', { toolCallId: 'c1', agentName: 'explore' }, 'agent-1'));
      result.current.push(live('assistant.message', { content: 'a subagent speaking' }, 'agent-1'));
    });

    const task = toEntries(result.current.events, null).find((e) => e.kind === 'tool');
    expect(task?.children?.some((c) => c.kind === 'message' && c.body === 'a subagent speaking')).toBe(true);
  });

  /** These reach no log, so replaying a session could never have shown them arriving. */
  it('carries its streamed text, which nothing read from disk would have', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.push(live('tool.execution_start', { toolName: 'task', toolCallId: 'c1' }));
      result.current.push(live('subagent.started', { toolCallId: 'c1', agentName: 'explore' }, 'agent-1'));
      result.current.push(
        live('assistant.message_delta', { messageId: 'm1', deltaContent: 'thinking aloud' }, 'agent-1'),
      );
    });

    const task = toEntries(result.current.events, null).find((e) => e.kind === 'tool');
    expect(task?.children?.some((c) => c.kind === 'message' && c.body.includes('thinking aloud'))).toBe(true);
  });

  it('nests its tool calls too', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.push(live('tool.execution_start', { toolName: 'task', toolCallId: 'c1' }));
      result.current.push(live('subagent.started', { toolCallId: 'c1', agentName: 'explore' }, 'agent-1'));
      result.current.push(live('tool.execution_start', { toolName: 'powershell', toolCallId: 'c2' }, 'agent-1'));
    });

    const task = toEntries(result.current.events, null).find((e) => e.kind === 'tool');
    expect(task?.children?.some((c) => c.kind === 'tool')).toBe(true);
  });

  // The rows the app writes itself carry no agentId and belong to the conversation.
  it('still shows what the app puts there itself', () => {
    const { result } = renderHook(() => useTranscript('s1', () => {}));

    act(() => {
      result.current.showSent('a prompt');
      result.current.showLocal('command.output', { text: 'some output' });
    });

    expect(result.current.events).toHaveLength(2);
  });
});

/**
 * A session whose log no longer starts where a run does cannot be reopened by the CLI, and
 * says nothing about it: it draws an empty transcript, which is what a new session draws
 * (#196). The hook carries the answer so the window can say so on arrival.
 */
describe('a session that cannot be opened again', () => {
  it('assumes it can until the log says otherwise', () => {
    getTranscript.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useTranscript('s1', () => {}));

    expect(result.current.reopenable).toBe(true);
  });

  it('says so when the log has lost its start', async () => {
    getTranscript.mockResolvedValue({ events: [], nextBefore: null, reopenable: false });

    const { result } = renderHook(() => useTranscript('s1', () => {}));

    await waitFor(() => expect(result.current.reopenable).toBe(false));
  });

  it('says nothing is wrong when the log still has one', async () => {
    getTranscript.mockResolvedValue({ events: [reply('here', 'e1')], nextBefore: null, reopenable: true });

    const { result } = renderHook(() => useTranscript('s1', () => {}));

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.reopenable).toBe(true);
  });

  /** A sidecar older than this window does not answer, which is not an answer of no. */
  it('says nothing is wrong when the sidecar never mentions it', async () => {
    getTranscript.mockResolvedValue({ events: [reply('here', 'e1')], nextBefore: null });

    const { result } = renderHook(() => useTranscript('s1', () => {}));

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.reopenable).toBe(true);
  });

  // Or the warning would follow the reader to the next session they looked at.
  it('stops saying so once another session is chosen', async () => {
    getTranscript.mockResolvedValue({ events: [], nextBefore: null, reopenable: false });
    const { result, rerender } = renderHook(({ id }) => useTranscript(id, () => {}), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(result.current.reopenable).toBe(false));

    // Nothing comes back for the next one, so the only thing that can clear the warning is
    // choosing it. Left to the fetch, the new session would wear the old one's warning for
    // as long as its log took to read.
    getTranscript.mockReturnValue(new Promise(() => {}));
    rerender({ id: 's2' });

    expect(result.current.reopenable).toBe(true);
  });
});

/**
 * A search result opens a session partway back rather than at its end (#30), so the cursor
 * is part of what decides which page is read.
 */
describe('opening at a turn somebody went looking for', () => {
  beforeEach(() => {
    getTranscript.mockReset().mockResolvedValue({ events: [], nextBefore: null });
  });

  it('reads from the end when nothing sent it elsewhere', async () => {
    renderHook(() => useTranscript('s', () => {}));

    await waitFor(() => expect(getTranscript).toHaveBeenCalled());
    expect(getTranscript.mock.calls[0][2]).toBeUndefined();
  });

  it('reads back from the cursor it is given', async () => {
    renderHook(() => useTranscript('s', () => {}, 4096));

    await waitFor(() => expect(getTranscript).toHaveBeenCalled());
    expect(getTranscript.mock.calls[0][2]).toBe(4096);
  });

  // Going back to the end is the cursor being taken away, and has to re-read.
  it('reads the end again once the cursor is dropped', async () => {
    const { rerender } = renderHook(({ at }) => useTranscript('s', () => {}, at), {
      initialProps: { at: 4096 as number | null },
    });
    await waitFor(() => expect(getTranscript).toHaveBeenCalledTimes(1));

    rerender({ at: null });

    await waitFor(() => expect(getTranscript).toHaveBeenCalledTimes(2));
    expect(getTranscript.mock.calls[1][2]).toBeUndefined();
  });

  it('does not re-read when the cursor has not moved', async () => {
    const { rerender } = renderHook(({ at }) => useTranscript('s', () => {}, at), {
      initialProps: { at: 4096 as number | null },
    });
    await waitFor(() => expect(getTranscript).toHaveBeenCalledTimes(1));

    rerender({ at: 4096 });

    expect(getTranscript).toHaveBeenCalledTimes(1);
  });
});

/**
 * Clearing the page in an effect leaves one render where the previous conversation is on
 * screen under the new session's name. Everything downstream believed it: a search result
 * looked for its words in the session before, and had answered by the time the right page
 * arrived (#30).
 */
describe('whose conversation is on screen', () => {
  beforeEach(() => {
    getTranscript.mockReset();
  });

  it('shows nothing of the session just left, even before the next page arrives', async () => {
    getTranscript.mockResolvedValue({
      events: [reply('from the first session', 'a')],
      nextBefore: null,
    });

    /**
     * What each render was handed, rather than what settled afterwards.
     *
     * The page used to be cleared by an effect, and effects run after the render that
     * changed the session - so the wrong conversation was on screen for exactly one render,
     * which is the one a child effect reads. Anything that waits for things to settle cannot
     * see it.
     */
    const seen: string[][] = [];
    const Probe = ({ id }: { id: string }) => {
      const transcript = useTranscript(id, () => {});
      seen.push(bodies(transcript.events) as string[]);
      return null;
    };

    const { rerender } = render(<Probe id="one" />);
    await waitFor(() => expect(seen[seen.length - 1]).toEqual(['from the first session']));

    getTranscript.mockResolvedValue({ events: [reply('from the second', 'b')], nextBefore: null });
    const before = seen.length;
    rerender(<Probe id="two" />);

    const renders = seen.slice(before);
    expect(renders[0], 'the page belongs to the session it was read for').toEqual([]);
    expect(renders.some((r) => r.includes('from the first session'))).toBe(false);
  });

  it('shows the new page once it arrives', async () => {
    getTranscript.mockResolvedValue({ events: [reply('from the second', 'b')], nextBefore: null });
    const { result, rerender } = renderHook(({ id }) => useTranscript(id, () => {}), {
      initialProps: { id: 'one' },
    });
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    rerender({ id: 'two' });
    await waitFor(() => expect(bodies(result.current.events)).toEqual(['from the second']));
  });
});

/**
 * App subscribes to the runtime once, when it starts, and holds whatever callbacks it was
 * given then for the rest of the run. One that changes identity when the reader opens
 * another session is therefore one the subscription will never be handed again: it goes on
 * answering for whichever session was open at the moment the app started, which was none.
 *
 * That is how the live half of the todo list came to have never worked. The rule is cheap to
 * state and cheap to check, so it is checked here rather than left to be remembered.
 */describe('the identity App subscribes with', () => {
  beforeEach(() => {
    getTranscript.mockReset().mockResolvedValue({ events: [], nextBefore: null });
  });

  it('survives the reader moving to another session', () => {
    const view = renderHook(({ id }: { id: string }) => useTranscript(id, () => {}), {
      initialProps: { id: 's1' },
    });
    const { push } = view.result.current;

    view.rerender({ id: 's2' });

    expect(view.result.current.push).toBe(push);
  });
});