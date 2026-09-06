// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useQueue } from './useQueue';

const message = (id: string, prompt = `prompt ${id}`) => ({ id, prompt });

describe('useQueue', () => {
  it('has nothing waiting to begin with', () => {
    const { result } = renderHook(() => useQueue());
    expect(result.current.queues['s1']).toBeUndefined();
  });

  it('keeps queued messages in the order they were written', () => {
    const { result } = renderHook(() => useQueue());

    act(() => result.current.add('s1', message('a')));
    act(() => result.current.add('s1', message('b')));

    expect(result.current.queues['s1'].map((m) => m.id)).toEqual(['a', 'b']);
  });

  // Two sessions can both be running with something behind them.
  it('keeps each session\u2019s queue to itself', () => {
    const { result } = renderHook(() => useQueue());

    act(() => result.current.add('s1', message('a')));
    act(() => result.current.add('s2', message('b')));

    expect(result.current.queues['s1'].map((m) => m.id)).toEqual(['a']);
    expect(result.current.queues['s2'].map((m) => m.id)).toEqual(['b']);
  });

  it('drops a message once the runtime takes it', () => {
    const { result } = renderHook(() => useQueue());
    act(() => result.current.add('s1', message('a')));
    act(() => result.current.add('s1', message('b')));

    act(() => result.current.taken('s1', 'a'));

    expect(result.current.queues['s1'].map((m) => m.id)).toEqual(['b']);
  });

  // Every message arrives as a user.message, queued or not, so most ids mean nothing here.
  it('ignores an id it never queued', () => {
    const { result } = renderHook(() => useQueue());
    act(() => result.current.add('s1', message('a')));

    const before = result.current.queues;
    act(() => result.current.taken('s1', 'never-queued'));

    expect(result.current.queues).toBe(before);
  });

  it('does not take a message off another session\u2019s queue', () => {
    const { result } = renderHook(() => useQueue());
    act(() => result.current.add('s1', message('a')));

    act(() => result.current.taken('s2', 'a'));

    expect(result.current.queues['s1'].map((m) => m.id)).toEqual(['a']);
  });

  // Stopping a turn discards what was behind it, so nothing shown is still coming.
  it('empties a queue that will never be sent', () => {
    const { result } = renderHook(() => useQueue());
    act(() => result.current.add('s1', message('a')));
    act(() => result.current.add('s2', message('b')));

    act(() => result.current.clear('s1'));

    expect(result.current.queues['s1']).toEqual([]);
    expect(result.current.queues['s2'].map((m) => m.id)).toEqual(['b']);
  });

  // Clearing happens on every unload and every stop, most of them with nothing waiting.
  it('changes nothing when there was nothing to clear', () => {
    const { result } = renderHook(() => useQueue());
    const before = result.current.queues;

    act(() => result.current.clear('s1'));

    expect(result.current.queues).toBe(before);
  });

  // The handlers are given to a subscription that is registered once and would otherwise
  // hold the first render's copies forever.
  it('keeps one identity for its handlers across renders', () => {
    const { result, rerender } = renderHook(() => useQueue());
    const { add, taken, clear } = result.current;

    act(() => result.current.add('s1', message('a')));
    rerender();

    expect(result.current.add).toBe(add);
    expect(result.current.taken).toBe(taken);
    expect(result.current.clear).toBe(clear);
  });
});
