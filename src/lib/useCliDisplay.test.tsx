// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCliDisplay, OLD_REASONING } from './useCliDisplay';
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

  /** Only the exact stored false turns one off, so nothing unexpected can hide anything. */
  it('keeps drawing for a value that is not exactly false', async () => {
    cliSettingValues.mockResolvedValue({ showReasoning: 'no', showTimestamps: 0 });
    const { result } = renderHook(() => useCliDisplay());

    await waitFor(() => expect(cliSettingValues).toHaveBeenCalled());
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
    cliSettingValues.mockResolvedValue({ showReasoning: true });
    const { result } = renderHook(() => useCliDisplay());

    await waitFor(() => expect(cliSettingValues).toHaveBeenCalled());
    expect(result.current.display.showReasoning).toBe(true);
    expect(writeCliSettings).not.toHaveBeenCalled();
  });

  it('is not invented when this app never held one either', async () => {
    renderHook(() => useCliDisplay());

    await waitFor(() => expect(cliSettingValues).toHaveBeenCalled());
    expect(writeCliSettings).not.toHaveBeenCalled();
  });

  // So a reader who goes back to an older build finds their setting rather than a default.
  it('is kept up to date rather than dropped', () => {
    const { result } = renderHook(() => useCliDisplay());

    act(() => result.current.set('showReasoning', false));

    expect(read('settings', OLD_REASONING)).toBe('false');
  });
});
