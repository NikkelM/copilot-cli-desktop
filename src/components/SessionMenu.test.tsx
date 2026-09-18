// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SessionMenu, type SessionAction } from './SessionMenu';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(actions: SessionAction[], onClose = () => {}) {
  render(<SessionMenu at={{ x: 10, y: 10 }} actions={actions} onClose={onClose} />);
}

describe('SessionMenu', () => {
  it('runs the action that was chosen and closes', () => {
    const run = vi.fn();
    const onClose = vi.fn();
    open([{ id: 'a', label: 'Favourite', run }], onClose);

    fireEvent.click(screen.getByText('Favourite'));

    expect(run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('refuses an action rather than running it, and says why', () => {
    const run = vi.fn();
    open([{ id: 'a', label: 'Unload from memory', refused: 'Still working.', run }]);

    const item = screen.getByText('Unload from memory');
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.getAttribute('title')).toBe('Still working.');

    fireEvent.click(item);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps a refused action in the menu, so the rows do not move', () => {
    open([
      { id: 'a', label: 'Favourite', run: () => {} },
      { id: 'b', label: 'Unload from memory', refused: 'Already unloaded.', run: () => {} },
      { id: 'c', label: 'Copy session id', run: () => {} },
    ]);

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Favourite',
      'Unload from memory',
      'Copy session id',
    ]);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    open([{ id: 'a', label: 'Favourite', run: () => {} }], onClose);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when the pointer goes down outside it', () => {
    const onClose = vi.fn();
    open([{ id: 'a', label: 'Favourite', run: () => {} }], onClose);

    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open when the pointer goes down inside it', () => {
    const onClose = vi.fn();
    open([{ id: 'a', label: 'Favourite', run: () => {} }], onClose);

    fireEvent.mouseDown(screen.getByText('Favourite'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('pulls itself back inside a window it would have overflowed', () => {
    // A menu opened near the bottom right corner: without the correction it is drawn off the
    // edge and its last rows cannot be reached.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 120,
    } as DOMRect);
    window.innerWidth = 1000;
    window.innerHeight = 800;

    render(
      <SessionMenu
        at={{ x: 980, y: 790 }}
        actions={[{ id: 'a', label: 'Favourite', run: () => {} }]}
        onClose={() => {}}
      />,
    );

    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('796px');
    expect(menu.style.top).toBe('676px');
  });
});
