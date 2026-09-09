// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useDrafts } from './useDrafts';

describe('writing that has not been sent', () => {
  it('keeps each session\u2019s text to itself, so it cannot be sent to the wrong one', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'meant for one'));
    act(() => result.current.write('s2', 'meant for two'));

    expect(result.current.textOf('s1')).toBe('meant for one');
    expect(result.current.textOf('s2')).toBe('meant for two');
  });

  it('has nothing for a session never written in', () => {
    const { result } = renderHook(() => useDrafts());

    expect(result.current.textOf('s1')).toBe('');
  });

  it('has nothing when no session is selected', () => {
    const { result } = renderHook(() => useDrafts());

    expect(result.current.textOf(null)).toBe('');
    expect(result.current.hasStash(null)).toBe(false);
  });

  it('empties one session without touching another', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'one'));
    act(() => result.current.write('s2', 'two'));
    act(() => result.current.clear('s1'));

    expect(result.current.textOf('s1')).toBe('');
    expect(result.current.textOf('s2')).toBe('two');
  });
});

describe('handing back a message that failed to send', () => {
  it('puts it back when nothing has been typed since', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.suggest('s1', 'the one that failed'));

    expect(result.current.textOf('s1')).toBe('the one that failed');
  });

  /** Taking away what is being written to restore an older draft is the worse theft. */
  it('leaves anything typed in the meantime alone', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'started something else'));
    act(() => result.current.suggest('s1', 'the one that failed'));

    expect(result.current.textOf('s1')).toBe('started something else');
  });
});

describe('setting a prompt aside', () => {
  it('empties the box and remembers what was in it', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'wait your turn'));
    act(() => result.current.swap('s1'));

    expect(result.current.textOf('s1')).toBe('');
    expect(result.current.hasStash('s1')).toBe(true);
  });

  it('brings it back into an empty box', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'wait your turn'));
    act(() => result.current.swap('s1'));
    act(() => result.current.swap('s1'));

    expect(result.current.textOf('s1')).toBe('wait your turn');
    expect(result.current.hasStash('s1')).toBe(false);
  });

  /** The reason it is a swap: with one slot, stashing over a stash would lose writing. */
  it('trades the two rather than losing either', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'first thought'));
    act(() => result.current.swap('s1'));
    act(() => result.current.write('s1', 'second thought'));
    act(() => result.current.swap('s1'));

    expect(result.current.textOf('s1')).toBe('first thought');
    act(() => result.current.swap('s1'));
    expect(result.current.textOf('s1')).toBe('second thought');
  });

  it('does nothing at all when there is nothing on either side', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.swap('s1'));

    expect(result.current.textOf('s1')).toBe('');
    expect(result.current.hasStash('s1')).toBe(false);
  });

  it('is per session, like the box it swaps with', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'one'));
    act(() => result.current.swap('s1'));

    expect(result.current.hasStash('s2')).toBe(false);
  });
});

describe('reading the box from a handler registered once', () => {
  it('answers with what is there now, not what was there when it was registered', () => {
    const { result } = renderHook(() => useDrafts());
    const { written } = result.current;

    act(() => result.current.write('s1', 'typed later'));

    expect(written('s1')).toBe('typed later');
  });

  it('has nothing to report without a session', () => {
    const { result } = renderHook(() => useDrafts());

    expect(result.current.written(null)).toBe('');
  });
});
