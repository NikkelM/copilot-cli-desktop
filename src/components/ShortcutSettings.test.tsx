// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShortcutSettings } from './ShortcutSettings';
import { REBINDABLE, readOverrides } from '../lib/bindings';

afterEach(cleanup);

/** The window with every row showing, since searching is the window's business not this one's. */
const show = (value = '') => {
  const onChange = vi.fn<(next: string) => void>();
  const { rerender } = render(<ShortcutSettings value={value} onChange={onChange} shows={() => true} />);

  return {
    onChange,
    /** What the last change would be saved as, read back as the overrides it stands for. */
    saved: () => readOverrides(onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] ?? ''),
    again: (next: string) => rerender(<ShortcutSettings value={next} onChange={onChange} shows={() => true} />),
  };
};

/** The button showing what a key is bound to, which is also the one that changes it. */
const keys = (what: string) => screen.getByRole('button', { name: what.charAt(0).toUpperCase() + what.slice(1) });

/** The Clear or Reset beside a key, found by the row it sits in. */
const beside = (what: string, label: string) =>
  [...(keys(what).closest('.shortcut-row')?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === label,
  ) as HTMLButtonElement;

describe('the keys a reader can move', () => {
  it('lists every one the app implements', () => {
    show();

    for (const binding of REBINDABLE) expect(keys(binding.what), binding.what).toBeTruthy();
  });

  it('shows what each is bound to', () => {
    show();

    expect(keys('show or hide the sidebar').textContent).toBe('ctrl+b');
  });

  /**
   * The bindings are worded for the `?` list, which follows the CLI's lower case. A settings
   * row is a label among labels and starts with a capital like every other row in the window.
   */
  it('names each one as a settings row rather than as a help line', () => {
    show();

    for (const binding of REBINDABLE) {
      expect(screen.getByText(binding.what.charAt(0).toUpperCase() + binding.what.slice(1))).toBeTruthy();
    }
    expect(screen.queryByText('show or hide the sidebar')).toBeNull();
  });

  it('shows what a reader moved rather than what it was', () => {
    show(JSON.stringify({ sidebar: 'ctrl+shift+b' }));

    expect(keys('show or hide the sidebar').textContent).toBe('ctrl+shift+b');
  });

  /** Escape is a press repeated rather than a press with modifiers, so it has no row. */
  it('leaves out the keys that are not chords', () => {
    show();

    expect(screen.queryByRole('button', { name: 'clear input or interrupt' })).toBeNull();
  });

  it('leaves out the keys readline provides, which this app only passes through', () => {
    show();

    expect(screen.queryByRole('button', { name: 'delete to start of line' })).toBeNull();
  });
});

describe('giving a key new keys', () => {
  it('waits for a press once the row is chosen', async () => {
    show();

    await userEvent.click(keys('show or hide the sidebar'));

    expect(keys('show or hide the sidebar').textContent).toBe('Press keys');
  });

  /** No capability may exist only as a click target, so Enter has to start it too. */
  it.each(['{Enter}', ' '])('starts listening on %s as well as a click', async (key) => {
    show();
    keys('show or hide the sidebar').focus();

    await userEvent.keyboard(key);

    expect(keys('show or hide the sidebar').textContent).toBe('Press keys');
  });

  it('records the press', async () => {
    const { saved } = show();

    await userEvent.click(keys('show or hide the sidebar'));
    await userEvent.keyboard('{Control>}{Shift>}j{/Shift}{/Control}');

    expect(saved()).toEqual({ sidebar: 'ctrl+shift+j' });
  });

  it('stops listening once it has one', async () => {
    const { again, saved } = show();

    await userEvent.click(keys('show or hide the sidebar'));
    await userEvent.keyboard('{Control>}{Shift>}j{/Shift}{/Control}');
    again(JSON.stringify(saved()));

    expect(keys('show or hide the sidebar').textContent).toBe('ctrl+shift+j');
  });

  /**
   * This is the one moment a press means a key rather than what it does, and every shortcut
   * in the app is listening on the window - so the press has to be taken before they see it.
   */
  it('keeps the press from reaching the rest of the app', async () => {
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    show();

    await userEvent.click(keys('show or hide the sidebar'));
    heard.mockClear();
    await userEvent.keyboard('{Control>}{Shift>}j{/Shift}{/Control}');

    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener('keydown', heard);
  });

  /** The middle of pressing ctrl+shift+b looks exactly like this, so it is not an answer. */
  it('goes on waiting while only modifiers are held', async () => {
    const { onChange } = show();

    await userEvent.click(keys('show or hide the sidebar'));
    await userEvent.keyboard('{Control>}');

    expect(onChange).not.toHaveBeenCalled();
    expect(keys('show or hide the sidebar').textContent).toBe('Press keys');
    await userEvent.keyboard('{/Control}');
  });

  it('leaves the row alone on Escape', async () => {
    const { onChange } = show();

    await userEvent.click(keys('show or hide the sidebar'));
    await userEvent.keyboard('{Escape}');

    expect(onChange).not.toHaveBeenCalled();
    expect(keys('show or hide the sidebar').textContent).toBe('ctrl+b');
  });

  /** Or a reader who started a capture by mistake would have no key left that does anything. */
  it('lets Tab out of a capture', async () => {
    show();

    await userEvent.click(keys('show or hide the sidebar'));
    await userEvent.tab();

    expect(keys('show or hide the sidebar').textContent).toBe('ctrl+b');
  });
});

describe('a chord that is already taken', () => {
  it('is refused, and says what has it', async () => {
    const { onChange } = show();

    await userEvent.click(keys('show or hide the sidebar'));
    await userEvent.keyboard('{Control>}{Shift>}k{/Shift}{/Control}');

    expect(screen.getByRole('alert').textContent).toContain('Open the wiki');
    expect(onChange, 'the key they had is kept').not.toHaveBeenCalled();
  });

  it('is still refused when what has it is a key the CLI uses', async () => {
    const { onChange } = show();

    await userEvent.click(keys('show or hide the sidebar'));
    await userEvent.keyboard('{Control>}u{/Control}');

    expect(screen.getByRole('alert').textContent).toContain('Delete to start of line');
    expect(onChange).not.toHaveBeenCalled();
  });

  /** These fire wherever the keyboard is, so one with no modifier would be unusable. */
  it('is refused when there is nothing to stop it being typed', async () => {
    const { onChange } = show();

    await userEvent.click(keys('show or hide the sidebar'));
    await userEvent.keyboard('j');

    expect(screen.getByRole('alert').textContent).toContain('Needs ctrl or alt');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('goes on listening, so the next press is the answer', async () => {
    const { saved } = show();

    await userEvent.click(keys('show or hide the sidebar'));
    await userEvent.keyboard('{Control>}{Shift>}k{/Shift}{/Control}');
    await userEvent.keyboard('{Control>}{Shift>}j{/Shift}{/Control}');

    expect(saved()).toEqual({ sidebar: 'ctrl+shift+j' });
  });
});

describe('putting a key back', () => {
  it('turns one off', async () => {
    const { saved } = show();

    await userEvent.click(beside('show or hide the sidebar', 'Clear'));

    expect(saved()).toEqual({ sidebar: '' });
  });

  it('says so in the row', () => {
    show(JSON.stringify({ sidebar: '' }));

    expect(screen.getByRole('button', { name: 'Show or hide the sidebar' }).textContent).toBe('Not set');
  });

  it('will not clear what is already cleared', () => {
    show(JSON.stringify({ sidebar: '' }));

    expect(beside('show or hide the sidebar', 'Clear').disabled).toBe(true);
  });

  it('puts one back on its default', async () => {
    const { saved } = show(JSON.stringify({ sidebar: 'ctrl+shift+b', wiki: '' }));

    await userEvent.click(beside('show or hide the sidebar', 'Reset'));

    expect(saved(), 'and leaves the other alone').toEqual({ wiki: '' });
  });

  it('offers no reset for a key that was never moved', () => {
    show();

    expect(beside('show or hide the sidebar', 'Reset').disabled).toBe(true);
  });

  it('puts every key back at once', async () => {
    const { saved } = show(JSON.stringify({ sidebar: 'ctrl+shift+b', wiki: '' }));

    await userEvent.click(screen.getByRole('button', { name: 'Reset all bindings' }));

    expect(saved()).toEqual({});
  });

  it('offers nothing to put back when nothing was moved', () => {
    show();

    expect((screen.getByRole('button', { name: 'Reset all bindings' }) as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * Clear and Reset both disable themselves once used, and a disabled element drops the
   * focus where it stands - which would leave the keyboard at the top of the window.
   */
  it('leaves the keyboard on the row it changed', async () => {
    const { again, saved } = show();

    beside('show or hide the sidebar', 'Clear').focus();
    await userEvent.keyboard('{Enter}');
    again(JSON.stringify(saved()));
    await new Promise((settle) => requestAnimationFrame(settle));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show or hide the sidebar' }));
  });
});
