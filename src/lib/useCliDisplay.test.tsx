// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCliDisplay, OLD_REASONING, ASSUMED_DISPLAY } from './useCliDisplay';
import { read, resetStores, save } from './store';

const { cliSettingValues, writeCliSettings } = vi.hoisted(() => ({
  cliSettingValues: vi.fn(),
  writeCliSettings: vi.fn(),
}));
vi.mock('./sidecar', () => ({ cliSettingValues, writeCliSettings }));

beforeEach(() => {
  resetStores();
  cliSettingValues.mockReset().mockResolvedValue({});
  writeCliSettings.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('what the transcript draws', () => {
  /**
   * Unset means the CLI falls back to a default of its own, which is not written down
   * anywhere this can read - so the answer is what this app already drew.
   */
  it('draws everything until the CLI says otherwise', async () => {
    const { result } = renderHook(() => useCliDisplay());

    expect(result.current.display).toEqual({
      showReasoning: true,
      taskbarPresence: true,
      showTimestamps: true,
      showToolDurations: true,
      commandHistoryMaxSize: 50,
      footer: {
        showDirectory: true,
        showBranch: true,
        showContextWindow: true,
        showModelEffort: true,
        showAgent: true,
        showCodeChanges: true,
      },
    });
  });

  /**
   * `/statusline` and its `/footer` alias look like terminal configuration and are not:
   * every toggle names something a reader decided they did not want to see, and most name
   * something this window has its own version of (#130).
   */
  describe('what the CLI says its footer shows', () => {
    it('follows a part turned off there', async () => {
      cliSettingValues.mockResolvedValue({ footer: { showDirectory: false, showAgent: false } });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.footer.showDirectory).toBe(false));
      expect(result.current.display.footer.showAgent).toBe(false);
      // Not named, so it keeps what the CLI shows by default rather than following the rest off.
      expect(result.current.display.footer.showBranch).toBe(true);
    });

    /** Nothing writes the object until `/statusline` does, so most installs have no key. */
    it('draws all of it where the CLI has never been asked', async () => {
      cliSettingValues.mockResolvedValue({ showReasoning: false });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.showReasoning).toBe(false));
      expect(result.current.display.footer).toEqual(ASSUMED_DISPLAY.footer);
    });

    /** Only an exact false hides anything, as everywhere else here. */
    it.each([['no'], [0], [null], [undefined]])('is unmoved by %p', async (value) => {
      cliSettingValues.mockResolvedValue({ footer: { showDirectory: value } });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.footer.showDirectory).toBe(true));
    });

    it('is unmoved by a footer that is not an object', async () => {
      cliSettingValues.mockResolvedValue({ footer: 'yes', showReasoning: false });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.showReasoning).toBe(false));
      expect(result.current.display.footer).toEqual(ASSUMED_DISPLAY.footer);
    });
  });

  it('answers to what the CLI is set to', async () => {
    cliSettingValues.mockResolvedValue({ showReasoning: false, showToolDurations: false, taskbarPresence: false });
    const { result } = renderHook(() => useCliDisplay());

    await waitFor(() => expect(result.current.display.showReasoning).toBe(false));
    expect(result.current.display.showToolDurations).toBe(false);
    expect(result.current.display.taskbarPresence).toBe(false);
    // Not set, so it keeps what the app drew rather than following the others off.
    expect(result.current.display.showTimestamps).toBe(true);
  });

  /**
   * The bounds are the CLI's own, quoted in its schema: "1-1000. Defaults to 50." Held to
   * here as well, because this reads a file somebody can type anything into.
   */
  describe('how far back the prompts go', () => {
    it('takes the number the CLI was given', async () => {
      cliSettingValues.mockResolvedValue({ commandHistoryMaxSize: 8 });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.commandHistoryMaxSize).toBe(8));
    });

    it('will not go below one, which would leave nothing to recall', async () => {
      cliSettingValues.mockResolvedValue({ commandHistoryMaxSize: 0 });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.commandHistoryMaxSize).toBe(1));
    });

    it('will not go above the thousand the CLI stops at', async () => {
      cliSettingValues.mockResolvedValue({ commandHistoryMaxSize: 99_999 });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.commandHistoryMaxSize).toBe(1000));
    });

    /**
     * Waits on a setting that does change, since the one under test falls back to what the
     * app already had - so there is no telling a read that landed from one still on its way.
     */
    it('falls back to fifty for a value that is not a number', async () => {
      cliSettingValues.mockResolvedValue({ commandHistoryMaxSize: '20', showReasoning: false });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.showReasoning).toBe(false));
      expect(result.current.display.commandHistoryMaxSize).toBe(50);
    });

    // A number that is not one would clamp to itself and leave the history unreachable
    // without saying so.
    it('falls back to fifty for a number that is no number at all', async () => {
      cliSettingValues.mockResolvedValue({ commandHistoryMaxSize: Number.NaN, showReasoning: false });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.showReasoning).toBe(false));
      expect(result.current.display.commandHistoryMaxSize).toBe(50);
    });

    it('rounds a fraction down rather than keeping part of a prompt', async () => {
      cliSettingValues.mockResolvedValue({ commandHistoryMaxSize: 7.9 });
      const { result } = renderHook(() => useCliDisplay());

      await waitFor(() => expect(result.current.display.commandHistoryMaxSize).toBe(7));
    });
  });

  /** Only the exact stored false turns one off, so nothing unexpected can hide anything. */
  it('keeps drawing for a value that is not exactly false', async () => {
    // The third is the one that does change, so this waits on the read rather than on the
    // call that started it - the other two fall back to what the app already drew.
    cliSettingValues.mockResolvedValue({ showReasoning: 'no', showTimestamps: 0, taskbarPresence: false });
    const { result } = renderHook(() => useCliDisplay());

    await waitFor(() => expect(result.current.display.taskbarPresence).toBe(false));
    expect(result.current.display.showReasoning).toBe(true);
    expect(result.current.display.showTimestamps).toBe(true);
  });

  // A transcript missing its thinking because a file could not be read looks like lost history.
  it('draws everything when the CLI settings cannot be read', async () => {
    cliSettingValues.mockRejectedValue(new Error('no sidecar'));
    const { result } = renderHook(() => useCliDisplay());

    await waitFor(() => expect(cliSettingValues).toHaveBeenCalled());
    expect(result.current.display.showReasoning).toBe(true);
  });

  it('reads them once rather than on every render', async () => {
    const { rerender } = renderHook(() => useCliDisplay());

    rerender();
    rerender();

    await waitFor(() => expect(cliSettingValues).toHaveBeenCalledOnce());
  });
});

