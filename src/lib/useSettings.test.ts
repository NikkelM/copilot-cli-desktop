// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { read, save } from './store';

const { updateCli } = vi.hoisted(() => ({ updateCli: vi.fn(async () => ({ ran: true })) }));
const { setRuntimeLimits } = vi.hoisted(() => ({
  setRuntimeLimits: vi.fn(async (_maxLoadedSessions: number, _idleTimeoutMs: number) => undefined),
}));
vi.mock('./sidecar', () => ({
  updateCli: () => updateCli(),
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
  updateCli.mockReset().mockResolvedValue({ ran: true });
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

    act(() => result.current.apply({ maxLoaded: 3 }));

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

    expect(settings).toEqual({
      maxLoaded: 4,
      idleMinutes: 25,
      confirmDelete: false,
      allowAll: false,
      workingDirectory: '',
      updateOnStart: false,
      scale: 1,
      textScale: 1,
    });
  });

  it('changes nothing when the value is what it already was', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());
    const before = result.current.settings;

    act(() => result.current.apply({ maxLoaded: 0 }));

    expect(result.current.settings).toBe(before);
  });

  it('keeps the ones it was not given', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());

    act(() => result.current.apply({ maxLoaded: 3 }));

    expect(result.current.settings).toEqual({
      maxLoaded: 3,
      idleMinutes: 10,
      confirmDelete: true,
      allowAll: false,
      workingDirectory: '',
      updateOnStart: false,
      scale: 1,
      textScale: 1,
    });
  });

  it('writes only the ones that actually changed', async () => {
    const { useSettings, MAX_LOADED, IDLE_MINUTES } = await load();
    const { result } = renderHook(() => useSettings());

    act(() => result.current.apply({ maxLoaded: 3, idleMinutes: 10 }));

    expect(read('settings', MAX_LOADED)).toBe('3');
    // Unchanged, so never written: a stored value is a decision, and absent is the default.
    expect(read('settings', IDLE_MINUTES)).toBeNull();
  });

  it('turns the delete confirmation back on, which nothing else could', async () => {
    const { useSettings, CONFIRM_DELETE } = await load();
    save('settings', CONFIRM_DELETE, 'false');
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.confirmDelete).toBe(false);

    act(() => result.current.apply({ confirmDelete: true }));

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

    act(() => result.current.apply({ maxLoaded: 2 }));

    await waitFor(() => expect(setRuntimeLimits).toHaveBeenLastCalledWith(2, 10 * 60_000));
  });

  /**
   * Saving a window full of settings is one decision, not one per field, and this is what
   * keeps the runtime from being told twice when both of its rules change together.
   */
  it('is told once when both its rules change together', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(setRuntimeLimits).toHaveBeenCalledOnce());

    act(() => result.current.apply({ maxLoaded: 2, idleMinutes: 25, confirmDelete: false }));

    await waitFor(() => expect(setRuntimeLimits).toHaveBeenLastCalledWith(2, 25 * 60_000));
    expect(setRuntimeLimits).toHaveBeenCalledTimes(2);
  });

  // Minutes are what a reader thinks in; milliseconds are what the runtime counts in.
  it('sends minutes as milliseconds', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());

    act(() => result.current.apply({ idleMinutes: 25 }));

    await waitFor(() => expect(setRuntimeLimits).toHaveBeenLastCalledWith(0, 25 * 60_000));
  });

  it('says nothing again for a setting that is not the runtime business', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(setRuntimeLimits).toHaveBeenCalledOnce());

    act(() => result.current.apply({ confirmDelete: false }));

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

/**
 * The CLI updates itself on startup by default, and never when this app launches it: the
 * SDK spawns it with `--no-auto-update` every time. So asking for one is the only way to
 * have a current CLI, and it is off until somebody says otherwise (#199).
 */
