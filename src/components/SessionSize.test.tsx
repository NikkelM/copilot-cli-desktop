// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionSize } from './SessionSize';
import { singleSessionDiskUsage } from '../lib/sidecar';
import { openPath } from '@tauri-apps/plugin-opener';
import type { SessionDiskDetails } from '../../shared/protocol';

vi.mock('../lib/sidecar', () => ({ singleSessionDiskUsage: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }));

const details = (bytes = 1250): SessionDiskDetails => ({
  bytes, files: 3, logBytes: 1000, rewindBytes: 200, otherBytes: 50, directory: 'C:\\sessions\\chosen',
});

beforeEach(() => {
  vi.mocked(singleSessionDiskUsage).mockReset().mockResolvedValue(details());
  vi.mocked(openPath).mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

const show = () => {
  const onClose = vi.fn();
  const view = render(<SessionSize sessionId="chosen" title="My session" onClose={onClose} />);
  return { ...view, onClose };
};

describe('session size popup', () => {
  it('offers Open session between the folder and Close only when supplied', async () => {
    const onOpenSession = vi.fn();
    const view = render(
      <SessionSize sessionId="chosen" title="My session" onClose={() => {}} onOpenSession={onOpenSession} />,
    );
    expect(screen.getAllByRole('button').map((button) => button.textContent?.trim()))
      .toEqual(['Open session folder', 'Open session', 'Close']);
    await userEvent.click(screen.getByRole('button', { name: 'Open session' }));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    view.rerender(<SessionSize sessionId="chosen" title="My session" onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull();
  });

  it('measures only the requested session and displays its title and formatted size', async () => {
    show();
    expect(screen.getByRole('status').textContent).toBe('Measuring...');
    expect(screen.getByText('My session')).toBeTruthy();
    expect(await screen.findByText('1.3 kB')).toBeTruthy();
    expect(singleSessionDiskUsage).toHaveBeenCalledExactlyOnceWith('chosen');
  });

  it('distinguishes a zero size from a measurement still running', async () => {
    vi.mocked(singleSessionDiskUsage).mockResolvedValue({
      ...details(0), logBytes: 0, rewindBytes: 0, otherBytes: 0, files: 0,
    });
    show();
    await screen.findAllByText('0 B');
    expect(screen.getByRole('status').textContent).toBe('0 B');
  });

  it('shows measurement errors rather than reporting a zero size', async () => {
    vi.mocked(singleSessionDiskUsage).mockRejectedValue(new Error('Access denied'));
    show();
    expect((await screen.findByRole('alert')).textContent).toContain('Access denied');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('measures again on reopening rather than keeping a stale size', async () => {
    const first = show();
    await screen.findByText('1.3 kB');
    first.unmount();
    vi.mocked(singleSessionDiskUsage).mockResolvedValue(details(3000));
    show();
    expect(await screen.findByText('3 kB')).toBeTruthy();
    expect(singleSessionDiskUsage).toHaveBeenCalledTimes(2);
  });

  it('does not apply the old session answer after the target changes', async () => {
    let finish = (_size: SessionDiskDetails) => {};
    vi.mocked(singleSessionDiskUsage).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = show();
    view.rerender(<SessionSize sessionId="other" title="Other" onClose={view.onClose} />);
    await screen.findByText('1.3 kB');
    await act(async () => finish(details(999999)));
    expect(screen.getByRole('status').textContent).toBe('1.3 kB');
  });

  it('focuses Close and closes on Escape or the close button', async () => {
    const { onClose } = show();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes on the backdrop but not inside the popup', () => {
    const { onClose } = show();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector('.confirm-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the breakdown and file count', async () => {
    show();
    await screen.findByText('1.3 kB');
    const values = [...document.querySelectorAll('.session-size-breakdown dd')].map((node) => node.textContent);
    expect(values).toEqual(['1 kB', '200 B', '50 B', '3']);
    expect([...document.querySelectorAll('.session-size-breakdown dt')].map((node) => node.textContent))
      .toEqual(['Conversation log', 'Rewind backups', 'Other files', 'File count']);
  });

  it('opens the measured session folder and reports a failure to open it', async () => {
    vi.mocked(openPath).mockRejectedValue(new Error('Folder unavailable'));
    show();
    await screen.findByText('1.3 kB');
    await userEvent.click(screen.getByRole('button', { name: 'Open session folder' }));
    expect(openPath).toHaveBeenCalledExactlyOnceWith('C:\\sessions\\chosen');
    expect((await screen.findByRole('alert')).textContent).toContain('Folder unavailable');
  });

});
