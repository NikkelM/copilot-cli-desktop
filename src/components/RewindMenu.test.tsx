// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RewindPoint, RewindPreview } from '../../shared/protocol';
import { RewindMenu } from './RewindMenu';

afterEach(cleanup);

const point = (eventId: string, message: string, over: Partial<RewindPoint> = {}): RewindPoint => ({
  eventId,
  message,
  at: '2026-09-27T10:00:00.000Z',
  canRestoreFiles: true,
  fileCount: 1,
  linesAdded: 3,
  linesRemoved: 1,
  ...over,
});

const preview = (over: Partial<RewindPreview> = {}): RewindPreview => ({
  available: true,
  files: [{ path: 'F:\\work\\one.ts', status: 'modified', linesAdded: 3, linesRemoved: 1 }],
  ...over,
});

const show = (over: Partial<Parameters<typeof RewindMenu>[0]> = {}) => {
  const onPick = vi.fn();
  const onRewind = vi.fn();
  const onClose = vi.fn();
  render(
    <RewindMenu
      points={[point('e1', 'first thing'), point('e2', 'second thing'), point('e3', 'third thing')]}
      loading={false}
      failed={null}
      unavailable={null}
      picked={null}
      preview={null}
      cwd={'F:\\work'}
      onPick={onPick}
      onRewind={onRewind}
      onClose={onClose}
      {...over}
    />,
  );
  return { onPick, onRewind, onClose };
};

const options = () => [...document.querySelectorAll('.rewind-point')];
const chosen = () => document.querySelector('[aria-selected="true"]')?.textContent ?? '';

describe('choosing where to rewind to', () => {
  it('lists the turns', () => {
    show();

    expect(screen.getByText('first thing')).toBeTruthy();
    expect(screen.getByText('third thing')).toBeTruthy();
  });

  /**
   * Counting back from now, as the CLI numbers them: the turn somebody wants is almost
   * always a recent one, and "three turns ago" is how they think of it.
   */
  it('numbers them from the end', () => {
    show();

    expect(options()[0]?.textContent).toContain('3.');
    expect(options()[2]?.textContent).toContain('1.');
  });

  // The newest is the one most often wanted.
  it('starts on the most recent', () => {
    show();

    expect(chosen()).toContain('third thing');
  });

  it('walks the list with the arrow keys', async () => {
    show();

    await userEvent.keyboard('{ArrowUp}');
    expect(chosen()).toContain('second thing');

    await userEvent.keyboard('{ArrowDown}');
    expect(chosen()).toContain('third thing');
  });

  it('stops at either end rather than wrapping', async () => {
    show();

    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(chosen()).toContain('third thing');

    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(chosen()).toContain('first thing');
  });

  it('picks the turn on Enter', async () => {
    const { onPick } = show();

    await userEvent.keyboard('{ArrowUp}{Enter}');

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e2' }));
  });

  it('picks the turn that was clicked', async () => {
    const { onPick } = show();

    await userEvent.click(screen.getByText('first thing'));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e1' }));
  });

  it('closes on Escape', async () => {
    const { onClose } = show();

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('says why a session cannot be rewound', () => {
    show({ points: [], unavailable: 'busy' });

    expect(screen.getByText(/still working/)).toBeTruthy();
  });

  it('says when a session has nothing to go back to', () => {
    show({ points: [] });

    expect(screen.getByText(/no turns to go back to/)).toBeTruthy();
  });

  // A turn that changed nothing has no counts to show, and showing zeroes would be noise.
  it('shows what a turn changed only when it changed something', () => {
    show({ points: [point('e1', 'just talked', { fileCount: 0, linesAdded: 0, linesRemoved: 0 })] });

    expect(document.querySelector('.rewind-point .tool-counts')).toBeNull();
  });
});

describe('choosing what to rewind', () => {
  const picked = point('e2', 'second thing');

  it('names the turn being rewound', () => {
    show({ picked, preview: preview() });

    expect(screen.getByText('second thing')).toBeTruthy();
  });

  /** The conversation goes whichever option is taken, and that is the part that cannot be undone. */
  it('says the conversation does not come back', () => {
    show({ picked, preview: preview() });

    expect(screen.getByText(/does not come back/)).toBeTruthy();
  });

  it('rewinds the conversation alone, leaving the files', async () => {
    const { onRewind } = show({ picked, preview: preview() });

    await userEvent.click(screen.getByText('Conversation only'));

    expect(onRewind).toHaveBeenCalledWith(picked, false);
  });

  it('rewinds the files too when that is chosen', async () => {
    const { onRewind } = show({ picked, preview: preview() });

    await userEvent.click(screen.getByText('Conversation and files'));

    expect(onRewind).toHaveBeenCalledWith(picked, true);
  });

  it('lists the files it would put back', () => {
    show({ picked, preview: preview() });

    expect(screen.getByText('one.ts')).toBeTruthy();
  });

  /**
   * The turn says whether anything was captured; the preview says whether it can still be
   * restored. Offering it before both agree would offer something that then failed.
   */
  it('waits for the preview before offering the files', () => {
    show({ picked, preview: null });

    const files = screen.getByText('Conversation and files').closest('button');
    expect(files?.disabled).toBe(true);
  });

  it('does not offer the files when there are none to put back', () => {
    show({ picked, preview: preview({ files: [] }) });

    const files = screen.getByText('Conversation and files').closest('button');
    expect(files?.disabled).toBe(true);
    expect(screen.getByText(/No file changes to put back/)).toBeTruthy();
  });

  it('does not offer the files when the turn never captured any', () => {
    show({ picked: point('e2', 'second thing', { canRestoreFiles: false }), preview: preview() });

    expect(screen.getByText('Conversation and files').closest('button')?.disabled).toBe(true);
  });

  // Arrowing onto a disabled choice and pressing Enter must not do the thing beside it.
  it('does nothing when the files are chosen but not on offer', async () => {
    const { onRewind } = show({ picked, preview: preview({ files: [] }) });

    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(onRewind).not.toHaveBeenCalled();
  });

  it('cancels from the last choice', async () => {
    const { onClose, onRewind } = show({ picked, preview: preview() });

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onClose).toHaveBeenCalled();
    expect(onRewind).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const { onClose } = show({ picked, preview: preview() });

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });
});
