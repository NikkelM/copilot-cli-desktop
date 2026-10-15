// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useUnseen } from './useUnseen';
import type { Blocking } from './activity';

const event = (type: string) => ({ type, data: {} });

const NONE: Blocking[] = [];

/** A session that worked and then settled, which is the only way a finish is recorded. */
const ranATurn = (observe: (id: string, e: ReturnType<typeof event>) => void, sessionId: string) => {
  observe(sessionId, event('assistant.turn_start'));
  observe(sessionId, event('session.idle'));
};

describe('useUnseen', () => {
  it('marks a session that finished a turn while the reader was elsewhere', () => {
    const { result } = renderHook(() => useUnseen('here', NONE));

    act(() => ranATurn(result.current.observe, 'away'));

    expect(result.current.marks).toEqual({ away: 'finished' });
  });

  /**
   * The whole point of the hook. `session.idle` arrives when a session settles, which
   * includes settling after a resume, so without a turn to end every session the reader
   * opened would claim to have finished something.
   */
  it('says nothing about a session that settled without working', () => {
    const { result } = renderHook(() => useUnseen('here', NONE));

    act(() => result.current.observe('away', event('session.idle')));

    expect(result.current.marks).toEqual({});
  });

  it('does not mark the session being read, which the reader can already see', () => {
    const { result } = renderHook(() => useUnseen('here', NONE));

    act(() => ranATurn(result.current.observe, 'here'));

    expect(result.current.marks).toEqual({});
  });

  /**
   * A turn watched to the end stays watched. Without the guard where the mark is recorded,
   * nothing would be stored only while the session stayed selected, and the finish the
   * reader sat through would appear the moment they went elsewhere.
   */
  it('still says nothing about a turn the reader watched end, once they move on', () => {
    const view = renderHook(({ id }: { id: string }) => useUnseen(id, NONE), {
      initialProps: { id: 'here' },
    });

    act(() => ranATurn(view.result.current.observe, 'here'));
    view.rerender({ id: 'elsewhere' });

    expect(view.result.current.marks).toEqual({});
  });

  /**
   * A turn is many round trips when it calls tools, and `assistant.turn_end` fires at every
   * one of them. Marking on that would report a finish in the middle of the work.
   */
  it('ignores the end of a round trip inside a turn', () => {
    const { result } = renderHook(() => useUnseen('here', NONE));

    act(() => {
      result.current.observe('away', event('assistant.turn_start'));
      result.current.observe('away', event('assistant.turn_end'));
    });

    expect(result.current.marks).toEqual({});
  });

  it('marks a turn that ended in an error as failed', () => {
    const { result } = renderHook(() => useUnseen('here', NONE));

    act(() => {
      result.current.observe('away', event('assistant.turn_start'));
      result.current.observe('away', event('session.error'));
    });

    expect(result.current.marks).toEqual({ away: 'failed' });
  });

  /** An error needs no turn in flight, because it is worth reporting however it arrived. */
  it('marks a failure even with no turn seen to start', () => {
    const { result } = renderHook(() => useUnseen('here', NONE));

    act(() => result.current.observe('away', event('session.error')));

    expect(result.current.marks).toEqual({ away: 'failed' });
  });

  it('keeps a failure when the session settles afterwards', () => {
    const { result } = renderHook(() => useUnseen('here', NONE));

    act(() => {
      result.current.observe('away', event('assistant.turn_start'));
      result.current.observe('away', event('session.error'));
      ranATurn(result.current.observe, 'away');
    });

    expect(result.current.marks).toEqual({ away: 'failed' });
  });

  it('records nothing for a turn the reader stopped', () => {
    const { result } = renderHook(() => useUnseen('here', NONE));

    act(() => {
      result.current.observe('away', event('assistant.turn_start'));
      result.current.observe('away', event('abort'));
      result.current.observe('away', event('session.idle'));
    });

    expect(result.current.marks).toEqual({});
  });

  it('forgets what a session did once the reader looks at it', () => {
    const view = renderHook(({ id }: { id: string }) => useUnseen(id, NONE), {
      initialProps: { id: 'here' },
    });

    act(() => ranATurn(view.result.current.observe, 'away'));
    expect(view.result.current.marks).toEqual({ away: 'finished' });

    view.rerender({ id: 'away' });

    expect(view.result.current.marks).toEqual({});
  });

  /** Seen is seen: looking away again should not bring back what was already read. */
  it('does not bring a mark back when the reader moves on', () => {
    const view = renderHook(({ id }: { id: string }) => useUnseen(id, NONE), {
      initialProps: { id: 'here' },
    });

    act(() => ranATurn(view.result.current.observe, 'away'));
    view.rerender({ id: 'away' });
    view.rerender({ id: 'here' });

    expect(view.result.current.marks).toEqual({});
  });

  it('drops a session that no longer exists', () => {
    const { result } = renderHook(() => useUnseen('here', NONE));

    act(() => ranATurn(result.current.observe, 'away'));
    act(() => result.current.forget('away'));

    expect(result.current.marks).toEqual({});
  });

  describe('being blocked', () => {
    it('marks a session with a prompt nobody has answered', () => {
      const { result } = renderHook(() => useUnseen('here', [{ sessionId: 'away' }]));

      expect(result.current.marks).toEqual({ away: 'blocked' });
    });

    it('says nothing about the blocked session the reader is looking at', () => {
      const { result } = renderHook(() => useUnseen('away', [{ sessionId: 'away' }]));

      expect(result.current.marks).toEqual({});
    });

    /**
     * Read rather than remembered, so a question answered from another window stops
     * blocking the moment the prompt goes, instead of leaving a mark nothing can clear.
     */
    it('stops marking as soon as the prompt is gone', () => {
      const view = renderHook(({ pending }: { pending: Blocking[] }) => useUnseen('here', pending), {
        initialProps: { pending: [{ sessionId: 'away' }] },
      });
      expect(view.result.current.marks).toEqual({ away: 'blocked' });

      view.rerender({ pending: [] });

      expect(view.result.current.marks).toEqual({});
    });

    /**
     * Looking at a blocked session and leaving without answering means it is still owed,
     * which is the one case a remembered mark would get wrong in the other direction.
     */
    it('marks it again when the reader leaves without answering', () => {
      const view = renderHook(({ id }: { id: string }) => useUnseen(id, [{ sessionId: 'away' }]), {
        initialProps: { id: 'away' },
      });
      expect(view.result.current.marks).toEqual({});

      view.rerender({ id: 'here' });

      expect(view.result.current.marks).toEqual({ away: 'blocked' });
    });

    it('outranks a finish, because it is the one asking for something now', () => {
      const view = renderHook(({ pending }: { pending: Blocking[] }) => useUnseen('here', pending), {
        initialProps: { pending: [] as Blocking[] },
      });

      act(() => ranATurn(view.result.current.observe, 'away'));
      view.rerender({ pending: [{ sessionId: 'away' }] });

      expect(view.result.current.marks).toEqual({ away: 'blocked' });
    });
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
 */
describe('the identity App subscribes with', () => {
  it('survives the reader moving to another session', () => {
    const view = renderHook(({ id }: { id: string }) => useUnseen(id, NONE), {
      initialProps: { id: 's1' },
    });
    const { observe } = view.result.current;

    view.rerender({ id: 's2' });

    expect(view.result.current.observe).toBe(observe);
  });
});
