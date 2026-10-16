// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummary, TranscriptEvent } from '../../shared/protocol';
import { useSessions } from './useSessions';
import { read, save } from './store';

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
    it('expires saved positions at seven days unloaded, keeping recent and legacy positions', async () => {
      const week = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      save('sessions', 'activeSessionOrder', JSON.stringify(['expired', 'recent', 'legacy']));
      save('sessions', 'activeSessionLastLoaded', JSON.stringify({ expired: now - week, recent: now - week + 60_000 }));
      const first = await listed();
      expect(JSON.parse(read('sessions', 'activeSessionOrder')!)).toEqual(['recent', 'legacy']);
      expect(JSON.parse(read('sessions', 'activeSessionLastLoaded')!)).toEqual({
        recent: now - week + 60_000, legacy: expect.any(Number),
      });
      first.unmount();
      const next = await listed();
      act(() => next.result.current.observeLoaded('expired', true));
      expect(JSON.parse(read('sessions', 'activeSessionOrder')!)).toEqual(['expired', 'recent', 'legacy']);
    });

    it('expires unloaded positions while open and checks expiry before reactivation', async () => {
      const week = 7 * 24 * 60 * 60 * 1000;
      save('sessions', 'activeSessionOrder', JSON.stringify(['s1', 's2']));
      listSessions.mockResolvedValue({ sessions: [summary('s1', { loaded: true }), summary('s2')] });
      const view = await listed();
      vi.useFakeTimers();
      try {
        act(() => view.result.current.observeLoaded('s2', true));
        act(() => view.result.current.observeLoaded('s2', false));
        const unloadedAt = Date.now();
        vi.setSystemTime(unloadedAt + week - 1);
        act(() => view.result.current.observeLoaded('s2', true));
        expect(JSON.parse(read('sessions', 'activeSessionOrder')!)).toEqual(['s1', 's2']);
        act(() => view.result.current.observeLoaded('s2', false));
        vi.setSystemTime(Date.now() + week);
        act(() => view.result.current.observeLoaded('s2', false, true));
        expect(JSON.parse(read('sessions', 'activeSessionOrder')!)).toEqual(['s2', 's1']);
        act(() => view.result.current.observeLoaded('s2', true));
        vi.setSystemTime(Date.now() + week);
        act(() => vi.advanceTimersByTime(60_000));
        expect(JSON.parse(read('sessions', 'activeSessionOrder')!)).toEqual(['s2', 's1']);
        act(() => view.result.current.observeLoaded('s2', false));
        vi.setSystemTime(Date.now() + week);
        act(() => vi.advanceTimersByTime(60_000));
        expect(JSON.parse(read('sessions', 'activeSessionOrder')!)).toEqual(['s1']);
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    });

    it('reorders only active sessions, leaving inactive sessions sorted by last usage', async () => {
      listSessions.mockResolvedValue({ sessions: [
        summary('a', { loaded: true }), summary('b', { loaded: true }), summary('c', { loaded: true }),
        summary('cold-old'), summary('cold-new', { updatedAt: '2026-02-01T00:00:00Z' }),
      ] });
      const { result } = await listed();
      act(() => result.current.reorder('c', 'a'));
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['c', 'a', 'b', 'cold-new', 'cold-old']);
      act(() => result.current.reorder('a', 'b', true));
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['c', 'b', 'a', 'cold-new', 'cold-old']);
      const stored = read('sessions', 'activeSessionOrder');
      act(() => result.current.reorder('cold-new', 'c'));
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['c', 'b', 'a', 'cold-new', 'cold-old']);
      expect(read('sessions', 'activeSessionOrder')).toBe(stored);
    });

    it('keeps a manually placed session slot through unloading and reactivation', async () => {
      listSessions.mockResolvedValue({ sessions: ['a', 'b', 'c'].map((id) => summary(id, { loaded: true })) });
      const { result } = await listed();
      act(() => result.current.reorder('c', 'b'));
      act(() => result.current.observeLoaded('c', false));
      expect(result.current.all.filter((s) => s.loaded).map((s) => s.sessionId)).toEqual(['a', 'b']);
      act(() => result.current.observeLoaded('c', true));
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['a', 'c', 'b']);
      act(() => result.current.observeLoaded('new', true));
      expect(JSON.parse(read('sessions', 'activeSessionOrder')!)).toEqual(['new', 'a', 'c', 'b']);
    });

    it('restores manual ordering after remounting', async () => {
      listSessions.mockResolvedValue({ sessions: ['a', 'b'].map((id) => summary(id, { loaded: true })) });
      const first = await listed();
      act(() => first.result.current.reorder('b', 'a'));
      first.unmount();
      const next = await listed();
      expect(next.result.current.all.map((s) => s.sessionId)).toEqual(['b', 'a']);
    });

    it('restores a remembered slot as soon as a session starts loading', async () => {
      save('sessions', 'activeSessionOrder', JSON.stringify(['s1', 's2']));
      const { result } = await listed();
      act(() => result.current.observeLoaded('s2', true));
      act(() => result.current.observeLoaded('s1', false, true));
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
      act(() => result.current.observeLoaded('s1', true));
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    });

    it('does not let saved inactive slots change cold-session recency order', async () => {
      save('sessions', 'activeSessionOrder', JSON.stringify(['s2', 's1']));
      const { result } = await listed();
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    });

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

