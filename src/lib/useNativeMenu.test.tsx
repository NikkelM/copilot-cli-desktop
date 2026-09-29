// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useNativeMenu } from './useNativeMenu';

function Host({ children }: { children?: React.ReactNode }) {
  useNativeMenu();
  return <div data-testid="host">{children}</div>;
}

/** Right-click, and say whether anything stopped the browser drawing its own menu. */
function rightClick(target: Element): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return !event.defaultPrevented;
}

const select = (text: string) =>
  vi.spyOn(globalThis, 'getSelection').mockReturnValue({ toString: () => text } as unknown as Selection);

afterEach(() => vi.restoreAllMocks());

/**
 * The webview draws a browser's menu - Back, Refresh, Save as, Print, Inspect - which
 * describes nothing this app does, and whose first two entries would take the window away
 * from a running session (#226).
 */
describe('the menu the webview would draw', () => {
  it('is refused over the app furniture', () => {
    const { getByTestId } = render(<Host />);

    expect(rightClick(getByTestId('host'))).toBe(false);
  });

  /** A field being typed in needs cut, copy, paste and select-all as the platform draws them. */
  it('is allowed in a text box', () => {
    const { container } = render(
      <Host>
        <textarea />
      </Host>,
    );

    expect(rightClick(container.querySelector('textarea')!)).toBe(true);
  });

  it('is allowed in a single-line field', () => {
    const { container } = render(
      <Host>
        <input />
      </Host>,
    );

    expect(rightClick(container.querySelector('input')!)).toBe(true);
  });

  it('is allowed in anything made editable', () => {
    const { container } = render(
      <Host>
        <div contentEditable data-testid="rich" />
      </Host>,
    );

    expect(rightClick(container.querySelector('[contenteditable]')!)).toBe(true);
  });

  // The attribute can say no as well as yes, and saying no is not an editable field.
  it('is refused in one that says it is not editable', () => {
    const { container } = render(
      <Host>
        <div contentEditable={false} data-testid="plain" />
      </Host>,
    );

    expect(rightClick(container.querySelector('[contenteditable]')!)).toBe(false);
  });

  /** Clicking inside a field usually lands on something within it rather than the field. */
  it('is allowed on what sits inside an editable area', () => {
    const { container } = render(
      <Host>
        <div contentEditable>
          <span data-testid="inner">words</span>
        </div>
      </Host>,
    );

    expect(rightClick(container.querySelector('[data-testid="inner"]')!)).toBe(true);
  });

  /** Copying what has been selected is the other thing the native menu is for. */
  it('is allowed where text has been selected', () => {
    select('something worth copying');
    const { getByTestId } = render(<Host />);

    expect(rightClick(getByTestId('host'))).toBe(true);
  });

  it('is refused where the selection is empty space', () => {
    select('   ');
    const { getByTestId } = render(<Host />);

    expect(rightClick(getByTestId('host'))).toBe(false);
  });

  /** Nothing is left listening, or every window this mounts in would answer for the others. */
  it('stops deciding once it is gone', () => {
    const { unmount } = render(<Host />);
    unmount();

    expect(rightClick(document.body)).toBe(true);
  });
});
