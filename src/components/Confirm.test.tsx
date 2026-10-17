// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Confirm } from './Confirm';

afterEach(cleanup);

const show = (over: Partial<Parameters<typeof Confirm>[0]> = {}) =>
  render(
    <Confirm
      title="Delete this session?"
      body="Everything it wrote will go."
      confirmLabel="Delete session"
      remember="Do not ask again"
      onConfirm={() => {}}
      onCancel={() => {}}
      {...over}
    />,
  );

describe('Confirm', () => {
  it('says what will happen before asking', () => {
    show();

    expect(screen.getByText('Delete this session?')).toBeTruthy();
    expect(screen.getByText('Everything it wrote will go.')).toBeTruthy();
  });

  it('confirms when the confirming button is pressed', async () => {
    const onConfirm = vi.fn();
    show({ onConfirm });

    await userEvent.click(screen.getByText('Delete session'));

    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('passes on that the reader asked not to be asked again', async () => {
    const onConfirm = vi.fn();
    show({ onConfirm });

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByText('Delete session'));

    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not offer to stop asking when the question cannot be skipped', () => {
    show({ remember: undefined });

    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('can name the safe way out for the decision being asked', () => {
    show({ cancelLabel: 'Later' });

    expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(document.activeElement?.textContent).toBe('Later');
  });

  it('can keep a reversible confirmation out of destructive styling', () => {
    show({ destructive: false });

    expect(screen.getByRole('button', { name: 'Delete session' }).classList.contains('confirm-go')).toBe(false);
  });

  it('cancels rather than confirming on Escape', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    show({ onCancel, onConfirm });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels when the pointer goes down outside the dialog', () => {
    const onCancel = vi.fn();
    show({ onCancel });

    fireEvent.mouseDown(document.querySelector('.confirm-backdrop') as HTMLElement);

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('stays open when the pointer goes down on the dialog itself', () => {
    const onCancel = vi.fn();
    show({ onCancel });

    fireEvent.mouseDown(screen.getByRole('alertdialog'));

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('opens with the way out focused, not the way through', () => {
    // A reader who dismisses dialogs by reflex should not delete anything by pressing Enter.
    show();

    expect(document.activeElement?.textContent).toBe('Cancel');
  });
});
