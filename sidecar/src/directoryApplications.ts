import { spawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

import {
  customDirectoryApplications,
  directoryArguments,
  type CustomDirectoryApplication,
  type DirectoryApplication,
} from '../../shared/directoryApplications.js';

type InstalledApplication = CustomDirectoryApplication;

async function executableAt(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

async function resolveExecutable(command: string): Promise<string | null> {
  // Batch scripts need cmd.exe and its command-string parsing, so launch native executables instead
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) return null;
  const names = process.platform === 'win32' && !/\.[^\\/]+$/.test(command) ? [command, `${command}.exe`] : [command];
  const roots = isAbsolute(command) ? [''] : (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const root of roots) {
    for (const name of names) {
      const path = root ? join(root, name) : name;
      if (await executableAt(path)) return path;
    }
  }
  return null;
}

async function installedApplications(): Promise<InstalledApplication[]> {
  const apps: InstalledApplication[] = [];
  async function add(id: string, label: string, candidates: string[], args: string[]) {
    for (const candidate of candidates) {
      const executable = await resolveExecutable(candidate);
      if (executable) {
        apps.push({ id, label, executable, args });
        return;
      }
    }
  }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((root): root is string => Boolean(root));
    const roots = [join(local, 'Programs'), ...programFiles];
    await add('folder', 'File Explorer', [join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')], ['{cwd}']);
    await add('vscode', 'VS Code', [...roots.map((root) => join(root, 'Microsoft VS Code', 'Code.exe')), 'Code.exe'], ['--new-window', '{cwd}']);
    await add('vscode-insiders', 'VS Code Insiders', [...roots.map((root) => join(root, 'Microsoft VS Code Insiders', 'Code - Insiders.exe')), 'Code - Insiders.exe'], ['--new-window', '{cwd}']);
    await add('cursor', 'Cursor', [...roots.map((root) => join(root, 'cursor', 'Cursor.exe')), 'Cursor.exe'], ['--new-window', '{cwd}']);
    await add('windsurf', 'Windsurf', [...roots.map((root) => join(root, 'Windsurf', 'Windsurf.exe')), 'Windsurf.exe'], ['--new-window', '{cwd}']);
    await add('zed', 'Zed', [...roots.map((root) => join(root, 'Zed', 'zed.exe')), 'zed.exe'], ['{cwd}']);
    await add('android-studio', 'Android Studio', programFiles.map((root) => join(root, 'Android', 'Android Studio', 'bin', 'studio64.exe')), ['{cwd}']);
    await add('terminal', 'Windows Terminal', [join(local, 'Microsoft', 'WindowsApps', 'wt.exe'), 'wt.exe'], ['-d', '{cwd}']);
    await add('powershell', 'Windows PowerShell', [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')], ['-NoExit']);
    const products = [
      ['idea', 'IntelliJ IDEA', 'IntelliJ IDEA', 'idea64.exe'],
      ['webstorm', 'WebStorm', 'WebStorm', 'webstorm64.exe'],
      ['pycharm', 'PyCharm', 'PyCharm', 'pycharm64.exe'],
      ['rider', 'Rider', 'Rider', 'rider64.exe'],
      ['goland', 'GoLand', 'GoLand', 'goland64.exe'],
      ['clion', 'CLion', 'CLion', 'clion64.exe'],
      ['phpstorm', 'PhpStorm', 'PhpStorm', 'phpstorm64.exe'],
      ['rustrover', 'RustRover', 'RustRover', 'rustrover64.exe'],
    ];
    for (const root of [...programFiles.map((root) => join(root, 'JetBrains')), join(local, 'Programs')]) {
      let directories;
      try {
        directories = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      for (const [id, label, prefix, exe] of products) {
        if (apps.some((app) => app.id === id)) continue;
        const candidates = directories.filter((dir) => dir.isDirectory() && dir.name.startsWith(prefix!))
          .map((dir) => join(root, dir.name, 'bin', exe!));
        await add(id!, label!, candidates, ['{cwd}']);
      }
    }
    for (const [id, label, command] of [
      ['sublime', 'Sublime Text', 'sublime_text.exe'],
      ['notepadpp', 'Notepad++', 'notepad++.exe'],
    ]) {
      await add(id!, label!, [...programFiles.map((root) => join(root, label!, command!)), command!],
        id === 'notepadpp' ? ['-openFoldersAsWorkspace', '{cwd}'] : ['--new-window', '{cwd}']);
    }
    // Visual Studio installs into edition-specific directories
    for (const root of programFiles) {
      for (const year of ['2026', '2022', '2019']) {
        if (apps.some((app) => app.id === 'visual-studio')) break;
        await add('visual-studio', 'Visual Studio', ['Community', 'Professional', 'Enterprise'].map(
          (edition) => join(root, 'Microsoft Visual Studio', year, edition, 'Common7', 'IDE', 'devenv.exe'),
        ), ['{cwd}']);
      }
    }
  } else if (process.platform === 'darwin') {
    await add('folder', 'Finder', ['/usr/bin/open'], ['{cwd}']);
    for (const [id, label, bundle] of [
      ['vscode', 'VS Code', 'Visual Studio Code'], ['vscode-insiders', 'VS Code Insiders', 'Visual Studio Code - Insiders'],
      ['cursor', 'Cursor', 'Cursor'], ['windsurf', 'Windsurf', 'Windsurf'],
      ['idea', 'IntelliJ IDEA', 'IntelliJ IDEA'], ['webstorm', 'WebStorm', 'WebStorm'],
      ['pycharm', 'PyCharm', 'PyCharm'], ['rider', 'Rider', 'Rider'], ['goland', 'GoLand', 'GoLand'],
      ['clion', 'CLion', 'CLion'], ['phpstorm', 'PhpStorm', 'PhpStorm'], ['rustrover', 'RustRover', 'RustRover'],
      ['terminal', 'Terminal', 'Utilities/Terminal'], ['iterm', 'iTerm', 'iTerm'],
    ]) {
      for (const root of ['/Applications', join(homedir(), 'Applications'), '/System/Applications']) {
        const appPath = join(root, `${bundle}.app`);
        try {
          if (!(await stat(appPath)).isDirectory()) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        await add(id!, label!, ['/usr/bin/open'], ['-a', appPath, '{cwd}']);
        break;
      }
    }
  } else {
    await add('folder', 'File manager', ['xdg-open'], ['{cwd}']);
    for (const [id, label, command, ...args] of [
      ['vscode', 'VS Code', 'code', '--new-window', '{cwd}'],
      ['vscode-insiders', 'VS Code Insiders', 'code-insiders', '--new-window', '{cwd}'],
      ['cursor', 'Cursor', 'cursor', '--new-window', '{cwd}'],
      ['windsurf', 'Windsurf', 'windsurf', '--new-window', '{cwd}'],
      ['idea', 'IntelliJ IDEA', 'idea', '{cwd}'], ['webstorm', 'WebStorm', 'webstorm', '{cwd}'],
      ['pycharm', 'PyCharm', 'pycharm', '{cwd}'], ['rider', 'Rider', 'rider', '{cwd}'],
      ['goland', 'GoLand', 'goland', '{cwd}'], ['clion', 'CLion', 'clion', '{cwd}'],
      ['terminal', 'Terminal', 'gnome-terminal', '--working-directory={cwd}'],
      ['konsole', 'Konsole', 'konsole', '--workdir', '{cwd}'],
      ['sublime', 'Sublime Text', 'subl', '{cwd}'],
    ]) await add(id!, label!, [command!], args);
  }
  return apps;
}

export async function directoryApplications(custom: string): Promise<DirectoryApplication[]> {
  const apps = await installedApplications();
  for (const app of customDirectoryApplications(custom)) {
    if (await resolveExecutable(app.executable)) apps.push(app);
  }
  return apps.map(({ id, label }) => ({ id, label }));
}

export async function openDirectory(cwd: string, target: string, custom: string): Promise<void> {
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('Working directory does not exist');
  const configured = customDirectoryApplications(custom).find((app) => app.id === target);
  const app = configured ?? (await installedApplications()).find((app) => app.id === target);
  if (!app) throw new Error('The selected application is no longer installed. Choose another application.');
  const executable = await resolveExecutable(app.executable);
  if (!executable) throw new Error(`Cannot find executable for ${app.label}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, directoryArguments(app.args, cwd), {
      cwd, shell: false, detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
