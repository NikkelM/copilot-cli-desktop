// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppUpdates } from '../lib/useAppUpdates';
import { AppUpdateNotice, AppUpdateSettings } from './AppUpdates';

vi.mock('./Markdown', () => ({ Markdown: ({ body }: { body: string }) => <div data-testid="release-notes">{body}</div> }));

function updates(over: Partial<AppUpdates> = {}): AppUpdates {
  return {
    status: {
      revision: 4, currentVersion: '1.0.0', action: 'idle',
      available: { version: '2.0.0', notes: 'Release notes content', prerelease: false },
      ready: true, downloaded: 1024, total: 1024, checkedAt: null, error: null,
      installSupported: true,
      currentPrerelease: false, includePrereleases: false, stableVersion: '2.0.0', rollback: false,
    },
    busy: false, failed: null, installing: false, installFailed: null, blocked: null, showNotice: true,
    offerRollback: false, requestStable: vi.fn(), returnToStable: vi.fn(), dismissRollback: vi.fn(),
    check: vi.fn(), download: vi.fn(), install: vi.fn(), dismiss: vi.fn(),
    ...over,
  };
}

describe('Updates settings', () => {
  it('offers return to stable for an installed prerelease and names its target', () => {
    const state = updates({
      status: { ...updates().status!, currentVersion: '2.1.0-beta.2', currentPrerelease: true, stableVersion: '2.0.0' },
    });
    render(<AppUpdateSettings updates={state} dirty={false} shows={() => true} />);
    const button = screen.getByRole('button', { name: 'Return to latest stable' });
    expect(button.title).toBe('Return to 2.0.0');
    fireEvent.click(button);
    expect(state.requestStable).toHaveBeenCalledOnce();
    expect(state.returnToStable).not.toHaveBeenCalled();
  });

  it('does not offer stable rollback to a stable build or when no stable release exists', () => {
    const view = render(<AppUpdateSettings updates={updates()} dirty={false} shows={() => true} />);
    expect(screen.queryByRole('button', { name: 'Return to latest stable' })).toBeNull();
    view.rerender(<AppUpdateSettings
      updates={updates({ status: { ...updates().status!, currentPrerelease: true, stableVersion: null } })}
      dirty={false} shows={() => true}
    />);
    expect(screen.getByRole('button', { name: 'Return to latest stable' })).toHaveProperty('disabled', true);
  });

  it('allows retrying a check when the initial status could not be read', () => {
    const state = updates({ status: null, failed: 'Status unavailable' });
    render(<AppUpdateSettings updates={state} dirty={false} shows={() => true} />);
    const check = screen.getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement;
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    expect(state.check).toHaveBeenCalledOnce();
  });

  it('shows the installed and downloaded versions with check and install actions', () => {
    const state = updates();
    render(<AppUpdateSettings updates={state} dirty={false} shows={() => true} />);
    expect(screen.getByText('Installed version: 1.0.0')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('2.0.0');
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(state.check).toHaveBeenCalledOnce();
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
    render(<AppUpdateSettings updates={state} dirty={dirty} shows={() => true} />);
    const install = screen.getByRole('button', { name: 'Install and restart' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    expect(install.title).toContain(reason);
    fireEvent.click(install);
    expect(state.install).not.toHaveBeenCalled();
  });

  it('offers a download for an available update and reports download progress', () => {
    const state = updates({ status: { ...updates().status!, ready: false } });
    const view = render(<AppUpdateSettings updates={state} dirty={false} shows={() => true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));
    expect(state.download).toHaveBeenCalledOnce();
    view.rerender(<AppUpdateSettings
      updates={updates({ status: { ...state.status!, action: 'downloading', downloaded: 512, total: 1024 } })}
      dirty={false} shows={() => true}
    />);
    expect(screen.getByRole('progressbar', { name: 'Downloading app update' })).toHaveProperty('value', 512);
  });

  it('does not parse or draw release notes until requested', () => {
    render(<AppUpdateSettings updates={updates()} dirty={false} shows={() => true} />);
    expect(screen.queryByTestId('release-notes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }));
    expect(screen.getByTestId('release-notes').textContent).toBe('Release notes content');
  });

  it('shows failures rather than claiming the app is up to date', () => {
    render(<AppUpdateSettings updates={updates({ failed: 'Feed unavailable' })} dirty={false} shows={() => true} />);
    expect(screen.getByRole('alert').textContent).toBe('Feed unavailable');
    expect(screen.queryByText('You have the latest published version.')).toBeNull();
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
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install and restart' })).toBeNull();
  });

  it('offers installation and Later without starting installation by itself', () => {
    const state = updates();
    render(<AppUpdateNotice updates={state} />);
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
