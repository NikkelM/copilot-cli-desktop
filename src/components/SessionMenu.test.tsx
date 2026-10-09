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

  /**
   * The foot of the menu: the rows that take a session off the list.
   *
   * The rule above them belongs to the group, not to each row in it. With the line tied to
   * the colour instead, archiving and deleting beside each other drew two lines and made a
   * group of one out of each.
   */
  describe('the rows drawn apart', () => {
    const footed = () => [
      { id: 'a', label: 'Favourite', run: () => {} },
      { id: 'b', label: 'Archive', tone: 'caution' as const, run: () => {} },
      { id: 'c', label: 'Delete session', tone: 'danger' as const, run: () => {} },
    ];

    it('draws one line, above the first of them', () => {
      open(footed());

      const apart = screen.getAllByRole('menuitem').filter((item) => item.classList.contains('apart'));
      expect(apart.map((item) => item.textContent)).toEqual(['Archive']);
    });

    it('colours each by what it costs', () => {
      open(footed());

      expect(screen.getByText('Archive').className).toContain('caution');
      expect(screen.getByText('Delete session').className).toContain('danger');
    });

    it('leaves the rows above untouched', () => {
      open(footed());

      const first = screen.getByText('Favourite');
      expect(first.className).toBe('session-menu-item');
    });

    it('draws no line at all where nothing is set apart', () => {
      open([{ id: 'a', label: 'Favourite', run: () => {} }]);

      expect(screen.getAllByRole('menuitem').some((item) => item.classList.contains('apart'))).toBe(false);
    });
  });
});

/**
 * A menu a key opened has to be operable by key, or it is a list that appears and cannot be
 * read. A menu that was pointed at is left alone: the keyboard stays where it was, as every
 * other context menu on the machine does (#247).
 */
describe('a menu opened by a key rather than pointed at', () => {
  const three = (): SessionAction[] => [
    { id: 'a', label: 'Favourite', run: vi.fn() },
    { id: 'b', label: 'Rename', run: vi.fn() },
    { id: 'c', label: 'Export', run: vi.fn() },
  ];

  const show = (focusFirst: boolean, actions = three()) =>
    render(<SessionMenu at={{ x: 10, y: 10 }} actions={actions} focusFirst={focusFirst} onClose={() => {}} />);

  const items = () => screen.getAllByRole('menuitem');

  it('takes the keyboard to its first action', () => {
    show(true);

    expect(document.activeElement).toBe(items()[0]);
  });

  it('leaves the keyboard alone when it was pointed at', () => {
    show(false);

    expect(document.activeElement, 'a pointer has not asked to go anywhere').not.toBe(items()[0]);
  });

  /** Drawn and refused rather than left out, so it is not somewhere the keyboard can land. */
  it('starts at the first action that can actually be taken', () => {
    show(true, [
      { id: 'a', label: 'Unload from memory', refused: 'Still working.', run: vi.fn() },
      { id: 'b', label: 'Rename', run: vi.fn() },
    ]);

    expect(screen.getByText('Rename')).toBe(document.activeElement);
  });

  it.each([
    ['ArrowDown', 1],
    ['ArrowUp', 2],
  ])('walks to the next action on %s', (key, landing) => {
    show(true);

    fireEvent.keyDown(items()[0]!, { key });

    expect(document.activeElement, 'wrapping, as the other menus do').toBe(items()[landing]);
  });

  it('runs what the keyboard landed on', () => {
    const actions = three();
    show(true, actions);

    fireEvent.keyDown(items()[0]!, { key: 'ArrowDown' });
    fireEvent.click(document.activeElement!);

    expect(actions[1]!.run).toHaveBeenCalledOnce();
  });
});
