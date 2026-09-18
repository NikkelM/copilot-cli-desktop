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
  });

  it('turns the list over', () => {
    const { result } = renderHook(() => useCompact());

    act(() => result.current.toggleAll());

    expect(result.current.compact).toBe(true);
  });

  it('turns it back', () => {
    const { result } = renderHook(() => useCompact());
    act(() => result.current.toggleAll());

    act(() => result.current.toggleAll());

    expect(result.current.compact).toBe(false);
  });

  it('survives a restart', () => {
    const first = renderHook(() => useCompact());
    act(() => first.result.current.toggleAll());
    first.unmount();

    const { result } = renderHook(() => useCompact());

    expect(result.current.compact).toBe(true);
  });

  /** Anything could be in there, including what an earlier version of this wrote. */
  it('ignores a stored value it does not recognise', () => {
    localStorage.setItem(KEY, JSON.stringify({ all: true, some: {} }));

    const { result } = renderHook(() => useCompact());

    expect(result.current.compact).toBe(false);
  });
});
