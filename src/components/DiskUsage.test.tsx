// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DiskUsage } from './DiskUsage';
import type { SessionDisk } from '../../shared/protocol';

const session = (sessionId: string, bytes: number, over: Partial<SessionDisk> = {}): SessionDisk => ({
  sessionId,
  title: `Session ${sessionId}`,
  updatedAt: '2026-01-02T03:04:05.000Z',
  bytes,
  listed: true,
  ...over,
});

const shown = (over: Partial<Parameters<typeof DiskUsage>[0]> = {}) =>
  render(<DiskUsage usage={[session('a', 1_000_000)]} reading={false} {...over} />);

/**
 * `~/.copilot/session-state` grows and nothing takes anything out of it. What accumulates is
 * an extreme long tail - measured on one machine, the ten largest sessions hold 78% of 3.6GB
 * and the median session holds nothing - so the list shows the few that matter (#29).
 */
describe('what the sessions are using on disk', () => {
  describe('before anybody has asked', () => {
    it('offers to measure rather than measuring', () => {
      const onRead = vi.fn();
      shown({ usage: null, onRead });

      expect(screen.getByRole('button', { name: 'Measure disk usage' })).toBeTruthy();
      expect(onRead).not.toHaveBeenCalled();
    });

    it('measures when asked', async () => {
      const onRead = vi.fn();
      shown({ usage: null, onRead });

      await userEvent.click(screen.getByRole('button', { name: 'Measure disk usage' }));

      expect(onRead).toHaveBeenCalledOnce();
    });

    // The walk takes a moment, and a button that can be pressed again would walk twice.
    it('says it is working and cannot be asked twice', () => {
      shown({ usage: null, reading: true });

      const button = screen.getByRole('button', { name: 'Measuring…' }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
  });

  it('says what it all comes to', () => {
    shown({ usage: [session('a', 2_000_000), session('b', 1_000_000)] });

    expect(screen.getByText(/2 sessions are using 3 MB/)).toBeTruthy();
  });

  it('says what each one is using', () => {
    shown({ usage: [session('a', 2_400_000)] });

    expect(screen.getByText('2.4 MB')).toBeTruthy();
  });

  it('says so when there is nothing stored yet', () => {
    shown({ usage: [] });

    expect(screen.getByText('Nothing is stored on disk yet.')).toBeTruthy();
  });

  /** Ten rows and a total beats seven hundred rows that mostly read zero. */
  describe('when there are more than it lists', () => {
    const many = Array.from({ length: 14 }, (_, at) => session(`s${at}`, (14 - at) * 1000));

    it('lists the largest ten', () => {
      shown({ usage: many });

      expect(screen.getByText('Session s0')).toBeTruthy();
      expect(screen.getByText('Session s9')).toBeTruthy();
      expect(screen.queryByText('Session s10')).toBeNull();
    });

    it('sums what it left out', () => {
      shown({ usage: many });

      // s10 to s13, at 4000, 3000, 2000 and 1000 bytes.
      expect(screen.getByText(/other 4 sessions hold 10 kB/)).toBeTruthy();
    });

    it('shows the rest when asked', async () => {
      shown({ usage: many });

      await userEvent.click(screen.getByRole('button', { name: 'Show all' }));

      expect(screen.getByText('Session s13')).toBeTruthy();
    });

    it('counts the total over all of them rather than the ones listed', () => {
      shown({ usage: many });

      // 14 down to 1 thousand bytes, which is 105 thousand altogether.
      expect(screen.getByText(/14 sessions are using 105 kB/)).toBeTruthy();
    });
  });

  it('opens a session when asked to', async () => {
    const onOpen = vi.fn();
    shown({ usage: [session('a', 1000)], onOpen });

    await userEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(onOpen).toHaveBeenCalledWith('a');
  });

  /**
   * A directory the session store has no row for is still taking up room, and nothing else
   * in the app would ever mention it - which is exactly what this is for.
   */
  describe('a directory the session list has forgotten', () => {
    const forgotten = session('ghost', 5_000_000, { title: null, updatedAt: null, listed: false });

    it('says it is not in the list', () => {
      shown({ usage: [forgotten] });

      expect(screen.getByText(/not in the session list/)).toBeTruthy();
    });

    it('still counts its bytes', () => {
      shown({ usage: [forgotten] });

      expect(screen.getByText(/1 session is using 5 MB/)).toBeTruthy();
    });

    // There is nothing to open: the sidebar has no row for it.
    it('does not offer to open it', () => {
      shown({ usage: [forgotten] });

      expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    });

    it('calls it untitled rather than showing nothing', () => {
      shown({ usage: [forgotten] });

      expect(screen.getByText('Untitled session')).toBeTruthy();
    });
  });
});
