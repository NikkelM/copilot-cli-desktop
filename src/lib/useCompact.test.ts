// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useCompact } from './useCompact';

const KEY = 'copilot-desktop.compact';

beforeEach(() => localStorage.clear());

describe('how much of each row is drawn', () => {
  it('draws all of it to begin with', () => {
    const { result } = renderHook(() => useCompact());

    expect(result.current.compact).toBe(false);
    expect(result.current.collapsed('a')).toBe(false);
  });

  it('turns the whole list over', () => {
    const { result } = renderHook(() => useCompact());

    act(() => result.current.toggleAll());

    expect(result.current.collapsed('a')).toBe(true);
    expect(result.current.collapsed('b')).toBe(true);
  });

  it('turns it back', () => {
    const { result } = renderHook(() => useCompact());
    act(() => result.current.toggleAll());

    act(() => result.current.toggleAll());

    expect(result.current.collapsed('a')).toBe(false);
  });

  it('turns one row over against the list', () => {
    const { result } = renderHook(() => useCompact());

    act(() => result.current.toggleOne('a'));

    expect(result.current.collapsed('a')).toBe(true);
    expect(result.current.collapsed('b')).toBe(false);
  });

  it('opens one row while the list is short', () => {
    const { result } = renderHook(() => useCompact());
    act(() => result.current.toggleAll());

    act(() => result.current.toggleOne('a'));

    expect(result.current.collapsed('a')).toBe(false);
    expect(result.current.collapsed('b')).toBe(true);
  });

  /**
   * Asking for all of them means all of them. An exception kept through the toggle only
   * shows up on the way back - the list returns to where it was and one row does not -
   * so the test has to turn it over twice to see it at all.
   */
  it('drops the exceptions when the list is turned over', () => {
    const { result } = renderHook(() => useCompact());
    act(() => result.current.toggleAll());
    act(() => result.current.toggleOne('a'));
    expect(result.current.collapsed('a')).toBe(false);

    act(() => result.current.toggleAll());
    act(() => result.current.toggleAll());

    expect(result.current.collapsed('a')).toBe(true);
  });

  /**
   * A row put back to what the list is doing follows it afterwards, rather than being
   * recorded as agreeing with it and then staying behind when the list changes.
   */
  it('lets a row rejoin the list', () => {
    const { result } = renderHook(() => useCompact());
    act(() => result.current.toggleOne('a'));
    act(() => result.current.toggleOne('a'));

    act(() => result.current.toggleAll());

    expect(result.current.collapsed('a')).toBe(true);
  });

  it('keeps nothing about a row that agrees with the list', () => {
    const { result } = renderHook(() => useCompact());
    act(() => result.current.toggleOne('a'));
    act(() => result.current.toggleOne('a'));

    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').some).toEqual({});
  });

  it('survives a restart', () => {
    const first = renderHook(() => useCompact());
    act(() => first.result.current.toggleAll());
    act(() => first.result.current.toggleOne('a'));
    first.unmount();

    const { result } = renderHook(() => useCompact());

    expect(result.current.compact).toBe(true);
    expect(result.current.collapsed('a')).toBe(false);
  });

  it('ignores stored rubbish', () => {
    localStorage.setItem(KEY, 'not json');

    const { result } = renderHook(() => useCompact());

    expect(result.current.compact).toBe(false);
  });

  it('ignores a stored shape it does not recognise', () => {
    localStorage.setItem(KEY, JSON.stringify({ all: 'yes', some: 7 }));

    const { result } = renderHook(() => useCompact());

    expect(result.current.compact).toBe(false);
    expect(result.current.collapsed('a')).toBe(false);
  });
});
