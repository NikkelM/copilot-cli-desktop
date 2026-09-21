// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FloatingMenu } from './FloatingMenu';

/** Only the edges the placing reads, and mutable so a test can move the control. */
type Box = { top?: number; bottom?: number; left?: number; right?: number };

/** jsdom gives every element a zero-sized box, so the control says where it is itself. */
function Control({ rect, onDismiss = () => {} }: { rect?: Box; onDismiss?: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    if (!anchor.current || !rect) return;
    anchor.current.getBoundingClientRect = () =>
      ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, ...rect }) as DOMRect;
  });

  return (
    <div data-testid="control">
      <button ref={anchor} onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <FloatingMenu anchor={anchor} onDismiss={onDismiss} className="menu" role="listbox">
          <button type="button">Row</button>
        </FloatingMenu>
      )}
    </div>
  );
}

async function open(props: Parameters<typeof Control>[0] = {}) {
  render(<Control {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
  return screen.getByRole('listbox');
}

describe('FloatingMenu', () => {
  // The whole point: nested in the control, a pane that scrolls clips it.
  it('draws the menu outside the control it belongs to', async () => {
    const menu = await open();

    expect(screen.getByTestId('control').contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it('passes what it was given through to the menu', async () => {
    const menu = await open();

    expect(menu.classList.contains('menu')).toBe(true);
  });

  // Being drawn on the body is this component's doing, so where and how high it sits is
  // its business rather than each menu's: without this every menu would restate both.
  it('marks every menu as one that floats', async () => {
    const menu = await open();

    expect(menu.classList.contains('floating')).toBe(true);
  });

  it('hangs the menu under the control', async () => {
    const menu = await open({ rect: { bottom: 100, top: 80, right: 500 } });

    expect(menu.style.top).toBe('104px');
    expect(menu.style.right).toBe('524px');
    expect(menu.style.bottom).toBe('');
  });

  it('opens upwards when there is no room underneath', async () => {
    const menu = await open({ rect: { bottom: 740, top: 700, right: 500 } });

    // 768 tall in jsdom, so 700 above the control and 20 below it.
    expect(menu.style.bottom).toBe('72px');
    expect(menu.style.top).toBe('');
  });

  it('stays on screen when the control is near the left edge', async () => {
    // jsdom gives everything a zero width, and a menu with no width cannot hang off a side.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 300 });
    try {
      const menu = await open({ rect: { bottom: 100, right: 10 } });

      // Right-aligning to a control this far left would put the menu off the side.
      expect(menu.style.right).toBe('720px');
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width!);
    }
  });

  it('right-aligns to the control when there is room for it', async () => {
    const menu = await open({ rect: { bottom: 100, right: 10 } });

    expect(menu.style.right).toBe('1014px');
  });

  it('keeps a long menu to part of the screen', async () => {
    const menu = await open({ rect: { bottom: 100, right: 500 } });

    // 768 tall in jsdom, of which the menu may have three fifths.
    expect(parseFloat(menu.style.maxHeight)).toBeCloseTo(460.8, 5);
  });

  it('fits the menu to the room left under the control', async () => {
    const menu = await open({ rect: { bottom: 500, right: 500 } });

    expect(menu.style.maxHeight).toBe('260px');
  });

  it('follows the control when a pane it sits in scrolls', async () => {
    const rect: Box = { bottom: 100, top: 80, right: 500 };
    const menu = await open({ rect });

    rect.bottom = 300;
    fireEvent.scroll(screen.getByTestId('control'));

    expect(menu.style.top).toBe('304px');
  });

  it('follows the control when the window resizes', async () => {
    const rect: Box = { bottom: 100, top: 80, right: 500 };
    const menu = await open({ rect });

    rect.bottom = 300;
    fireEvent.resize(window);

    expect(menu.style.top).toBe('304px');
  });

  describe('dismissing', () => {
    it('closes on a click elsewhere', async () => {
      const onDismiss = vi.fn();
      await open({ onDismiss });

      await userEvent.click(document.body);

      expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('stays open for a click inside the menu', async () => {
      const onDismiss = vi.fn();
      await open({ onDismiss });

      await userEvent.click(screen.getByRole('button', { name: 'Row' }));

      expect(onDismiss).not.toHaveBeenCalled();
    });

    // Pressing the control again is its own way of closing, and counting it as outside
    // would close and reopen in one press.
    it('stays open for a click on the control', async () => {
      const onDismiss = vi.fn();
      await open({ onDismiss });

      await userEvent.click(screen.getByRole('button', { name: 'Open' }));

      expect(onDismiss).not.toHaveBeenCalled();
    });

    it('closes on Escape', async () => {
      const onDismiss = vi.fn();
      await open({ onDismiss });

      await userEvent.keyboard('{Escape}');

      expect(onDismiss).toHaveBeenCalledOnce();
    });

    // Or Escape would dismiss the menu and close the window it was opened in as well.
    it('keeps Escape from reaching whatever the menu was opened in', async () => {
      const outer = vi.fn();
      window.addEventListener('keydown', outer);
      try {
        await open({ rect: { bottom: 100 } });

        await userEvent.keyboard('{Escape}');

        expect(outer).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('keydown', outer);
      }
    });

    it('lets other keys through', async () => {
      const outer = vi.fn();
      window.addEventListener('keydown', outer);
      try {
        await open({ rect: { bottom: 100 } });

        await userEvent.keyboard('a');

        expect(outer).toHaveBeenCalledOnce();
      } finally {
        window.removeEventListener('keydown', outer);
      }
    });
  });
});
