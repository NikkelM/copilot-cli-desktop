// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Todo } from '../../shared/protocol';

const { sessionTodos } = vi.hoisted(() => ({ sessionTodos: vi.fn() }));
vi.mock('./sidecar', () => ({ sessionTodos: (id: string) => sessionTodos(id) }));

import { useTodos } from './useTodos';

/** The hook's own debounce, which these tests have to outwait. */
const SETTLE_MS = 150;

const todo = (id: string): Todo => ({ id, title: `Todo ${id}`, status: 'pending', dependsOn: [] });

beforeEach(() => {
  vi.useFakeTimers();
  sessionTodos.mockReset().mockResolvedValue([todo('a')]);
});

afterEach(() => {
  vi.useRealTimers();
});

const watching = (sessionId: string | null = 's1') =>
  renderHook(({ id }: { id: string | null }) => useTodos(id), { initialProps: { id: sessionId } });

/** Let a resolved promise reach the hook while the clock is held still. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/**
 * The agent's own todo list (#172).
 *
 * The event announcing a change carries no payload and never reaches the log, so the only
 * account of the list is the running session's database and the only way to have it is to
 * ask.
 */
describe('keeping up with the agent’s todo list', () => {
  it('asks as soon as there is a session to ask about', async () => {
    watching();

    await settle();

    expect(sessionTodos).toHaveBeenCalledWith('s1');
  });

  it('hands back what the session said', async () => {
    const { result } = watching();

    await settle();

    expect(result.current.todos).toEqual([todo('a')]);
  });

  it('asks about nothing when no session is open', async () => {
    watching(null);

    await settle();

    expect(sessionTodos).not.toHaveBeenCalled();
  });

  /**
   * The case that started this: a session nobody has woken still has a list, because it is
   * read from the session's database on disk rather than from a running session.
   */
  it('asks about a session that is not in memory', async () => {
    watching();

    await settle();

    expect(sessionTodos).toHaveBeenCalledWith('s1');
  });

  it('asks again about a session the reader moves to', async () => {
    const view = watching();
    await settle();

    await act(async () => {
      view.rerender({ id: 's2' });
    });

    expect(sessionTodos).toHaveBeenLastCalledWith('s2');
  });

  describe('when the table is written to', () => {
    /**
     * Planning a piece of work writes a row per todo in a burst, so a plan of a dozen items
     * announces itself a dozen times in as many milliseconds. The SDK says as much where it
     * declares the event: clients can debounce on arrival.
     */
    it('reads once for a burst of changes', async () => {
      const { result } = watching();
      await settle();
      sessionTodos.mockClear();

      act(() => {
        result.current.changed();
        result.current.changed();
        result.current.changed();
      });
      act(() => void vi.advanceTimersByTime(200));

      expect(sessionTodos).toHaveBeenCalledTimes(1);
    });

    it('waits rather than reading the moment it is told', async () => {
      const { result } = watching();
      await settle();
      sessionTodos.mockClear();

      act(() => result.current.changed());

      expect(sessionTodos).not.toHaveBeenCalled();
    });

    it('does read, once the writing has stopped', async () => {
      const { result } = watching();
      await settle();
      sessionTodos.mockClear();

      act(() => result.current.changed());
      act(() => void vi.advanceTimersByTime(200));

      expect(sessionTodos).toHaveBeenCalledWith('s1');
    });

    it('shows what the list now says', async () => {
      const { result } = watching();
      await settle();
      sessionTodos.mockResolvedValue([todo('a'), todo('b')]);

      act(() => result.current.changed());
      act(() => void vi.advanceTimersByTime(200));
      await settle();

      expect(result.current.todos).toHaveLength(2);
    });
  });

  /**
   * A list is the agent's account of its own work rather than a record of anything, so a
   * failure to read it is not worth interrupting anybody over.
   */
  it('shows no list rather than an error when it cannot be read', async () => {
    sessionTodos.mockRejectedValue(new Error('gone'));
    const { result } = watching();

    await settle();

    expect(result.current.todos).toEqual([]);
  });

  /** Another session's list is worse than none: it would be read as this one's. */
  it('drops an answer that arrives after the reader has moved on', async () => {
    // One resolver per call, so answering the first cannot be mistaken for answering the
    // second - which is what made an earlier version of this test pass for the wrong reason.
    const answers: ((todos: Todo[]) => void)[] = [];
    sessionTodos.mockImplementation(() => new Promise<Todo[]>((resolve) => answers.push(resolve)));
    const view = watching();

    await act(async () => {
      view.rerender({ id: 's2' });
    });
    // The first call, which was about s1, answering after the reader has gone to s2.
    act(() => answers[0]!([todo('from-s1')]));
    await settle();

    expect(view.result.current.todos).toEqual([]);
  });
});

/**
 * The announcement is subscribed to once, when the app starts, so whatever `changed` was
 * then is the one that answers for the rest of the run.
 *
 * At that moment there is no session open. A `changed` built around a captured `sessionId`
 * was therefore built around `null`, and every announcement from the agent ran the branch
 * that empties the list - taking the Todos button with it, since the header draws that only
 * where there is something in the list. The live half of #172 had never worked.
 *
 * Held on purpose rather than taken fresh: a test that calls `result.current.changed()` is
 * by construction calling the newest one, which is exactly the version that was never the
 * problem.
 */
describe('the callback the event subscription is holding', () => {
  it('reads the session open now, not the one open when it was made', async () => {
    const view = watching(null);
    // Kept as the app keeps it: taken once, never taken again.
    const held = view.result.current.changed;

    view.rerender({ id: 's1' });
    await settle();
    expect(view.result.current.todos).toHaveLength(1);

    sessionTodos.mockResolvedValue([todo('a'), todo('b')]);
    act(() => held());
    await act(async () => void vi.advanceTimersByTime(SETTLE_MS));
    await settle();

    expect(sessionTodos).toHaveBeenLastCalledWith('s1');
    expect(view.result.current.todos).toHaveLength(2);
  });

  /** And it keeps up with the reader, rather than answering for wherever it was made. */
  it('follows the reader from one session to another', async () => {
    const view = watching('s1');
    const held = view.result.current.changed;

    view.rerender({ id: 's2' });
    await settle();

    act(() => held());
    await act(async () => void vi.advanceTimersByTime(SETTLE_MS));
    await settle();

    expect(sessionTodos).toHaveBeenLastCalledWith('s2');
  });

  /** With nothing open there is nothing to ask about, which is the only time it empties. */
  it('asks nothing when no session is open', async () => {
    const view = watching(null);
    sessionTodos.mockClear();

    act(() => view.result.current.changed());
    await act(async () => void vi.advanceTimersByTime(SETTLE_MS));

    expect(sessionTodos).not.toHaveBeenCalled();
    expect(view.result.current.todos).toEqual([]);
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
  it('survives the reader moving to another session', () => {
    const view = watching('s1');
    const { changed } = view.result.current;

    view.rerender({ id: 's2' });

    expect(view.result.current.changed).toBe(changed);
  });
});