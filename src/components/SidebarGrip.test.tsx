// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SidebarGrip } from './SidebarGrip';

afterEach(cleanup);

const show = (over: Partial<Parameters<typeof SidebarGrip>[0]> = {}) => {
  const props = {
    dragging: false,
    onStart: vi.fn(),
    onNudge: vi.fn(),
    onReset: vi.fn(),
    ...over,
  };
  render(<SidebarGrip {...props} />);
  return { ...props, grip: screen.getByRole('separator') };
};

describe('SidebarGrip', () => {
  it('takes hold when pressed', () => {
    const { onStart, grip } = show();

    fireEvent.pointerDown(grip);

    expect(onStart).toHaveBeenCalledOnce();
  });

  it('takes the press off the window, which would otherwise drag-select the transcript', () => {
    const { grip } = show();

    // fireEvent returns false when the default was prevented.
    expect(fireEvent.pointerDown(grip)).toBe(false);
  });

  it('goes back to the app own width on a double click', () => {
    const { onReset, grip } = show();

    fireEvent.doubleClick(grip);

    expect(onReset).toHaveBeenCalledOnce();
  });

  describe('for a keyboard', () => {
    it('can be reached at all', () => {
      expect(show().grip.tabIndex).toBe(0);
    });

    it.each([
      ['ArrowLeft', -1],
      ['ArrowRight', 1],
    ])('moves the edge on %s', (key, steps) => {
      const { onNudge, grip } = show();

      fireEvent.keyDown(grip, { key });

      expect(onNudge).toHaveBeenCalledExactlyOnceWith(steps);
    });

    it('goes back to the app own width on Home', () => {
      const { onReset, grip } = show();

      fireEvent.keyDown(grip, { key: 'Home' });

      expect(onReset).toHaveBeenCalledOnce();
    });

    it('takes the arrows, which would otherwise also scroll what is behind it', () => {
      const { grip } = show();

      expect(fireEvent.keyDown(grip, { key: 'ArrowLeft' })).toBe(false);
    });

    it('leaves a key it does not answer for whatever does', () => {
      const { onNudge, onReset, grip } = show();

      expect(fireEvent.keyDown(grip, { key: 'a' })).toBe(true);
      expect(onNudge).not.toHaveBeenCalled();
      expect(onReset).not.toHaveBeenCalled();
    });
  });

  it('says it is being dragged, so it can keep showing while the pointer is elsewhere', () => {
    show({ dragging: true });

    expect(screen.getByRole('separator').className).toContain('dragging');
  });

  it('says what it is and which way it runs', () => {
    const { grip } = show();

    expect(grip.getAttribute('aria-orientation')).toBe('vertical');
    expect(grip.getAttribute('aria-label')).toBe('Resize the sidebar');
  });
});
