// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { Menu, type MenuItem } from './Menu';

const items: MenuItem[] = [
  { id: 'a', label: '/add-dir', description: 'Allow file access to a directory' },
  { id: 'b', label: '/allow-all', description: 'Enable all permissions' },
  { id: 'c', label: '/compact', description: 'Summarize conversation history' },
];

/** The caller owns the selection, so a test of the keys has to own it too. */
function Harness({
  onChoose,
  onDismiss = () => {},
}: {
  onChoose?: (item: MenuItem) => void;
  onDismiss?: () => void;
}) {
  const [selected, setSelected] = useState(0);
  return (
    <Menu
      items={items}
      selected={selected}
      onSelect={setSelected}
      onChoose={onChoose}
      onDismiss={onDismiss}
      label="Commands"
    />
  );
}

const chosen = () => screen.getByRole('option', { selected: true }).textContent;

describe('Menu', () => {
  it('starts on the first row', () => {
    render(<Harness />);
    expect(chosen()).toContain('/add-dir');
  });

  it('moves down and up', async () => {
    render(<Harness />);
    await userEvent.keyboard('{ArrowDown}');
    expect(chosen()).toContain('/allow-all');

    await userEvent.keyboard('{ArrowUp}');
    expect(chosen()).toContain('/add-dir');
  });

  // A list this short is quicker to reach round the end than back through the middle.
  it('wraps at both ends', async () => {
    render(<Harness />);
    await userEvent.keyboard('{ArrowUp}');
    expect(chosen()).toContain('/compact');

    await userEvent.keyboard('{ArrowDown}');
    expect(chosen()).toContain('/add-dir');
  });

  it('jumps to either end', async () => {
    render(<Harness />);
    await userEvent.keyboard('{End}');
    expect(chosen()).toContain('/compact');

    await userEvent.keyboard('{Home}');
    expect(chosen()).toContain('/add-dir');
  });

  // The key matters as well as the row: Tab completes, Enter completes and acts.
  it.each([
    ['{Enter}', 'Enter'],
    ['{Tab}', 'Tab'],
  ])('takes the selected row with %s, and says which key took it', async (press, key) => {
    const onChoose = vi.fn();
    render(<Harness onChoose={onChoose} />);
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard(press);

    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ label: '/allow-all' }), key);
  });

  it('dismisses on Escape', async () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    await userEvent.keyboard('{Escape}');

    expect(onDismiss).toHaveBeenCalled();
  });

  /**
   * The shortcuts list is a reference rather than something to pick from, so it passes no
   * onChoose - and Enter must then fall through to whatever else wanted it.
   */
  it('lets Enter through when there is nothing to choose', async () => {
    render(<Harness />);
    const seen = vi.fn();
    document.addEventListener('keydown', seen);

    await userEvent.keyboard('{Enter}');
    expect(seen).toHaveBeenCalled();
    expect(seen.mock.calls[0]?.[0]?.defaultPrevented).toBe(false);

    document.removeEventListener('keydown', seen);
  });

  // Enter in the composer sends the message. A menu opened to help write that message must
  // claim the key first, or choosing a command would send the half-written prompt.
  it('claims Enter before anything else can act on it', async () => {
    const onChoose = vi.fn();
    render(<Harness onChoose={onChoose} />);
    const late = vi.fn();
    document.addEventListener('keydown', late);

    await userEvent.keyboard('{Enter}');
    expect(late.mock.calls[0]?.[0]?.defaultPrevented).toBe(true);

    document.removeEventListener('keydown', late);
  });

  it('shows what each row does', () => {
    render(<Harness />);
    expect(screen.getByText('Allow file access to a directory')).toBeTruthy();
  });

  it('draws nothing when there is nothing to show', () => {
    const { container } = render(
      <Menu items={[]} selected={0} onSelect={() => {}} onDismiss={() => {}} label="Commands" />,
    );
    expect(container.querySelector('.menu')).toBeNull();
  });

  /**
   * The shortcut list is read and then dismissed by carrying on with anything at all, which
   * is how the CLI's help behaves. A list being filtered must not do this: there, typing is
   * the point.
   */
  describe('dismissing on any key', () => {
    const reference = () => {
      const onDismiss = vi.fn();
      const onSelect = vi.fn();
      render(
        <Menu
          items={items}
          selected={0}
          onSelect={onSelect}
          onDismiss={onDismiss}
          dismissOnAnyKey
          label="Keyboard shortcuts"
        />,
      );
      return { onDismiss, onSelect };
    };

    it.each(['a', '1', ' ', '{Backspace}', '{Enter}', '{Tab}', '{ArrowDown}', '{Escape}', '{F5}'])(
      'closes on %s',
      async (key) => {
        const { onDismiss } = reference();
        await userEvent.keyboard(key);
        expect(onDismiss).toHaveBeenCalled();
      },
    );

    // Verified against the CLI: pressing Ctrl to begin a combination leaves its help open.
    it.each(['{Shift>}', '{Control>}', '{Alt>}'])('stays open for %s held on its own', async (key) => {
      const { onDismiss } = reference();
      await userEvent.keyboard(key);
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it('closes once the combination completes', async () => {
      const { onDismiss } = reference();
      await userEvent.keyboard('{Control>}c{/Control}');
      expect(onDismiss).toHaveBeenCalled();
    });

    // Nothing is navigated, because nothing survives the first key.
    it('does not navigate', async () => {
      const { onSelect } = reference();
      await userEvent.keyboard('{ArrowDown}');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('leaves the key to do what it normally does', async () => {
      const seen = vi.fn();
      document.addEventListener('keydown', seen);
      reference();

      await userEvent.keyboard('a');
      expect(seen.mock.calls[0]?.[0]?.defaultPrevented).toBe(false);
      document.removeEventListener('keydown', seen);
    });

    // The command list is filtered by typing, so the same keys must reach the composer.
    it('stays open while a filtered list is being typed into', async () => {
      const onDismiss = vi.fn();
      render(
        <Menu
          items={items}
          selected={0}
          onSelect={() => {}}
          onChoose={() => {}}
          onDismiss={onDismiss}
          label="Commands"
        />,
      );

      await userEvent.keyboard('add');
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });
});
