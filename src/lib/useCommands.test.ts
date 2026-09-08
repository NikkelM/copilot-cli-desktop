// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommand } from '../../shared/protocol';
import { useCommands } from './useCommands';

const listCommands = vi.fn();

vi.mock('./sidecar', () => ({
  listCommands: (id?: string) => listCommands(id),
}));

function command(name: string): SlashCommand {
  return { name, description: `the ${name} command`, aliases: [], allowDuringTurn: true };
}

/** What a client with no session knows, against what a loaded one adds to it. */
const cold = [command('model'), command('review')];
const live = [...cold, command('session'), command('usage')];

beforeEach(() => {
  localStorage.clear();
  listCommands.mockReset().mockResolvedValue(cold);
});

describe('useCommands', () => {
  // Asking costs a server process, which is not spent on something nobody asked for.
  it('asks for nothing until the menu is opened', () => {
    renderHook(() => useCommands('s1'));

    expect(listCommands).not.toHaveBeenCalled();
  });

  it('asks once when the menu is opened with nothing to show', async () => {
    const { result } = renderHook(() => useCommands('s1'));

    act(() => result.current.open());
    await waitFor(() => expect(result.current.commands).toHaveLength(3));

    act(() => result.current.open());
    expect(listCommands).toHaveBeenCalledTimes(1);
  });

  it('remembers what it was told, so the next run answers without asking', async () => {
    const { result, unmount } = renderHook(() => useCommands('s1'));
    act(() => result.current.open());
    await waitFor(() => expect(result.current.commands).toHaveLength(3));
    unmount();

    const second = renderHook(() => useCommands('s1'));

    expect(second.result.current.commands).toHaveLength(3);
    act(() => second.result.current.open());
    expect(listCommands).toHaveBeenCalledTimes(1);
  });

  it('takes the better list once a session is awake', async () => {
    listCommands.mockResolvedValue(live);
    const { result } = renderHook(() => useCommands('s1'));

    act(() => result.current.observe(true, 's1'));

    await waitFor(() => expect(result.current.commands.map((c) => c.name)).toContain('session'));
    expect(listCommands).toHaveBeenCalledWith('s1');
  });

  it('does not ask on behalf of a session that is still asleep', () => {
    const { result } = renderHook(() => useCommands('s1'));

    act(() => result.current.observe(false, 's1'));

    expect(listCommands).not.toHaveBeenCalled();
  });

  // The reason /session went missing: a cold answer arriving after a live one used to
  // decide what existed, taking the session-only commands with it.
  it('keeps what a session taught it when a later answer is narrower', async () => {
    listCommands.mockResolvedValue(live);
    const { result } = renderHook(() => useCommands('s1'));
    act(() => result.current.observe(true, 's1'));
    await waitFor(() => expect(result.current.commands).toHaveLength(5));

    listCommands.mockResolvedValue(cold);
    act(() => result.current.observe(true, 's2'));

    await waitFor(() => expect(listCommands).toHaveBeenCalledTimes(2));
    expect(result.current.commands.map((c) => c.name)).toEqual(['help', 'model', 'review', 'session', 'usage']);
  });

  it('prefers the newer definition of a command it already knew', async () => {
    const { result } = renderHook(() => useCommands('s1'));
    act(() => result.current.open());
    await waitFor(() => expect(result.current.commands).toHaveLength(3));

    listCommands.mockResolvedValue([{ ...command('model'), description: 'now says something else' }]);
    act(() => result.current.observe(true, 's1'));

    await waitFor(() =>
      expect(result.current.commands.find((c) => c.name === 'model')?.description).toBe('now says something else'),
    );
    expect(result.current.commands).toHaveLength(3);
  });

  it('ignores a remembered entry that is missing what the menu reads', () => {
    localStorage.setItem('copilot-desktop.commands', JSON.stringify([{ name: 'model' }]));

    const { result } = renderHook(() => useCommands('s1'));

    expect(result.current.commands.map((c) => c.name)).toEqual(['help']);
  });

  it('reports a refusal rather than showing an empty menu', async () => {
    listCommands.mockRejectedValue(new Error('no runtime'));
    const { result } = renderHook(() => useCommands('s1'));

    act(() => result.current.open());

    await waitFor(() => expect(result.current.failed).toContain('no runtime'));
  });

  // The runtime's list is the CLI's engine, not its interface: what this app implements
  // itself has to be added to the list, or it would be missing from the menu that lists
  // everything there is.
  describe('the commands this app answers itself', () => {
    it('offers them before anything has been asked for', () => {
      const { result } = renderHook(() => useCommands('s1'));

      expect(result.current.commands.map((c) => c.name)).toEqual(['help']);
    });

    it('still asks the runtime, since ours are not an answer to the menu being opened', async () => {
      const { result } = renderHook(() => useCommands('s1'));

      act(() => result.current.open());

      await waitFor(() => expect(listCommands).toHaveBeenCalledTimes(1));
    });

    it('does not remember them, so a renamed one cannot outlive the build that named it', async () => {
      const { result } = renderHook(() => useCommands('s1'));
      act(() => result.current.open());
      await waitFor(() => expect(result.current.commands).toHaveLength(3));

      const stored: SlashCommand[] = JSON.parse(localStorage.getItem('copilot-desktop.commands') ?? '[]');
      expect(stored.map((c) => c.name)).toEqual(['model', 'review']);
    });
  });
});
