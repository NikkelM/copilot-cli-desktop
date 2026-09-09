// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Attachments } from './Attachments';
import type { Attachment } from '../../shared/protocol';

const open = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...args: unknown[]) => open(...args) }));

const revealItemInDir = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: (...args: unknown[]) => revealItemInDir(...args),
}));

const previewImage = vi.fn();
vi.mock('../lib/sidecar', () => ({ previewImage: (...args: unknown[]) => previewImage(...args) }));

beforeEach(() => {
  open.mockReset();
  revealItemInDir.mockReset().mockResolvedValue(undefined);
  previewImage.mockReset().mockResolvedValue('data:image/png;base64,AAA');
});

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
    expect(screen.getByTitle('Show C:\\work\\shot.png in its folder')).toBeTruthy();
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

describe('looking at what is attached', () => {
  // The folder rather than the file: opening it hands it to whatever claims the extension.
  it('reveals the file in its folder when clicked', async () => {
    show([file('C:\\work\\shot.png')]);

    await userEvent.click(screen.getByText('shot.png'));

    expect(revealItemInDir).toHaveBeenCalledWith('C:\\work\\shot.png');
  });

  it('shows the picture on hover', async () => {
    show([file('C:\\work\\shot.png')]);

    await userEvent.hover(screen.getByText('shot.png'));

    const preview = await screen.findByRole('img');
    expect(preview.getAttribute('src')).toBe('data:image/png;base64,AAA');
  });

  it('takes it away again on leaving', async () => {
    show([file('C:\\work\\shot.png')]);

    await userEvent.hover(screen.getByText('shot.png'));
    await screen.findByRole('img');
    await userEvent.unhover(screen.getByText('shot.png'));

    expect(screen.queryByRole('img')).toBeNull();
  });

  /** Reading the file is the sidecar's disk, so moving along a row should not re-read it. */
  it('reads each file once however often it is hovered', async () => {
    show([file('C:\\work\\shot.png')]);

    await userEvent.hover(screen.getByText('shot.png'));
    await screen.findByRole('img');
    await userEvent.unhover(screen.getByText('shot.png'));
    await userEvent.hover(screen.getByText('shot.png'));

    expect(previewImage).toHaveBeenCalledTimes(1);
  });

  // Deciding here saves a round trip that could only ever answer no.
  it('does not ask about a file that is not an image', async () => {
    show([file('C:\\work\\notes.log')]);

    await userEvent.hover(screen.getByText('notes.log'));

    expect(previewImage).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  // Too large, unreadable, or not really a PNG. A missing preview is the whole consequence.
  it('shows nothing when there is nothing to show', async () => {
    previewImage.mockResolvedValue(null);
    show([file('C:\\work\\shot.png')]);

    await userEvent.hover(screen.getByText('shot.png'));

    await vi.waitFor(() => expect(previewImage).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
  });
});
