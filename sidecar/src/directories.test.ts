import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import { listDirectories, listEntries, resolveDirectory } from './directories.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccd-directories-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('directory completion', () => {
  it('lists directories but not files', async () => {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, 'package.json'), '{}');

    expect(await listDirectories(root, '')).toEqual(['.github', 'src']);
  });

  it('lists below a relative path from the session working directory', async () => {
    mkdirSync(join(root, 'src', 'components'), { recursive: true });
    mkdirSync(join(root, 'src', 'lib'), { recursive: true });

    expect(await listDirectories(root, `src${sep}`)).toEqual(['components', 'lib']);
  });

  it('accepts an absolute path without a working directory', async () => {
    mkdirSync(join(root, 'inside'));

    expect(await listDirectories(undefined, root)).toEqual(['inside']);
  });

  it('does not substitute the sidecar directory for an absent session directory', async () => {
    expect(await listDirectories(undefined, 'relative')).toEqual([]);
  });

  it('offers nothing while the directory part does not exist yet', async () => {
    await expect(listDirectories(root, `not-there${sep}`)).resolves.toEqual([]);
  });

  it('expands a leading home shorthand', () => {
    expect(resolveDirectory(root, `~${sep}projects`, homedir())).toBe(join(homedir(), 'projects'));
  });

  it('leaves a tilde in the middle of a path alone', () => {
    const resolved = resolveDirectory(root, `projects${sep}~archive`, homedir());
    expect(resolved).not.toBeNull();
    expect(isAbsolute(resolved!)).toBe(true);
    expect(resolved).toBe(join(root, 'projects', '~archive'));
  });
});

describe('listing files as well as folders', () => {
  /** Naming a file is what `@` is for, so this keeps what the directory menu throws away. */
  it('lists both, saying which is which', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{}');

    expect(await listEntries(root, '')).toEqual([
      { name: 'src', directory: true },
      { name: 'package.json', directory: false },
    ]);
  });

  /** A path being typed is walked before it is finished, and a folder of a hundred files
      with one subdirectory among them is one the reader would have to hunt through. */
  it('puts folders first, then sorts by name', async () => {
    mkdirSync(join(root, 'zebra'));
    mkdirSync(join(root, 'alpha'));
    writeFileSync(join(root, 'README.md'), '');

    expect((await listEntries(root, '')).map((entry) => entry.name)).toEqual(['alpha', 'zebra', 'README.md']);
  });

  it('reads below a relative path from the session working directory', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'App.tsx'), '');

    expect(await listEntries(root, `src${sep}`)).toEqual([{ name: 'App.tsx', directory: false }]);
  });

  it('offers nothing while the directory part does not exist yet', async () => {
    await expect(listEntries(root, `not-there${sep}`)).resolves.toEqual([]);
  });

  it('does not substitute the sidecar directory for an absent session directory', async () => {
    expect(await listEntries(undefined, 'relative')).toEqual([]);
  });

  /** The folder menu is built on this one, so the two cannot drift apart. */
  it('is what the folder listing keeps the folders from', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{}');

    expect(await listDirectories(root, '')).toEqual(['src']);
  });
});
