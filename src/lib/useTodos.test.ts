// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Todo } from '../../shared/protocol';

const { sessionTodos } = vi.hoisted(() => ({ sessionTodos: vi.fn() }));
vi.mock('./sidecar', () => ({ sessionTodos: (id: string) => sessionTodos(id) }));

import { useTodos } from './useTodos';

const todo = (id: string): Todo => ({ id, title: `Todo ${id}`, status: 'pending', dependsOn: [] });

beforeEach(() => {
  vi.useFakeTimers();
  sessionTodos.mockReset().mockResolvedValue([todo('a')]);
});

afterEach(() => {
  vi.useRealTimers();
});

const watching = (sessionId: string | null = 's1', loaded = true) =>
  renderHook(({ id, up }: { id: string | null; up: boolean }) => useTodos(id, up), {
    initialProps: { id: sessionId, up: loaded },
  });

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

  /** Waking one to find out what it is planning would cost what this app exists to avoid. */
  it('does not ask a session that is not in memory', async () => {
    watching('s1', false);

    await settle();

    expect(sessionTodos).not.toHaveBeenCalled();
  });

  it('asks once it comes into memory', async () => {
    const view = watching('s1', false);

    await act(async () => {
      view.rerender({ id: 's1', up: true });
    });

    expect(sessionTodos).toHaveBeenCalledWith('s1');
  });

  it('asks again about a session the reader moves to', async () => {
    const view = watching();
    await settle();

    await act(async () => {
      view.rerender({ id: 's2', up: true });
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
      view.rerender({ id: 's2', up: true });
    });
    // The first call, which was about s1, answering after the reader has gone to s2.
    act(() => answers[0]!([todo('from-s1')]));
    await settle();

    expect(view.result.current.todos).toEqual([]);
  });
});
