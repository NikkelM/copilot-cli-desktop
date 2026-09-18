// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SidebarToggle } from './SidebarToggle';

afterEach(cleanup);

const show = (hidden: boolean, onToggle = vi.fn()) => {
  render(<SidebarToggle hidden={hidden} onToggle={onToggle} />);
  return { onToggle, button: screen.getByRole('button') };
};

describe('SidebarToggle', () => {
  it('folds the sidebar away when it is there', () => {
    const { onToggle, button } = show(false);

    fireEvent.click(button);

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('brings it back when it is not', () => {
    const { onToggle, button } = show(true);

    fireEvent.click(button);

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('says which way it goes from here', () => {
    expect(show(false).button.getAttribute('aria-label')).toBe('Hide the sidebar');
    cleanup();
    expect(show(true).button.getAttribute('aria-label')).toBe('Show the sidebar');
  });

  it('names the key that does the same thing, so the shortcut is not a secret', () => {
    expect(show(false).button.getAttribute('title')).toContain('Ctrl+B');
  });

  it('reports whether the sidebar is open, rather than only looking like it', () => {
    expect(show(false).button.getAttribute('aria-expanded')).toBe('true');
    cleanup();
    expect(show(true).button.getAttribute('aria-expanded')).toBe('false');
  });

  it('holds the corner itself once there is no header to sit in', () => {
    // The sidebar takes its own header away with it, so this has to be placed rather than
    // laid out once it is the only thing left.
    expect(show(true).button.className).toContain('away');
    cleanup();
    expect(show(false).button.className).not.toContain('away');
  });

  it('turns the chevron the way the sidebar will go', () => {
    const { button } = show(false);

    expect(button.querySelector('.caret')?.getAttribute('data-open')).toBe('true');
  });
});
