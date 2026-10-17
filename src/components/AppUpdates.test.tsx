// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdates } from '../lib/useAppUpdates';
import { AppUpdateNotice, AppUpdateSettings } from './AppUpdates';

const { appLogDir, openPath } = vi.hoisted(() => ({ appLogDir: vi.fn(), openPath: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ appLogDir }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath }));
vi.mock('./Markdown', () => ({ Markdown: ({ body }: { body: string }) => <div data-testid="release-notes">{body}</div> }));

beforeEach(() => {
  appLogDir.mockReset().mockResolvedValue('D:\\App data\\logs');
  openPath.mockReset().mockResolvedValue(undefined);
});

function updates(over: Partial<AppUpdates> = {}): AppUpdates {
  return {
    status: {
      revision: 4, currentVersion: '1.0.0', action: 'idle',
      currentRelease: { version: '1.0.0', notes: 'Installed release notes', prerelease: false },
      available: { version: '2.0.0', notes: 'Release notes content', prerelease: false },
      ready: true, downloaded: 1024, total: 1024, checkedAt: null, error: null,
      installSupported: true,
      currentPrerelease: false, includePrereleases: false, stableVersion: '2.0.0', rollback: false,
    },
    busy: false, failed: null, installing: false, installFailed: null, blocked: null, showNotice: true,
    offerRollback: false, requestStable: vi.fn(), returnToStable: vi.fn(), dismissRollback: vi.fn(),
    check: vi.fn(), selectChannel: vi.fn(), download: vi.fn(), install: vi.fn(), dismiss: vi.fn(),
    ...over,
  };
}

