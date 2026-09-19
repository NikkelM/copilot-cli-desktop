// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { BASE_PX, LARGEST, SCALE_KEY, SMALLEST, STEP, applyScale, clampScale, readScale } from './scale';
import { useScale } from './useScale';
import { resetStores, save } from './store';

beforeEach(() => {
  localStorage.clear();
  resetStores();
});

describe('keeping a scale usable', () => {
  it('leaves an ordinary one alone', () => {
    expect(clampScale(1.25)).toBe(1.25);
  });

  it('will not go below what can be read', () => {
    expect(clampScale(0.1)).toBe(SMALLEST);
  });

  it('will not go above what still fits on screen', () => {
    expect(clampScale(99)).toBe(LARGEST);
  });

  /** Steps are eighths, and floats do not add up to eighths without help. */
  it('rounds off what repeated steps accumulate', () => {
    expect(clampScale(1 + STEP + STEP + STEP)).toBe(1.375);
  });

  it('falls back to the app own size for a number that is not one', () => {
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe('remembering it', () => {
  it('starts at the app own size when nothing was chosen', () => {
    expect(readScale()).toBe(1);
  });

  it('reads back what was stored', () => {
    save('settings', SCALE_KEY, '1.25');

    expect(readScale()).toBe(1.25);
  });

  // Anything could be in there, including something another version of the app wrote.
  it('ignores a stored value that is not a number', () => {
    save('settings', SCALE_KEY, 'enormous');

    expect(readScale()).toBe(1);
  });

  it('brings a stored value that is out of range back in', () => {
    save('settings', SCALE_KEY, '40');

    expect(readScale()).toBe(LARGEST);
  });
});

describe('putting it into effect', () => {
  /** Every size in the app is a ratio of this one, so nothing else has to be told. */
  it('sets the base the whole scale is derived from', () => {
    const root = document.createElement('div');

    applyScale(1.5, root);

    expect(root.style.getPropertyValue('--font-base')).toBe(`${BASE_PX * 1.5}px`);
  });
});

describe('changing it while the app is open', () => {
  it('applies a remembered scale before anything is drawn at the default', () => {
    save('settings', SCALE_KEY, '1.25');

    renderHook(() => useScale());

    expect(document.documentElement.style.getPropertyValue('--font-base')).toBe(`${BASE_PX * 1.25}px`);
  });

  it('goes up a step', () => {
    const { result } = renderHook(() => useScale());

    act(() => result.current.larger());

    expect(result.current.scale).toBe(1 + STEP);
  });

  it('goes down a step', () => {
    const { result } = renderHook(() => useScale());

    act(() => result.current.smaller());

    expect(result.current.scale).toBe(1 - STEP);
  });

  it('stops at the largest rather than going past it', () => {
    const { result } = renderHook(() => useScale());

    for (let press = 0; press < 40; press += 1) act(() => result.current.larger());

    expect(result.current.scale).toBe(LARGEST);
  });

  it('stops at the smallest', () => {
    const { result } = renderHook(() => useScale());

    for (let press = 0; press < 40; press += 1) act(() => result.current.smaller());

    expect(result.current.scale).toBe(SMALLEST);
  });

  it('goes back to the app own size', () => {
    const { result } = renderHook(() => useScale());
    act(() => result.current.larger());

    act(() => result.current.reset());

    expect(result.current.scale).toBe(1);
  });

  // Chosen by looking at the result, so it has to be in force before the next press.
  it('takes effect at once rather than at the next launch', () => {
    const { result } = renderHook(() => useScale());

    act(() => result.current.larger());

    expect(document.documentElement.style.getPropertyValue('--font-base')).toBe(`${BASE_PX * (1 + STEP)}px`);
  });

  it('survives a restart', () => {
    const first = renderHook(() => useScale());
    act(() => first.result.current.larger());
    first.unmount();

    const { result } = renderHook(() => useScale());

    expect(result.current.scale).toBe(1 + STEP);
  });
});
