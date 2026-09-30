import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyDropped } from './dropped.js';

/**
 * What a drop turned out to be (#231).
 *
 * The window is handed paths and cannot read the disk, so everything it says about a drop
 * it learns here. Dropping a folder is an easy thing to do by accident, and attaching one
 * as a file would hand the runtime something it cannot open.
 */
describe('sorting what was dropped', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dropped-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const file = (name: string) => {
    const path = join(root, name);
    writeFileSync(path, 'x');
    return path;
  };

  const folder = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    return path;
  };

  it('takes a file', () => {
    const path = file('a.png');

    expect(classifyDropped([path])).toEqual({ files: [path], folders: [], missing: [] });
  });

  it('refuses a folder rather than calling it a file', () => {
    const path = folder('shots');

    expect(classifyDropped([path])).toEqual({ files: [], folders: [path], missing: [] });
  });

  /** A drop can name something that has since gone, and a chip for it would do nothing. */
  it('sets aside what it cannot look at', () => {
    const path = join(root, 'never-existed.png');

    expect(classifyDropped([path])).toEqual({ files: [], folders: [], missing: [path] });
  });

  /** Dropping a selection is one gesture, so one bad path must not lose the others. */
  it('keeps the files when the same drop carried a folder', () => {
    const good = file('a.png');
    const bad = folder('shots');
    const gone = join(root, 'gone.png');

    expect(classifyDropped([good, bad, gone])).toEqual({
      files: [good],
      folders: [bad],
      missing: [gone],
    });
  });

  it('keeps the order they were dropped in', () => {
    const first = file('1.png');
    const second = file('2.png');

    expect(classifyDropped([second, first]).files).toEqual([second, first]);
  });

  it('says nothing about a drop that carried nothing', () => {
    expect(classifyDropped([])).toEqual({ files: [], folders: [], missing: [] });
  });

  /**
   * A link to a file is a file: what was dropped is what it points at, which is what the
   * runtime will open. `lstat` would describe the link instead and refuse it.
   */
  it('follows a link to the file it names', () => {
    const target = file('real.png');
    const link = join(root, 'link.png');
    try {
      symlinkSync(target, link, 'file');
    } catch {
      // Windows refuses this without the privilege, and the rule is covered by the rest.
      return;
    }

    expect(classifyDropped([link])).toEqual({ files: [link], folders: [], missing: [] });
  });

  /** A link to a folder is still a folder, for the same reason. */
  it('sees through a link to a folder', () => {
    const target = folder('shots');
    const link = join(root, 'link');
    try {
      symlinkSync(target, link, 'junction');
    } catch {
      return;
    }

    expect(classifyDropped([link])).toEqual({ files: [], folders: [link], missing: [] });
  });
});
