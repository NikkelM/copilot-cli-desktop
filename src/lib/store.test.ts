// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { forget, loadStores, read, resetStores, save } from './store';

/**
 * Load, let the write that migration schedules land, and forget it happened.
 *
 * A first load with no file writes what it took from the webview, which is a call these
 * tests are not about and would otherwise count.
 */
async function started() {
  await loadStores();
  await vi.advanceTimersByTimeAsync(500);
  invoke.mockClear();
}

/** Make this look like a window with a shell behind it, which is where the files are. */
function withShell(reading: (store: string) => string | null = () => null) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockImplementation((command: string, args: { store: string; contents?: string }) => {
    if (command === 'read_store') return Promise.resolve(reading(args.store));
    return Promise.resolve();
  });
}

beforeEach(() => {
  resetStores();
  localStorage.clear();
  invoke.mockReset();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe('what the app remembers', () => {
  it('holds nothing to begin with', () => {
    expect(read('settings', 'scale')).toBeNull();
    expect(read('sessions', 'favourites')).toBeNull();
  });

  it('keeps what it was given', () => {
    save('settings', 'scale', '1.25');

    expect(read('settings', 'scale')).toBe('1.25');
  });

  it('keeps the two stores apart', () => {
    // The whole point of two files: a pin must not rewrite the settings.
    save('settings', 'shared', 'a setting');
    save('sessions', 'shared', 'some state');

    expect(read('settings', 'shared')).toBe('a setting');
    expect(read('sessions', 'shared')).toBe('some state');
  });

  it('forgets a key that has gone back to its default', () => {
    save('settings', 'scale', '1.25');

    forget('settings', 'scale');

    expect(read('settings', 'scale')).toBeNull();
  });
});

describe('reading the files at startup', () => {
  it('reads both, once', async () => {
    withShell();

    await loadStores();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith('read_store', { store: 'settings' });
    expect(invoke).toHaveBeenCalledWith('read_store', { store: 'sessions' });
  });

  it('takes what the files hold', async () => {
    withShell((store) => (store === 'settings' ? JSON.stringify({ scale: '1.5' }) : null));

    await loadStores();

    expect(read('settings', 'scale')).toBe('1.5');
  });

  it('starts empty rather than failing when a file cannot be read', async () => {
    // An app with default settings beats no app.
    withShell();
    invoke.mockRejectedValue(new Error('no such directory'));

    await loadStores();

    expect(read('settings', 'scale')).toBeNull();
  });

  it('starts empty rather than failing on a file that is not an object', async () => {
    withShell(() => '["not", "a", "store"]');

    await loadStores();

    expect(read('settings', 'scale')).toBeNull();
  });

  it('reads nothing at all when there is no shell to ask', async () => {
    await loadStores();

    expect(invoke).not.toHaveBeenCalled();
  });
});

/**
 * The first run after the move finds no file, which is also what a fresh install finds. That
 * is the moment to take whatever the webview was holding.
 */
describe('taking over from the webview store', () => {
  it('seeds a store that has no file yet', async () => {
    localStorage.setItem('copilot-desktop.scale', '1.75');
    localStorage.setItem('copilot-desktop.favourites', '["a"]');
    withShell();

    await loadStores();

    expect(read('settings', 'scale')).toBe('1.75');
    expect(read('sessions', 'favourites')).toBe('["a"]');
  });

  it('leaves the old keys where they are', async () => {
    // A reader who goes back to an older build should find their settings, not an empty app.
    localStorage.setItem('copilot-desktop.scale', '1.75');
    withShell();

    await loadStores();

    expect(localStorage.getItem('copilot-desktop.scale')).toBe('1.75');
  });

  it('writes what it took, so this is the only run that looks', async () => {
    localStorage.setItem('copilot-desktop.scale', '1.75');
    withShell();

    await loadStores();
    await vi.advanceTimersByTimeAsync(500);

    expect(invoke).toHaveBeenCalledWith('write_store', {
      store: 'settings',
      contents: JSON.stringify({ scale: '1.75' }, null, 2),
    });
  });

  it('leaves a store alone when it already had a file', async () => {
    withShell((store) => (store === 'settings' ? JSON.stringify({ scale: '1.25' }) : '{}'));

    await loadStores();
    await vi.advanceTimersByTimeAsync(500);

    expect(invoke.mock.calls.filter(([command]) => command === 'write_store')).toHaveLength(0);
  });

  it('does not look again once there is a file', async () => {
    localStorage.setItem('copilot-desktop.scale', '1.75');
    withShell((store) => (store === 'settings' ? JSON.stringify({ scale: '1.25' }) : null));

    await loadStores();

    expect(read('settings', 'scale')).toBe('1.25');
  });

  it('takes nothing from a store whose keys belong to the other one', async () => {
    // Settings and session state are two files, and a key migrates to exactly one of them.
    localStorage.setItem('copilot-desktop.favourites', '["a"]');
    withShell();

    await loadStores();

    expect(read('settings', 'favourites')).toBeNull();
    expect(read('sessions', 'favourites')).toBe('["a"]');
  });

  it('leaves the caches alone, since they regenerate and belong in a browser store', async () => {
    localStorage.setItem('copilot-desktop.models', '["gpt"]');
    localStorage.setItem('copilot-desktop.commands.v2', '[]');
    withShell();

    await loadStores();

    expect(read('settings', 'models')).toBeNull();
    expect(read('sessions', 'models')).toBeNull();
  });
});

describe('writing back', () => {
  it('writes what changed, once the changes stop', async () => {
    withShell();
    await loadStores();
    invoke.mockClear();

    save('settings', 'scale', '1.25');
    expect(invoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(invoke).toHaveBeenCalledWith('write_store', {
      store: 'settings',
      contents: JSON.stringify({ scale: '1.25' }, null, 2),
    });
  });

  it('writes once for a burst, not once per change', async () => {
    // Dragging the sidebar edge is one change per pixel, spread over as long as the drag
    // lasts - so the changes are separated in time, which is what the wait is for. A
    // synchronous burst would coalesce however short the wait was.
    withShell();
    await started();

    for (const width of ['18', '19', '20', '21']) {
      save('settings', 'sidebarWidth', width);
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(invoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('write_store', {
      store: 'settings',
      contents: JSON.stringify({ sidebarWidth: '21' }, null, 2),
    });
  });

  it('writes each store on its own account', async () => {
    withShell();
    await loadStores();
    invoke.mockClear();

    save('settings', 'scale', '1.25');
    save('sessions', 'favourites', '["a"]');
    await vi.advanceTimersByTimeAsync(500);

    const written = invoke.mock.calls.filter(([command]) => command === 'write_store');
    expect(written.map(([, args]) => (args as { store: string }).store).sort()).toEqual(['sessions', 'settings']);
  });

  it('says nothing when a value has not actually changed', async () => {
    withShell();
    await loadStores();
    save('settings', 'scale', '1.25');
    await vi.advanceTimersByTimeAsync(500);
    invoke.mockClear();

    save('settings', 'scale', '1.25');
    await vi.advanceTimersByTimeAsync(500);

    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not write before the files have been read', async () => {
    // Otherwise the first change of a run would blank whatever was on disk.
    withShell();

    save('settings', 'scale', '1.25');
    await vi.advanceTimersByTimeAsync(500);

    expect(invoke).not.toHaveBeenCalled();
  });

  it('survives a write that fails', async () => {
    withShell();
    await loadStores();
    invoke.mockRejectedValue(new Error('disk full'));

    save('settings', 'scale', '1.25');
    await vi.advanceTimersByTimeAsync(500);

    // Still held, so the next change writes it again.
    expect(read('settings', 'scale')).toBe('1.25');
  });
});