describe('turning one off', () => {
  it('writes it where the CLI keeps it', async () => {
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.set('showReasoning', false));

    expect(writeCliSettings).toHaveBeenCalledExactlyOnceWith({ showReasoning: false });
  });

  it('shows the change without waiting for the write', () => {
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.set('showToolDurations', false));

    expect(result.current.display.showToolDurations).toBe(false);
  });

  it('carries on when the CLI file cannot be written', async () => {
    writeCliSettings.mockRejectedValue(new Error('read only'));
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.set('showReasoning', false));

    await waitFor(() => expect(writeCliSettings).toHaveBeenCalled());
    expect(result.current.display.showReasoning).toBe(false);
  });
});

/**
 * The settings window writes the CLI's file directly, and that write has to reach what this
 * app is already drawing rather than waiting for the next start.
 */
describe('a change made in the settings window', () => {
  it('reaches what the transcript is drawing', async () => {
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.take({ showTimestamps: false }));

    expect(result.current.display.showTimestamps).toBe(false);
  });

  it('takes a number as well as a switch', () => {
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.take({ commandHistoryMaxSize: 9 }));

    expect(result.current.display.commandHistoryMaxSize).toBe(9);
  });

  /** Unset means the CLI falls back to its own default, and so does this. */
  it('goes back to what the app draws when the setting is cleared', async () => {
    cliSettingValues.mockResolvedValue({ showReasoning: false, commandHistoryMaxSize: 9 });
    const { result } = renderHook(() => useCliDisplay());
    await waitFor(() => expect(result.current.display.showReasoning).toBe(false));

    act(() => result.current.take({ showReasoning: undefined, commandHistoryMaxSize: undefined }));

    expect(result.current.display.showReasoning).toBe(true);
    expect(result.current.display.commandHistoryMaxSize).toBe(50);
  });

  it('leaves the settings it was not told about alone', () => {
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.take({ showReasoning: false }));

    expect(result.current.display.showTimestamps).toBe(true);
  });

  // The window writes whatever the CLI category holds, most of which is nothing to do here.
  it("ignores the rest of the CLI's file", () => {
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.take({ memory: false, theme: 'dim' }));

    expect(result.current.display).toEqual(ASSUMED_DISPLAY);
  });

  // It is the window's write, already on its way to the file; a second one could only race it.
  it('does not write the file a second time', () => {
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.take({ showReasoning: false }));

    expect(writeCliSettings).not.toHaveBeenCalled();
  });
});

/**
 * This app kept its own answer about thinking, under its own key, which meant one question
 * with two answers that could disagree. There is one now, where the CLI keeps it.
 */
describe('the answer this app used to keep', () => {
  it('is carried over when the CLI has none of its own', async () => {
    save('settings', OLD_REASONING, 'false');
    const { result } = renderHook(() => useCliDisplay());

    await waitFor(() => expect(result.current.display.showReasoning).toBe(false));
    expect(writeCliSettings).toHaveBeenCalledExactlyOnceWith({ showReasoning: false });
  });

  /** Set there, it is the more recent of the two, and carrying the old one over undoes it. */
  it('gives way to what the CLI already says', async () => {
    save('settings', OLD_REASONING, 'false');
    // The second is the one that changes, so this waits on the read rather than on the call.
    cliSettingValues.mockResolvedValue({ showReasoning: true, taskbarPresence: false });
    const { result } = renderHook(() => useCliDisplay());

    await waitFor(() => expect(result.current.display.taskbarPresence).toBe(false));
    expect(result.current.display.showReasoning).toBe(true);
    expect(writeCliSettings).not.toHaveBeenCalled();
  });

  it('is not invented when this app never held one either', async () => {
    cliSettingValues.mockResolvedValue({ taskbarPresence: false });
    const { result } = renderHook(() => useCliDisplay());

    await waitFor(() => expect(result.current.display.taskbarPresence).toBe(false));
    expect(writeCliSettings).not.toHaveBeenCalled();
  });

  // So a reader who goes back to an older build finds their setting rather than a default.
  it('is kept up to date rather than dropped', () => {
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.set('showReasoning', false));

    expect(read('settings', OLD_REASONING)).toBe('false');
  });
});
