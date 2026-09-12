import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCliPath } from './paths.js';

/**
 * Finding the CLI the SDK should drive.
 *
 * Every installer puts it somewhere different - winget copies a real executable onto PATH,
 * npm hides the platform package inside its own node_modules - so this is the one piece of
 * the sidecar that has to cope with a machine it was not set up on.
 */
let root: string;
let originalPath: string | undefined;
let originalAppData: string | undefined;

/** The binary the SDK spawns directly, so a shell wrapper of the same name is not it. */
const binary = process.platform === 'win32' ? 'copilot.exe' : 'copilot';

function binDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(dir: string, file: string): string {
  const full = join(dir, file);
  writeFileSync(full, '');
  return full;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccd-paths-'));
  originalPath = process.env.PATH;
  originalAppData = process.env.APPDATA;

  // Nothing is found unless a test puts it there, so a real install cannot make a test pass.
  process.env.PATH = binDir('empty');
  process.env.APPDATA = binDir('appdata');
  delete process.env.COPILOT_CLI_PATH;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  delete process.env.COPILOT_CLI_PATH;
});

describe('an explicit override', () => {
  it('is used ahead of anything installed', () => {
    const onPath = put(binDir('winget'), binary);
    const chosen = put(binDir('elsewhere'), binary);
    process.env.PATH = join(root, 'winget');
    process.env.COPILOT_CLI_PATH = chosen;

    expect(resolveCliPath()).toBe(chosen);
    expect(resolveCliPath()).not.toBe(onPath);
  });

  /** A stale override should not shadow a working install, so it is only honoured if it exists. */
  it('is ignored when it points at nothing', () => {
    const onPath = put(binDir('winget'), binary);
    process.env.PATH = join(root, 'winget');
    process.env.COPILOT_CLI_PATH = join(root, 'gone', binary);

    expect(resolveCliPath()).toBe(onPath);
  });
});

describe('looking along PATH', () => {
  it('finds the executable a terminal would run', () => {
    const expected = put(binDir('winget'), binary);
    process.env.PATH = join(root, 'winget');

    expect(resolveCliPath()).toBe(expected);
  });

  it('takes the first entry that has it, as a shell would', () => {
    const first = put(binDir('first'), binary);
    put(binDir('second'), binary);
    process.env.PATH = [join(root, 'first'), join(root, 'second')].join(delimiter);

    expect(resolveCliPath()).toBe(first);
  });

  it('walks past entries that do not have it', () => {
    binDir('nothing-here');
    const expected = put(binDir('winget'), binary);
    process.env.PATH = [join(root, 'nothing-here'), join(root, 'winget')].join(delimiter);

    expect(resolveCliPath()).toBe(expected);
  });

  /** An empty entry is an ordinary way to write PATH, and joining it would search the cwd. */
  it('is not tripped up by an empty entry', () => {
    const expected = put(binDir('winget'), binary);
    process.env.PATH = ['', join(root, 'winget'), ''].join(delimiter);

    expect(resolveCliPath()).toBe(expected);
  });

  it('says nothing rather than guessing when PATH is unset', () => {
    delete process.env.PATH;

    expect(resolveCliPath()).toBeNull();
  });
});

describe('an npm install', () => {
  /**
   * npm writes a `.cmd` shim on Windows, which the SDK cannot spawn without a shell, so the
   * platform package inside node_modules is used instead of whatever sits on PATH.
   */
  it('is found through its platform package rather than its shim', () => {
    const appdata = join(root, 'appdata');
    const nested = join(
      appdata,
      'npm',
      'node_modules',
      '@github',
      'copilot',
      'node_modules',
      '@github',
      process.platform === 'win32'
        ? 'copilot-win32-x64'
        : process.platform === 'darwin'
          ? 'copilot-darwin-arm64'
          : 'copilot-linux-x64',
    );
    mkdirSync(nested, { recursive: true });
    const expected = put(nested, binary);

    expect(resolveCliPath()).toBe(expected);
  });
});

describe('a machine with no CLI at all', () => {
  it('reports that rather than a path that does not work', () => {
    expect(resolveCliPath()).toBeNull();
  });
});
