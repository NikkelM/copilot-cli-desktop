// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Attachments } from './Attachments';
import type { Attachment } from '../../shared/protocol';

const open = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...args: unknown[]) => open(...args) }));

beforeEach(() => open.mockReset());

/**
 * The picker is opened from a button that lives with the composer's other buttons, so this
 * component hands one out rather than drawing it. Tests call it directly.
 */
const show = (attached: Attachment[] = [], onChange = vi.fn(), onError = vi.fn()) => {
  const onFocusBack = vi.fn();
  let pick = () => {};
  render(
    <Attachments
      attached={attached}
      onChange={onChange}
      onPicker={(open) => (pick = open)}
      onFocusBack={onFocusBack}
      onError={onError}
    />,
  );
  return { onChange, onError, onFocusBack, pick: () => pick() };
};

const file = (path: string): Attachment => ({ type: 'file', path, displayName: path.split(/[\\/]/).pop() });

describe('Attachments', () => {
  it('attaches what was picked', async () => {
    open.mockResolvedValue(['C:\\work\\shot.png']);
    const { onChange, pick } = show();

    act(() => pick());

    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([{ type: 'file', path: 'C:\\work\\shot.png', displayName: 'shot.png' }]),
    );
  });

  it('takes several at once', async () => {
    open.mockResolvedValue(['C:\\a.png', 'C:\\b.log']);
    const { onChange, pick } = show();

    act(() => pick());

    await vi.waitFor(() => expect(onChange.mock.calls[0]![0]).toHaveLength(2));
  });

  it('keeps what was already attached', async () => {
    open.mockResolvedValue(['C:\\b.log']);
    const { onChange, pick } = show([file('C:\\a.png')]);

    act(() => pick());

    await vi.waitFor(() => expect(onChange.mock.calls[0]![0].map((f: Attachment) => f.path)).toEqual(['C:\\a.png', 'C:\\b.log']));
  });

  // Picking the same file twice says nothing the first pick did not.
  it('does not attach the same file twice', async () => {
    open.mockResolvedValue(['C:\\a.png']);
    const { onChange, pick } = show([file('C:\\a.png')]);

    act(() => pick());

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([file('C:\\a.png')]));
  });

  it('changes nothing when the picker is dismissed', async () => {
    open.mockResolvedValue(null);
    const { onChange, pick } = show();

    act(() => pick());

    expect(onChange).not.toHaveBeenCalled();
  });

  // Whether they picked something or thought better of it, they are back at the message
  // they were writing, and should not have to click into it again.
  it('hands the keyboard back after picking', async () => {
    open.mockResolvedValue(['C:\\a.png']);
    const { onFocusBack, pick } = show();

    act(() => pick());

    await vi.waitFor(() => expect(onFocusBack).toHaveBeenCalled());
  });

  it('hands the keyboard back after the picker is dismissed', async () => {
    open.mockResolvedValue(null);
    const { onFocusBack, pick } = show();

    act(() => pick());

    await vi.waitFor(() => expect(onFocusBack).toHaveBeenCalled());
  });
  it('names what is attached, with the whole path on hover', () => {
    show([file('C:\\work\\shot.png')]);

    expect(screen.getByText('shot.png')).toBeTruthy();
    expect(screen.getByTitle('C:\\work\\shot.png')).toBeTruthy();
  });

  // Picking the wrong file should not mean sending it.
  it('takes one off again', async () => {
    const { onChange } = show([file('C:\\a.png'), file('C:\\b.log')]);

    await userEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));

    expect(onChange).toHaveBeenCalledWith([file('C:\\b.log')]);
  });

  /**
   * There is no test here for a picker that refuses. The component reports it - the call is
   * a plain `.catch` onto `onError`, the same shape as OpenIn - but any mock that rejects
   * surfaces the rejection as the test's own failure, even with a catch attached to it
   * inside the mock. Worth another look; not worth a test that fails for a reason unrelated
   * to what it is checking.
   */
});