describe('a session being resumed', () => {
  beforeEach(() => {
    listSessions.mockReset().mockResolvedValue({ sessions: [summary('s1'), summary('s2')] });
    runtimeStatus.mockReset().mockResolvedValue({ maxLoadedSessions: 3 });
  });

  it('says nothing to begin with', async () => {
    const { result } = await listed();

    expect([...result.current.loading]).toEqual([]);
  });

  it('holds it from the moment the resume starts', async () => {
    const { result } = await listed();

    act(() => result.current.observeLoaded('s1', false, true));

    expect([...result.current.loading]).toEqual(['s1']);
    // Not loaded yet: that is the whole point of a third state.
    expect(result.current.all.find((s) => s.sessionId === 's1')?.loaded).toBe(false);
  });

  it('lets go once the session is there', async () => {
    const { result } = await listed();
    act(() => result.current.observeLoaded('s1', false, true));

    act(() => result.current.observeLoaded('s1', true, false));

    expect([...result.current.loading]).toEqual([]);
    expect(result.current.all.find((s) => s.sessionId === 's1')?.loaded).toBe(true);
  });

  it('lets go when the resume fails, so a row does not pulse for ever', async () => {
    const { result } = await listed();
    act(() => result.current.observeLoaded('s1', false, true));

    act(() => result.current.observeLoaded('s1', false, false));

    expect([...result.current.loading]).toEqual([]);
    expect(result.current.all.find((s) => s.sessionId === 's1')?.loaded).toBe(false);
  });

  it('takes an unloading that says nothing about resuming', async () => {
    // Every other caller omits the argument, and omitting it must not mean "still loading".
    const { result } = await listed();
    act(() => result.current.observeLoaded('s1', false, true));

    act(() => result.current.observeLoaded('s1', false));

    expect([...result.current.loading]).toEqual([]);
  });

  it('keeps two apart', async () => {
    const { result } = await listed();

    act(() => result.current.observeLoaded('s1', false, true));
    act(() => result.current.observeLoaded('s2', false, true));
    act(() => result.current.observeLoaded('s1', true, false));

    expect([...result.current.loading]).toEqual(['s2']);
  });
});
/**
 * What a refresh hands back (#227).
 *
 * A caller that has just made a session needs to know whether the list has it, because a
 * session the list does not have is one the window cannot show - and used to be shown as
 * nothing at all, which looked like the button having failed.
 */
describe('what a refresh answers with', () => {
  it('hands back the list it just read', async () => {
    const { result } = await listed();

    let answered: unknown;
    await act(async () => {
      answered = await result.current.refresh();
    });

    expect((answered as { sessionId: string }[]).map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('answers with what a caller is looking for', async () => {
    listSessions.mockResolvedValue({ sessions: [summary('fresh')] });
    const { result } = await listed();

    let answered: unknown;
    await act(async () => {
      answered = await result.current.refresh();
    });

    expect((answered as { sessionId: string }[] | null)?.some((s) => s.sessionId === 'fresh')).toBe(true);
  });

  /**
   * A list that could not be read is not a list without the session in it. The failure has
   * already been reported as itself, and answering with an empty list would have the caller
   * report it again as something else.
   */
  it('answers with nothing at all when the list cannot be read', async () => {
    const { result } = await listed();
    listSessions.mockRejectedValue(new Error('no store'));

    let answered: unknown = 'unset';
    await act(async () => {
      answered = await result.current.refresh();
    });

    expect(answered).toBeNull();
  });
});