describe('Updates settings', () => {
  it('offers return to stable for an installed prerelease and names its target', () => {
    const state = updates({
      status: { ...updates().status!, currentVersion: '2.1.0-beta.2', currentPrerelease: true, stableVersion: '2.0.0' },
    });
    render(<AppUpdateSettings updates={state} dirty={false} includePrereleases={false} shows={() => true} />);
    const button = screen.getByRole('button', { name: 'Return to latest stable' });
    expect(button.title).toBe('Return to 2.0.0');
    fireEvent.click(button);
    expect(state.requestStable).toHaveBeenCalledOnce();
    expect(state.returnToStable).not.toHaveBeenCalled();
  });

  it('does not offer stable rollback to a stable build or when no stable release exists', () => {
    const view = render(<AppUpdateSettings updates={updates()} dirty={false} includePrereleases={false} shows={() => true} />);
    expect(screen.queryByRole('button', { name: 'Return to latest stable' })).toBeNull();
    view.rerender(<AppUpdateSettings
      updates={updates({ status: { ...updates().status!, currentPrerelease: true, stableVersion: null } })}
      dirty={false} includePrereleases={false} shows={() => true}
    />);
    expect(screen.getByRole('button', { name: 'Return to latest stable' })).toHaveProperty('disabled', true);
  });

  it('allows retrying a check when the initial status could not be read', () => {
    const state = updates({ status: null, failed: 'Status unavailable' });
    render(<AppUpdateSettings updates={state} dirty={false} includePrereleases={false} shows={() => true} />);
    const check = screen.getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement;
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    expect(state.check).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('shows the installed and downloaded versions with check and install actions', () => {
    const state = updates();
    render(<AppUpdateSettings updates={state} dirty={false} includePrereleases={false} shows={() => true} />);
    expect(screen.getByText('Installed version: 1.0.0')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('2.0.0');
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(state.check).toHaveBeenCalledExactlyOnceWith(false);
    expect(state.install).toHaveBeenCalledOnce();
  });

  it.each([
    { dirty: true, state: updates(), reason: 'settings changes' },
    { dirty: false, state: updates({ blocked: 'A session is working' }), reason: 'session is working' },
    {
      dirty: false,
      state: updates({ status: { ...updates().status!, installSupported: false } }),
      reason: 'installed Windows build',
    },
  ])('does not install when %s', ({ dirty, state, reason }) => {
    render(<AppUpdateSettings updates={state} dirty={dirty} includePrereleases={false} shows={() => true} />);
    const install = screen.getByRole('button', { name: 'Install and restart' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    expect(install.title).toContain(reason);
    fireEvent.click(install);
    expect(state.install).not.toHaveBeenCalled();
  });

  it('offers a download for an available update and reports download progress', () => {
    const state = updates({ status: { ...updates().status!, ready: false } });
    const view = render(<AppUpdateSettings updates={state} dirty={false} includePrereleases={false} shows={() => true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));
    expect(state.download).toHaveBeenCalledExactlyOnceWith(false);
    view.rerender(<AppUpdateSettings
      updates={updates({ status: { ...state.status!, action: 'downloading', downloaded: 512, total: 1024 } })}
      dirty={false} includePrereleases={false} shows={() => true}
    />);
    expect(screen.getByRole('progressbar', { name: 'Downloading app update' })).toHaveProperty('value', 512);
  });

  it('shows separate versioned notes for the installed and available releases', () => {
    render(<AppUpdateSettings updates={updates()} dirty={false} includePrereleases={false} shows={() => true} />);
    expect(screen.queryByTestId('release-notes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Installed release notes' }));
    expect(screen.getByRole('heading', { name: 'Version 1.0.0' })).toBeTruthy();
    expect(screen.getByTestId('release-notes').textContent).toBe('Installed release notes');
    expect(screen.queryByRole('heading', { name: 'Version 2.0.0' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Available release notes' }));
    expect(screen.getByRole('heading', { name: 'Version 2.0.0' })).toBeTruthy();
    expect(screen.getAllByTestId('release-notes').map((notes) => notes.textContent)).toEqual([
      'Installed release notes',
      'Release notes content',
    ]);
  });

  it('only offers installed release notes when the exact published version supplied them', () => {
    const view = render(<AppUpdateSettings
      updates={updates({ status: { ...updates().status!, currentRelease: null } })}
      dirty={false}
      includePrereleases={false}
      shows={() => true}
    />);
    expect(screen.queryByRole('button', { name: 'Installed release notes' })).toBeNull();
    view.rerender(<AppUpdateSettings
      updates={updates({
        status: {
          ...updates().status!,
          currentRelease: { version: '1.0.0', notes: null, prerelease: false },
        },
      })}
      dirty={false}
      includePrereleases={false}
      shows={() => true}
    />);
    expect(screen.queryByRole('button', { name: 'Installed release notes' })).toBeNull();
  });

  it('shows failures rather than claiming the app is up to date', () => {
    render(<AppUpdateSettings
      updates={updates({ failed: 'Feed unavailable' })}
      dirty={false}
      includePrereleases={false}
      shows={() => true}
    />);
    expect(screen.getByRole('alert').textContent).toBe('Feed unavailable');
    expect(screen.queryByText('You have the latest published version.')).toBeNull();
  });

  it('checks and downloads against the prerelease channel shown in the unsaved draft', () => {
    const state = updates({ status: { ...updates().status!, ready: false } });
    render(<AppUpdateSettings updates={state} dirty includePrereleases shows={() => true} />);
    expect(screen.getByText('Update channel: Stable and prerelease')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));

    expect(state.check).toHaveBeenCalledExactlyOnceWith(true);
    expect(state.download).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('separates larger update actions, the ready note and the Debug action', () => {
    render(<AppUpdateSettings updates={updates()} dirty={false} includePrereleases={false} shows={() => true} />);
    const check = screen.getByRole('button', { name: 'Check for updates' });
    const logs = screen.getByRole('button', { name: 'Open logs folder' });
    const readyNote = screen.getByText('The downloaded update will also install the next time the app starts.');

    expect(check.closest('.app-update-actions')).toBeTruthy();
    expect(logs.closest('.app-update-actions')).toBeNull();
    expect(logs.closest('.app-update-debug-actions')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Debug' })).toBeTruthy();
    expect(readyNote.classList.contains('app-update-ready-note')).toBe(true);
  });

  it('resolves and opens the app logs only when requested, without checking or installing updates', async () => {
    const state = updates();
    render(<AppUpdateSettings updates={state} dirty={false} includePrereleases={false} shows={() => true} />);
    expect(appLogDir).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));

    await waitFor(() => expect(openPath).toHaveBeenCalledExactlyOnceWith('D:\\App data\\logs'));
    expect(appLogDir).toHaveBeenCalledOnce();
    expect(state.check).not.toHaveBeenCalled();
    expect(state.install).not.toHaveBeenCalled();
  });

  it('can open logs with unavailable updater status, active work and unsaved settings', async () => {
    const state = updates({ status: null, busy: true, failed: 'Status unavailable', blocked: 'A session is working' });
    render(<AppUpdateSettings updates={state} dirty includePrereleases={false} shows={() => true} />);
    const button = screen.getByRole('button', { name: 'Open logs folder' });
    expect(button).toHaveProperty('disabled', false);

    fireEvent.click(button);

    await waitFor(() => expect(openPath).toHaveBeenCalledExactlyOnceWith('D:\\App data\\logs'));
  });

  it('reports a log directory lookup failure without opening another location', async () => {
    appLogDir.mockRejectedValueOnce(new Error('Logs directory unavailable'));
    render(<AppUpdateSettings updates={updates()} dirty={false} includePrereleases={false} shows={() => true} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Could not open logs folder: Logs directory unavailable');
    expect(openPath).not.toHaveBeenCalled();
  });

  it('reports a failed folder open and clears the error after a successful retry', async () => {
    openPath.mockRejectedValueOnce('Access denied');
    render(<AppUpdateSettings updates={updates()} dirty={false} includePrereleases={false} shows={() => true} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not open logs folder: Access denied');
    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));

    await waitFor(() => expect(openPath).toHaveBeenCalledTimes(2));
    expect(appLogDir).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides the logs action and its error when settings search filters it out', async () => {
    openPath.mockRejectedValueOnce('Access denied');
    const view = render(<AppUpdateSettings updates={updates()} dirty={false} includePrereleases={false} shows={() => true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));
    await screen.findByRole('alert');

    view.rerender(<AppUpdateSettings
      updates={updates()} dirty={false} shows={(label) => label !== 'Open logs folder'}
      includePrereleases={false}
    />);

    expect(screen.queryByRole('button', { name: 'Open logs folder' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(appLogDir).toHaveBeenCalledOnce();
  });
});

describe('downloaded update prompt', () => {
  it('requires confirmation before downloading a rollback and permits cancelling it', () => {
    const state = updates({ offerRollback: true });
    render(<AppUpdateNotice updates={state} />);
    expect(screen.getByRole('alertdialog', { name: 'Return to the latest stable release?' })).toBeTruthy();
    expect(state.returnToStable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(state.dismissRollback).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Download stable release' }));
    expect(state.returnToStable).toHaveBeenCalledOnce();
    expect(state.install).not.toHaveBeenCalled();
  });

  it('keeps installer errors visible even when the downloaded package is no longer ready', () => {
    render(<AppUpdateNotice updates={updates({
      status: { ...updates().status!, ready: false },
      showNotice: false, installFailed: 'The cached installer could not be verified',
    })} />);
    expect(screen.getByRole('alert').textContent).toContain('could not be verified');
    expect(screen.getByText('Version 2.0.0 could not be installed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install and restart' })).toHaveProperty('disabled', true);
  });

  it('keeps a dismissed ready prompt out of the interface', () => {
    render(<AppUpdateNotice updates={updates({ showNotice: false })} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install and restart' })).toBeNull();
  });

  it('prompts over the app to install an automatically downloaded startup update', () => {
    const state = updates();
    const { container } = render(<div inert><AppUpdateNotice updates={state} /></div>);
    const prompt = screen.getByRole('alertdialog', { name: 'Install app update?' });
    expect(container.contains(prompt)).toBe(false);
    expect(prompt.closest('[inert]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Install and restart' }).classList.contains('confirm-go')).toBe(false);
    expect(screen.getByText('Version 2.0.0 was downloaded. Install it now and restart the app?')).toBeTruthy();
    expect(state.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(state.dismiss).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(state.install).toHaveBeenCalledOnce();
  });

  it('keeps the preparation status outside the inert application tree', () => {
    const { container } = render(<div inert><AppUpdateNotice updates={updates({ installing: true })} /></div>);
    const status = screen.getByRole('status');
    expect(container.contains(status)).toBe(false);
    expect(status.closest('[inert]')).toBeNull();
  });
});
