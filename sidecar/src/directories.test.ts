import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import { listDirectories, resolveDirectory } from './directories.js';

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