describe('updating the CLI', () => {
  it('asks for none until it is turned on', async () => {
    const { useSettings } = await load();

    renderHook(() => useSettings());

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateCli).not.toHaveBeenCalled();
  });

  it('asks for one at startup when it is already on', async () => {
    const { UPDATE_ON_START } = await load();
    save('settings', UPDATE_ON_START, 'true');

    const { useSettings } = await load();
    renderHook(() => useSettings());

    await waitFor(() => expect(updateCli).toHaveBeenCalledOnce());
  });

  /**
   * Turning it on is a statement about startups rather than a request to update now, but
   * an app already open would otherwise do nothing at all until next time, which reads as
   * the setting not working.
   */
  it('asks once when it is turned on while the app is open', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());

    act(() => result.current.apply({ updateOnStart: true }));

    await waitFor(() => expect(updateCli).toHaveBeenCalledOnce());
  });

  it('does not ask again when it is turned off and on', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());

    act(() => result.current.apply({ updateOnStart: true }));
    await waitFor(() => expect(updateCli).toHaveBeenCalledOnce());

    act(() => result.current.apply({ updateOnStart: false }));
    act(() => result.current.apply({ updateOnStart: true }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateCli).toHaveBeenCalledOnce();
  });

  it('carries on when the update cannot be asked for', async () => {
    updateCli.mockRejectedValue(new Error('no sidecar'));
    const { useSettings, UPDATE_ON_START } = await load();
    save('settings', UPDATE_ON_START, 'true');

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(updateCli).toHaveBeenCalled());
    expect(result.current.settings.updateOnStart).toBe(true);
  });
});
describe('what a new session starts with', () => {
  it('asks before running tools until told otherwise', async () => {
    const { useSettings } = await load();

    expect(renderHook(() => useSettings()).result.current.settings.allowAll).toBe(false);
  });

  /** Only the exact stored true hands out blanket permission. */
  it.each([['yes'], ['1'], [''], ['TRUE']])('still asks for a stored %s', async (stored) => {
    const { ALLOW_ALL } = await load();
    save('settings', ALLOW_ALL, stored);

    const { useSettings } = await load();

    expect(renderHook(() => useSettings()).result.current.settings.allowAll).toBe(false);
  });

  it('starts in the home directory until a directory is given', async () => {
    const { useSettings } = await load();

    expect(renderHook(() => useSettings()).result.current.settings.workingDirectory).toBe('');
  });

  it('remembers a directory that was given', async () => {
    const { useSettings, WORKING_DIRECTORY } = await load();
    const { result } = renderHook(() => useSettings());

    act(() => result.current.apply({ workingDirectory: 'F:\\work' }));

    expect(read('settings', WORKING_DIRECTORY)).toBe('F:\\work');
  });
});

/**
 * The size everything is drawn at. It used to be its own hook with its own copy of the
 * value, which meant the settings window could be showing a size the keyboard had already
 * changed. One owner now, and the keyboard and the window are two ways to it (#139).
 */
describe('the text size', () => {
  const applied = () => document.documentElement.style.getPropertyValue('--font-base');

  it('is the app own size until it is changed', async () => {
    const { useSettings } = await load();

    expect(renderHook(() => useSettings()).result.current.settings.scale).toBe(1);
  });

  it('applies a remembered one before anything is drawn at the default', async () => {
    const { SCALE_KEY } = await import('./scale');
    save('settings', SCALE_KEY, '1.25');
    const { useSettings } = await load();

    renderHook(() => useSettings());

    await waitFor(() => expect(applied()).toBe('20px'));
  });

  it('takes effect at once rather than at the next launch', async () => {
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());

    act(() => result.current.apply({ scale: 1.5 }));

    await waitFor(() => expect(applied()).toBe('24px'));
  });

  it('survives a restart', async () => {
    const { useSettings } = await load();
    const first = renderHook(() => useSettings());
    act(() => first.result.current.apply({ scale: 1.25 }));
    first.unmount();

    const { useSettings: again } = await load();

    expect(renderHook(() => again()).result.current.settings.scale).toBe(1.25);
  });

  /** A fraction, unlike the counts above, so it has a reader of its own. */
  it('keeps a fraction rather than flooring it', async () => {
    const { SCALE_KEY } = await import('./scale');
    save('settings', SCALE_KEY, '1.125');
    const { useSettings } = await load();

    expect(renderHook(() => useSettings()).result.current.settings.scale).toBe(1.125);
  });

  it('brings an unusable one back into range', async () => {
    const { SCALE_KEY } = await import('./scale');
    save('settings', SCALE_KEY, '40');
    const { useSettings } = await load();

    expect(renderHook(() => useSettings()).result.current.settings.scale).toBe(2);
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

