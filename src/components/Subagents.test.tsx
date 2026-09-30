// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DelegatedTask } from '../../shared/protocol';

const sessionAgents = vi.fn();
vi.mock('../lib/sidecar', () => ({ sessionAgents: (...args: unknown[]) => sessionAgents(...args) }));

const { Subagents } = await import('./Subagents');

const task = (over: Partial<DelegatedTask> = {}): DelegatedTask => ({
  agentId: 'a1',
  name: 'deep-audit',
  startedAt: new Date(Date.now() - 5 * 60000).toISOString(),
  outcome: 'completed',
  toolCalls: 12,
  tokens: 48000,
  durationMs: 90000,
  offset: 400,
  ...over,
});

const page = (agents: DelegatedTask[], over: { truncated?: boolean; nextBefore?: number | null } = {}) => ({
  agents,
  truncated: false,
  nextBefore: null,
  ...over,
});

const shown = (over: Record<string, unknown> = {}) =>
  render(
    <Subagents
      sessionId="s1"
      isShown={() => false}
      isKept={() => false}
      onToggleShown={() => {}}
      onKeep={() => {}}
      onOpen={() => {}}
      onClose={() => {}}
      {...over}
    />,
  );

beforeEach(() => {
  sessionAgents.mockReset().mockResolvedValue(page([task()]));
});

/**
 * Every task a session delegated, read from its log (#228).
 *
 * The sidebar lists only what this app watched start, so a hidden task, one from a previous
 * run, and one from a session used in a terminal are all unreachable from it.
 */
describe('finding the tasks a session delegated', () => {
  it('asks the log about the session it was opened on', async () => {
    shown({ sessionId: 's7' });

    await waitFor(() => expect(sessionAgents).toHaveBeenCalledWith('s7'));
  });

  it('lists what came back', async () => {
    shown();

    expect(await screen.findByText('deep-audit')).toBeTruthy();
  });

  /** Reading a large log takes a moment, and an empty panel looks like an empty answer. */
  it('says it is reading while the log is on its way', () => {
    sessionAgents.mockReturnValue(new Promise(() => undefined));
    shown();

    expect(screen.getByText('Reading the conversation.')).toBeTruthy();
  });

  it('says when a session delegated nothing', async () => {
    sessionAgents.mockResolvedValue(page([]));
    shown();

    expect(await screen.findByText('This session has not delegated anything.')).toBeTruthy();
  });

  it('says why the log could not be read', async () => {
    sessionAgents.mockRejectedValue(new Error('no log'));
    shown();

    await waitFor(() => expect(screen.getByText(/no log/)).toBeTruthy());
  });

  it('reports what a finished task came to', async () => {
    shown();

    expect(await screen.findByText(/12 tool calls/)).toBeTruthy();
  });

  it('says when one is still working', async () => {
    sessionAgents.mockResolvedValue(page([task({ outcome: undefined })]));
    shown();

    expect(await screen.findByText('working')).toBeTruthy();
  });

  it('says when one failed', async () => {
    sessionAgents.mockResolvedValue(page([task({ outcome: 'failed' })]));
    shown();

    expect(await screen.findByText('failed')).toBeTruthy();
  });

  describe('choosing what the sidebar shows', () => {
    it('asks for a task to be shown', async () => {
      const onToggleShown = vi.fn();
      shown({ onToggleShown });
      await screen.findByText('deep-audit');

      await userEvent.click(screen.getByRole('checkbox'));

      expect(onToggleShown).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }));
    });

    it('draws one already on the list as shown', async () => {
      shown({ isShown: () => true });
      await screen.findByText('deep-audit');

      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    });

    /** Keeping something that cannot be reached means nothing, so a kept task stays shown. */
    it('refuses to hide a task that is being kept', async () => {
      shown({ isShown: () => true, isKept: () => true });
      await screen.findByText('deep-audit');

      expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    });
  });

  describe('keeping one', () => {
    it('asks for a task to be kept', async () => {
      const onKeep = vi.fn();
      shown({ onKeep });
      await screen.findByText('deep-audit');

      await userEvent.click(screen.getByRole('button', { name: 'Keep deep-audit' }));

      expect(onKeep).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }));
    });

    it('offers the way back out for one already kept', async () => {
      shown({ isKept: () => true });
      await screen.findByText('deep-audit');

      expect(screen.getByRole('button', { name: 'Stop keeping deep-audit' })).toBeTruthy();
    });
  });

  it('opens what a task did', async () => {
    const onOpen = vi.fn();
    shown({ onOpen });
    await screen.findByText('deep-audit');

    await userEvent.click(screen.getByRole('button', { name: 'Read what deep-audit did' }));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }));
  });

  /**
   * The rest of a large log is seconds of reading, and the task somebody is looking for is
   * usually a recent one, so the rest is offered rather than paid for.
   */
  describe('the rest of the log', () => {
    const first = page([task()], { truncated: true, nextBefore: 900 });

    it('offers to look further back when there is more', async () => {
      sessionAgents.mockResolvedValue(first);
      shown();

      expect(await screen.findByRole('button', { name: 'Look further back' })).toBeTruthy();
    });

    it('offers nothing more when the log is exhausted', async () => {
      shown();
      await screen.findByText('deep-audit');

      expect(screen.queryByRole('button', { name: 'Look further back' })).toBeNull();
    });

    it('carries on where the page before it stopped', async () => {
      sessionAgents.mockResolvedValueOnce(first).mockResolvedValueOnce(page([task({ agentId: 'a2' })]));
      shown();
      await screen.findByRole('button', { name: 'Look further back' });

      await userEvent.click(screen.getByRole('button', { name: 'Look further back' }));

      await waitFor(() => expect(sessionAgents).toHaveBeenLastCalledWith('s1', undefined, 900));
    });

    // The two are halves of one list, and the reader asked for more of it.
    it('adds to the list rather than replacing it', async () => {
      sessionAgents
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(page([task({ agentId: 'a2', name: 'older-task' })]));
      shown();
      await screen.findByRole('button', { name: 'Look further back' });

      await userEvent.click(screen.getByRole('button', { name: 'Look further back' }));

      expect(await screen.findByText('older-task')).toBeTruthy();
      expect(screen.getByText('deep-audit')).toBeTruthy();
    });
  });

  it('closes when asked', async () => {
    const onClose = vi.fn();
    shown({ onClose });

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalled();
  });

  /** The key a reader reaches for, and the one every other panel already answers. */
  it('closes on escape', async () => {
    const onClose = vi.fn();
    shown({ onClose });

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  /** A window over the app closes by clicking away from it, as the settings window does. */
  it('closes when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    const { container } = shown({ onClose });

    await userEvent.click(container.querySelector('.confirm-backdrop')!);

    expect(onClose).toHaveBeenCalled();
  });

  it('stays open when the panel itself is clicked', async () => {
    const onClose = vi.fn();
    shown({ onClose });
    await screen.findByText('deep-audit');

    await userEvent.click(screen.getByRole('dialog'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops answering escape once it is gone', async () => {
    const onClose = vi.fn();
    const { unmount } = shown({ onClose });
    unmount();

    await userEvent.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
  });
});
