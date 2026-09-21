// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { read, save } from './store';

const { setRuntimeLimits } = vi.hoisted(() => ({
  setRuntimeLimits: vi.fn(async (_maxLoadedSessions: number, _idleTimeoutMs: number) => undefined),
}));
vi.mock('./sidecar', () => ({
  setRuntimeLimits: (maxLoadedSessions: number, idleTimeoutMs: number) =>
    setRuntimeLimits(maxLoadedSessions, idleTimeoutMs),
}));

async function load() {
  vi.resetModules();
  return import('./useSettings');
}

beforeEach(() => {
  localStorage.clear();
  setRuntimeLimits.mockReset().mockResolvedValue(undefined);
});

describe('what the app does when nobody has said otherwise', () => {
  it('keeps every session that is opened, and releases an idle one after ten minutes', async () => {
    const { useSettings } = await load();

    const { result } = renderHook(() => useSettings());

    // Zero is no cap: how many sessions are worth keeping is the reader's judgement.
    expect(result.current.settings.maxLoaded).toBe(0);
    expect(result.current.settings.idleMinutes).toBe(10);
  });

  it('asks before deleting', async () => {
    const { useSettings } = await load();

    expect(renderHook(() => useSettings()).result.current.settings.confirmDelete).toBe(true);
  });
});

describe('changing a setting', () => {
  it('remembers it for next time', async () => {
    const { useSettings, MAX_LOADED } = await load();
    const { result } = renderHook(() => useSettings());

    act(() => result.current.change('maxLoaded', 3));

    expect(result.current.settings.maxLoaded).toBe(3);
    expect(read('settings', MAX_LOADED)).toBe('3');
  });

  it('reads it back on the next run', async () => {
    const { MAX_LOADED, IDLE_MINUTES, CONFIRM_DELETE } = await load();
    save('settings', MAX_LOADED, '4');
    save('settings', IDLE_MINUTES, '25');
    save('settings', CONFIRM_DELETE, 'false');

    const { useSettings } = await load();
    const { settings } = renderHook(() => useSettings()).result.current;

    expect(settings).toEqual({ maxLoaded: 4, idleMinutes: 25, confirmDelete: false });
  });

  it('changes nothing when the value is what it already was', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());
    const before = result.current.settings;

    act(() => result.current.change('maxLoaded', 0));

    expect(result.current.settings).toBe(before);
  });

  it('turns the delete confirmation back on, which nothing else could', async () => {
    const { useSettings, CONFIRM_DELETE } = await load();
    save('settings', CONFIRM_DELETE, 'false');
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.confirmDelete).toBe(false);

    act(() => result.current.change('confirmDelete', true));

    expect(result.current.settings.confirmDelete).toBe(true);
    expect(read('settings', CONFIRM_DELETE)).toBe('true');
  });
});

/**
 * The runtime starts every run on its own defaults and has no memory of what was chosen
 * last time, so being told once at startup matters as much as being told on a change.
 */
describe('telling the runtime what may stay in memory', () => {
  it('says so at startup, before anything has been changed', async () => {
    const { useSettings } = await load();

    renderHook(() => useSettings());

    await waitFor(() => expect(setRuntimeLimits).toHaveBeenCalledWith(0, 10 * 60_000));
  });

  it('says so again when a limit changes', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(setRuntimeLimits).toHaveBeenCalled());

    act(() => result.current.change('maxLoaded', 2));

    await waitFor(() => expect(setRuntimeLimits).toHaveBeenLastCalledWith(2, 10 * 60_000));
  });

  // Minutes are what a reader thinks in; milliseconds are what the runtime counts in.
  it('sends minutes as milliseconds', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());

    act(() => result.current.change('idleMinutes', 25));

    await waitFor(() => expect(setRuntimeLimits).toHaveBeenLastCalledWith(0, 25 * 60_000));
  });

  it('says nothing again for a setting that is not the runtime business', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(setRuntimeLimits).toHaveBeenCalledOnce());

    act(() => result.current.change('confirmDelete', false));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setRuntimeLimits).toHaveBeenCalledOnce();
  });

  it('carries on when the runtime cannot be told', async () => {
    setRuntimeLimits.mockRejectedValue(new Error('no sidecar'));
    const { useSettings } = await load();

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(setRuntimeLimits).toHaveBeenCalled());
    expect(result.current.settings.maxLoaded).toBe(0);
  });
});

describe('a stored value written by something else', () => {
  it.each([['not a number'], ['-3'], ['']])('falls back to the default for %s', async (stored) => {
    const { MAX_LOADED, IDLE_MINUTES } = await load();
    save('settings', MAX_LOADED, stored);
    save('settings', IDLE_MINUTES, stored);

    const { useSettings } = await load();
    const { settings } = renderHook(() => useSettings()).result.current;

    expect(settings.maxLoaded).toBe(0);
    expect(settings.idleMinutes).toBe(10);
  });

  /** Anything but the exact false leaves the question in place rather than skipping it. */
  it('still asks before deleting for anything that is not exactly false', async () => {
    const { CONFIRM_DELETE } = await load();
    save('settings', CONFIRM_DELETE, 'no');

    const { useSettings } = await load();

    expect(renderHook(() => useSettings()).result.current.settings.confirmDelete).toBe(true);
  });
});

