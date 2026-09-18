// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummary, TranscriptEvent } from '../../shared/protocol';
import { useSessions } from './useSessions';

const { listSessions, runtimeStatus } = vi.hoisted(() => ({
  listSessions: vi.fn(),
  runtimeStatus: vi.fn(),
}));

vi.mock('./sidecar', () => ({ listSessions, runtimeStatus }));

function summary(sessionId: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    title: sessionId,
    cwd: null,
    repository: null,
    branch: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    loaded: false,
    ...over,
  };
}

/** Mount, and wait for the first fetch to land so a test does not assert on an empty list. */
async function listed(onError = vi.fn()) {
  const hook = renderHook(() => useSessions(onError));
  await waitFor(() => expect(hook.result.current.all.length).toBeGreaterThan(0));
  return hook;
}

describe('useSessions', () => {
  beforeEach(() => {
    listSessions.mockReset().mockResolvedValue({ sessions: [summary('s1'), summary('s2')] });
    runtimeStatus.mockReset().mockResolvedValue({ maxLoadedSessions: 3 });
  });

  it('reads the list once it is mounted', async () => {
    const { result } = await listed();
    expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('asks how many sessions may be resident, so the sidebar can say', async () => {
    const { result } = await listed();
    await waitFor(() => expect(result.current.maxLoaded).toBe(3));
  });

  it('reports a failed read rather than showing an empty sidebar silently', async () => {
    const onError = vi.fn();
    listSessions.mockRejectedValue(new Error('no store'));
    renderHook(() => useSessions(onError));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('no store')));
  });

  it('finds nothing for a session it does not carry', async () => {
    const { result } = await listed();
    expect(result.current.find('nope')).toBeNull();
    expect(result.current.find(null)).toBeNull();
  });


  describe('the active group', () => {
    it('puts a session that wakes at the top', async () => {
      const { result } = await listed();

      act(() => result.current.observeLoaded('s2', true));

      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s2', 's1']);
      expect(result.current.find('s2')?.loaded).toBe(true);
    });

    /** Sending a message must not shuffle the sidebar under the reader's cursor. */
    it('leaves an already active session where it is', async () => {
      const { result } = await listed();
      act(() => result.current.observeLoaded('s1', true));
      act(() => result.current.observeLoaded('s2', true));
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s2', 's1']);

      act(() => result.current.observeLoaded('s2', true));

      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    });

    it('drops a session from the group when it is let go', async () => {
      const { result } = await listed();
      act(() => result.current.observeLoaded('s2', true));

      act(() => result.current.observeLoaded('s2', false));

      expect(result.current.find('s2')?.loaded).toBe(false);
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    });
  });
});


/**
 * Which sessions have a turn running (#115). Tracked here because this is the one place
 * that sees every session's events; the app's own busy flag covers only the open one.
 */
describe('what each session is doing', () => {
  const fired = (type: string): TranscriptEvent =>
    ({ type, timestamp: '2026-01-02T00:00:01.000Z', data: {} }) as TranscriptEvent;

  it('starts with nothing running', async () => {
    const { result } = await listed();
    expect([...result.current.working]).toEqual([]);
  });

  it('takes a turn starting', async () => {
    const { result } = await listed();
    act(() => result.current.observe('s1', fired('assistant.turn_start')));
    expect([...result.current.working]).toEqual(['s1']);
  });

  it('takes a session going idle', async () => {
    const { result } = await listed();
    act(() => result.current.observe('s1', fired('assistant.turn_start')));
    act(() => result.current.observe('s1', fired('session.idle')));
    expect([...result.current.working]).toEqual([]);
  });

  it('takes a turn being stopped', async () => {
    const { result } = await listed();
    act(() => result.current.observe('s1', fired('assistant.turn_start')));
    act(() => result.current.observe('s1', fired('abort')));
    expect([...result.current.working]).toEqual([]);
  });

  /**
   * A request calling tools ends and starts turns many times over, and the gaps between
   * them are not idleness. Only session.idle means the request is finished.
   */
  it('stays running across the turn ends inside one request', async () => {
    const { result } = await listed();
    act(() => result.current.observe('s1', fired('assistant.turn_start')));
    act(() => result.current.observe('s1', fired('assistant.turn_end')));
    expect([...result.current.working]).toEqual(['s1']);
  });

  it('forgets a session let go mid-turn, which will send no idle event', async () => {
    const { result } = await listed();
    act(() => result.current.observe('s1', fired('assistant.turn_start')));
    act(() => result.current.observeLoaded('s1', false));
    expect([...result.current.working]).toEqual([]);
  });

  it('keeps sessions apart', async () => {
    const { result } = await listed();
    act(() => result.current.observe('s1', fired('assistant.turn_start')));
    act(() => result.current.observe('s2', fired('assistant.turn_start')));
    act(() => result.current.observe('s1', fired('session.idle')));
    expect([...result.current.working]).toEqual(['s2']);
  });
});

describe('taking a session out of the list before disk agrees', () => {
  beforeEach(() => {
    listSessions.mockReset().mockResolvedValue({ sessions: [summary('s1'), summary('s2')] });
    runtimeStatus.mockReset().mockResolvedValue({ maxLoadedSessions: 3 });
  });

  it('hides it at once, without waiting for a fetch', async () => {
    const { result } = await listed();

    act(() => result.current.drop('s1'));

    expect(result.current.all.map((s) => s.sessionId)).toEqual(['s2']);
    // Nothing was asked for: the point is not to wait on anything.
    expect(listSessions).toHaveBeenCalledOnce();
  });

  it('keeps it hidden through a fetch that still finds it on disk', async () => {
    // Deleting a large session takes a while, and the store watcher can refetch during it.
    const { result } = await listed();
    act(() => result.current.drop('s1'));

    await act(() => result.current.refresh());

    expect(result.current.all.map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('puts it back when whatever was removing it did not', async () => {
    const { result } = await listed();
    act(() => result.current.drop('s1'));

    act(() => result.current.restore('s1'));

    expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('stops holding a note about a session that has genuinely gone', async () => {
    const { result } = await listed();
    act(() => result.current.drop('s1'));

    listSessions.mockResolvedValue({ sessions: [summary('s2')] });
    await act(() => result.current.refresh());
    // Back on disk under the same id: without the prune the stale note would hide it.
    listSessions.mockResolvedValue({ sessions: [summary('s1'), summary('s2')] });
    await act(() => result.current.refresh());

    expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('leaves the rest of the list alone', async () => {
    const { result } = await listed();

    act(() => result.current.drop('nobody-by-that-name'));

    expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });
});
