// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useKeying } from './useKeying';

const keying = () => document.documentElement.dataset.keying !== undefined;

const press = (key: string) =>
  act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));

const move = (x: number, y: number) =>
  act(() => void window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true })));

beforeEach(() => {
  delete document.documentElement.dataset.keying;
});

describe('noting that the keyboard is doing the work', () => {
  it.each(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'Tab', 'F6'])('is set by %s', (key) => {
    renderHook(() => useKeying());

    press(key);

    expect(keying()).toBe(true);
  });

  /**
   * Typing is not navigating, and treating it as such would cost a click: a reader with the
   * pointer already resting over a session who writes a message and then clicks it without
   * moving the mouse would find the first click went nowhere.
   */
  it.each(['a', ' ', 'Enter', 'Escape'])('is not set by %s', (key) => {
    renderHook(() => useKeying());

    press(key);

    expect(keying()).toBe(false);
  });

  it('is given up when the mouse is actually moved', () => {
    renderHook(() => useKeying());
    move(10, 10);
    press('ArrowDown');

    move(40, 80);

    expect(keying()).toBe(false);
  });

  /**
   * The whole point of the position check. Scrolling a list under a pointer nobody touched
   * raises a mousemove carrying the coordinates it already had, and taking that for the
   * reader reaching for the mouse would put the hover and its tooltip straight back.
   */
  it('is kept when the page moves under a still pointer', () => {
    renderHook(() => useKeying());
    move(10, 10);
    press('ArrowDown');

    move(10, 10);

    expect(keying(), 'the pointer is where it was, so nobody moved it').toBe(true);
  });

  /** Nothing to compare the first one against, so it says nothing either way. */
  it('is kept when the very first mouse event arrives', () => {
    renderHook(() => useKeying());
    press('ArrowDown');

    move(10, 10);

    expect(keying()).toBe(true);
  });

  it.each([
    ['a click', () => new MouseEvent('mousedown', { bubbles: true })],
    ['the wheel', () => new WheelEvent('wheel', { bubbles: true })],
  ])('is given up on %s, wherever the pointer is', (_what, build) => {
    renderHook(() => useKeying());
    press('ArrowDown');

    act(() => void window.dispatchEvent(build()));

    expect(keying()).toBe(false);
  });

  it('takes the note away with it when it goes', () => {
    const view = renderHook(() => useKeying());
    press('ArrowDown');

    view.unmount();

    expect(keying(), 'a flag left behind would leave the sidebar unclickable').toBe(false);
  });

  it('stops listening once it has gone', () => {
    const view = renderHook(() => useKeying());
    view.unmount();

    press('ArrowDown');

    expect(keying()).toBe(false);
  });
});
