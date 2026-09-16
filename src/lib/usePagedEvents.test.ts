// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PAGE, usePagedEvents } from './usePagedEvents';
import type { TranscriptEvent } from '../../shared/protocol';

const many = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ type: 'assistant.message', id: `e${index}`, data: {} })) as TranscriptEvent[];

describe('drawing the end of a long list', () => {
  it('leaves a short list alone', () => {
    const events = many(10);
    const { result } = renderHook(() => usePagedEvents('a1', events));

    expect(result.current.events).toBe(events);
    expect(result.current.hasOlder).toBe(false);
  });

  /** One real subagent produces 455 entries, three times what a session view ever draws. */
  it('draws a screenful of a long one, and says there is more', () => {
    const { result } = renderHook(() => usePagedEvents('a1', many(455)));

    expect(result.current.events).toHaveLength(PAGE);
    expect(result.current.hasOlder).toBe(true);
  });

  // The end is what a reader wants first: the newest thing the agent did.
  it('keeps the newest rather than the oldest', () => {
    const { result } = renderHook(() => usePagedEvents('a1', many(200)));

    expect(result.current.events[result.current.events.length - 1]?.id).toBe('e199');
    expect(result.current.events[0]?.id).toBe('e50');
  });

  it('reaches back a page at a time', () => {
    const { result } = renderHook(() => usePagedEvents('a1', many(500)));

    act(() => result.current.loadOlder());
    expect(result.current.events).toHaveLength(PAGE * 2);

    act(() => result.current.loadOlder());
    expect(result.current.events).toHaveLength(PAGE * 3);
  });

  // Reaching past the start gives everything there is rather than failing to fill a page.
  it('stops at the start of the list', () => {
    const { result } = renderHook(() => usePagedEvents('a1', many(400)));

    act(() => result.current.loadOlder());
    act(() => result.current.loadOlder());

    expect(result.current.events).toHaveLength(400);
    expect(result.current.hasOlder).toBe(false);
  });

  it('stops saying there is more once everything is shown', () => {
    const { result } = renderHook(() => usePagedEvents('a1', many(200)));

    act(() => result.current.loadOlder());

    expect(result.current.events).toHaveLength(200);
    expect(result.current.hasOlder).toBe(false);
  });

  /**
   * A different list is a different position in it. Without this, opening one subagent
   * after reaching back through another would start halfway up the new one.
   */
  it('starts again at the end when the list it is showing changes', () => {
    const { result, rerender } = renderHook(({ key, events }) => usePagedEvents(key, events), {
      initialProps: { key: 'a1', events: many(400) },
    });
    act(() => result.current.loadOlder());
    expect(result.current.events).toHaveLength(PAGE * 2);

    rerender({ key: 'a2', events: many(400) });

    expect(result.current.events).toHaveLength(PAGE);
  });

  it('grows with the list while the same one is being watched', () => {
    const { result, rerender } = renderHook(({ events }) => usePagedEvents('a1', events), {
      initialProps: { events: many(10) },
    });

    rerender({ events: many(20) });

    expect(result.current.events).toHaveLength(20);
  });
});
