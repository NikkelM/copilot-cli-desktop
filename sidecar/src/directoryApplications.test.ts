import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { directoryApplications, openDirectory } from './directoryApplications.js';
import { ChildProcess, spawn } from 'node:child_process';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

let root: string;
const unref = vi.fn();
const custom = (executable: string, args = ['{cwd}']) => JSON.stringify([
  { id: 'custom-one', label: 'My editor', executable, args },
]);
const executable = (path: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  chmodSync(path, 0o755);
  return path;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccd-apps-'));
  for (const key of ['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot', 'PATH']) {
    vi.stubEnv(key, join(root, key));
  }
  unref.mockClear();
  vi.mocked(spawn).mockReset().mockImplementation(() => {
    const child = new ChildProcess();
    child.unref = unref;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('directory application discovery', () => {
  it('offers configured executables only when present', async () => {
    const path = executable(join(root, 'editor.exe'));
    expect(await directoryApplications(custom(path))).toContainEqual({ id: 'custom-one', label: 'My editor' });
    rmSync(path);
    expect(await directoryApplications(custom(path))).not.toContainEqual({ id: 'custom-one', label: 'My editor' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves a custom executable on PATH without executing it', async () => {
    executable(join(root, 'PATH', process.platform === 'win32' ? 'editor.exe' : 'editor'));
    expect(await directoryApplications(custom('editor'))).toContainEqual({ id: 'custom-one', label: 'My editor' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('detects installed IDEs and terminals, omitting absent applications', async () => {
    executable(join(root, 'SystemRoot', 'explorer.exe'));
    executable(join(root, 'LOCALAPPDATA', 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'));
    executable(join(root, 'ProgramFiles', 'JetBrains', 'Rider 2026.1', 'bin', 'rider64.exe'));
    executable(join(root, 'LOCALAPPDATA', 'Microsoft', 'WindowsApps', 'wt.exe'));
    executable(join(root, 'ProgramFiles', 'PowerShell', '7', 'pwsh.exe'));
    executable(join(root, 'SystemRoot', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    const apps = await directoryApplications('[]');
    expect(apps).toEqual([
      { id: 'folder', label: 'File Explorer' },
      { id: 'vscode-insiders', label: 'VS Code Insiders' },
      { id: 'terminal', label: 'Windows Terminal' },
      { id: 'powershell', label: 'Windows PowerShell' },
      { id: 'rider', label: 'Rider' },
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('launching a working directory', () => {
  it('passes the chosen directory as one literal argument, uses it as cwd, and detaches the child', async () => {
    const exe = executable(join(root, 'editor.exe'));
    const cwd = join(root, 'a folder & not-a-command');
    mkdirSync(cwd);
    await openDirectory(cwd, 'custom-one', custom(exe, ['--new-window', '{cwd}']));
    expect(spawn).toHaveBeenCalledExactlyOnceWith(exe, ['--new-window', cwd], {
      cwd, shell: false, detached: true, stdio: 'ignore', windowsHide: false,
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform !== 'win32')('opens a detected editor in a new window', async () => {
    const exe = executable(join(root, 'LOCALAPPDATA', 'Programs', 'Microsoft VS Code', 'Code.exe'));
    await openDirectory(root, 'vscode', '[]');
    expect(spawn).toHaveBeenCalledWith(exe, ['--new-window', root], expect.objectContaining({ shell: false }));
  });

  it('reports a removed application instead of silently using a different one', async () => {
    await expect(openDirectory(root, 'custom-one', custom(join(root, 'missing.exe')))).rejects.toThrow('Cannot find executable');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a nonexistent working directory', async () => {
    await expect(openDirectory(join(root, 'missing'), 'folder', '[]')).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports spawn failures', async () => {
    const exe = executable(join(root, 'editor.exe'));
    vi.mocked(spawn).mockImplementation(() => {
      const child = new ChildProcess();
      child.unref = unref;
      queueMicrotask(() => child.emit('error', new Error('Could not start editor')));
      return child;
    });
    await expect(openDirectory(root, 'custom-one', custom(exe))).rejects.toThrow('Could not start editor');
  });

  it.skipIf(process.platform !== 'win32')('does not interpret batch files through a command shell', async () => {
    const exe = executable(join(root, 'editor.cmd'));
    await expect(openDirectory(root, 'custom-one', custom(exe))).rejects.toThrow('Cannot find executable');
    expect(spawn).not.toHaveBeenCalled();
  });
});
