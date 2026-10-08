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

/**
 * Folded away there is no boundary between two panes to take hold of, and nothing to nudge.
 * Pulling the sidebar back is all that is left, and the chevron at the same corner already
 * offers the keyboard that - so a second stop on the way round that looks like nothing is one
 * stop too many (#247).
 */
describe('once the sidebar is folded away', () => {
  const folded = () => {
    const props = { hidden: true, dragging: false, onStart: vi.fn(), onNudge: vi.fn(), onReset: vi.fn() };
    const view = render(<SidebarGrip {...props} />);
    return { ...props, grip: view.container.querySelector('.sidebar-grip') as HTMLElement };
  };

  it('is no longer a stop on the way round', () => {
    expect(folded().grip.tabIndex).toBe(-1);
  });

  it('stops calling itself the edge between two panes', () => {
    const { grip } = folded();

    expect(grip.getAttribute('role'), 'there is nothing left for it to separate').toBeNull();
    expect(grip.getAttribute('aria-label')).toBeNull();
  });

  /** The visible way back that a shortcut on its own would not be (#190). */
  it('can still be taken hold of, which is what asks for the sidebar back', () => {
    const { onStart, grip } = folded();

    fireEvent.pointerDown(grip);

    expect(onStart).toHaveBeenCalledOnce();
  });
});
