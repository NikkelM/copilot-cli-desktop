// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RenamePrompt } from './RenamePrompt';

afterEach(cleanup);

const confirmButton = () =>
  screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement;

const show = (over: Partial<Parameters<typeof RenamePrompt>[0]> = {}) => {
  const props = { current: 'What it was called', onRename: vi.fn(), onClose: vi.fn(), ...over };
  render(<RenamePrompt {...props} />);
  return { ...props, field: screen.getByLabelText('Session name') as HTMLInputElement };
};

describe('RenamePrompt', () => {
  it('starts from what the session is called, since renaming is usually correcting', () => {
    expect(show().field.value).toBe('What it was called');
  });

  it('opens with the name selected, so typing replaces it', () => {
    const { field } = show();

    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('What it was called'.length);
  });

  it('renames on the button', async () => {
    const { onRename, onClose, field } = show();

    await userEvent.clear(field);
    await userEvent.type(field, 'A better name');
    await userEvent.click(confirmButton());

    expect(onRename).toHaveBeenCalledExactlyOnceWith('A better name');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renames on Enter, since one field means one answer', async () => {
    const { onRename, field } = show();

    await userEvent.clear(field);
    await userEvent.type(field, 'A better name{Enter}');

    expect(onRename).toHaveBeenCalledExactlyOnceWith('A better name');
  });

  it('trims what was typed, so a stray space is not part of the name', async () => {
    const { onRename, field } = show();

    await userEvent.clear(field);
    await userEvent.type(field, '  Spaced  {Enter}');

    expect(onRename).toHaveBeenCalledExactlyOnceWith('Spaced');
  });

  it('refuses a name that is not one', async () => {
    const { onRename, field } = show();

    await userEvent.clear(field);
    await userEvent.type(field, '   ');

    expect((confirmButton()).disabled).toBe(true);
    await userEvent.type(field, '{Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('refuses the name it already has, which would be a write for nothing', async () => {
    const { onRename } = show();

    expect((confirmButton()).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText('Session name'), '{Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('takes a name that differs only in the spaces around it as no change', async () => {
    const { onRename, field } = show();

    await userEvent.clear(field);
    await userEvent.type(field, '  What it was called  ');

    expect((confirmButton()).disabled).toBe(true);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('closes on Cancel, on Escape, and on a click outside, renaming nothing', async () => {
    const first = show();
    await userEvent.click(screen.getByText('Cancel'));
    expect(first.onClose).toHaveBeenCalledOnce();
    expect(first.onRename).not.toHaveBeenCalled();

    cleanup();
    const second = show();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(second.onClose).toHaveBeenCalledOnce();

    cleanup();
    const third = show();
    fireEvent.mouseDown(document.querySelector('.confirm-backdrop') as HTMLElement);
    expect(third.onClose).toHaveBeenCalledOnce();
  });

  it('stays open when the pointer goes down on the dialog itself', () => {
    const { onClose } = show();

    fireEvent.mouseDown(screen.getByRole('dialog'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers a name to a session that has none', () => {
    const { field } = show({ current: '' });

    expect(field.value).toBe('');
    expect((confirmButton()).disabled).toBe(true);
  });
});
