import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

vi.mock('./paths.js', () => ({
  sessionStateDir: (sessionId: string) => join(home, 'session-state', sessionId),
}));

const { addDirectory, extraDirectories, removeDirectory } = await import('./directories.js');

const storeOf = (sessionId: string) => join(home, 'session-state', sessionId, 'desktop-directories.json');

/** A real directory, because the store refuses paths it cannot find. */
function folder(name: string): string {
  const path = resolve(join(home, name));
  mkdirSync(path, { recursive: true });
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'directories-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the directories a session may reach', () => {
  it('starts with none', () => {
    expect(extraDirectories('s1')).toEqual([]);
  });

  it('remembers one that was added', () => {
    const wiki = folder('wiki');

    addDirectory('s1', wiki);

    expect(extraDirectories('s1')).toEqual([wiki]);
  });

  it('reports the whole list rather than the change', () => {
    const b = folder('b');
    const a = folder('a');
    addDirectory('s1', b);

    expect(addDirectory('s1', a)).toEqual([a, b]);
  });

  it('takes one back without disturbing the rest', () => {
    const a = folder('a');
    const b = folder('b');
    addDirectory('s1', a);
    addDirectory('s1', b);

    expect(removeDirectory('s1', a)).toEqual([b]);
  });

  it('keeps one session grant out of another', () => {
    addDirectory('s1', folder('wiki'));

    expect(extraDirectories('s2')).toEqual([]);
  });

  it('adding the same directory twice grants it once', () => {
    const wiki = folder('wiki');
    addDirectory('s1', wiki);

    expect(addDirectory('s1', wiki)).toEqual([wiki]);
  });

  it('removing one that was never granted changes nothing', () => {
    const wiki = folder('wiki');

    expect(removeDirectory('s1', wiki)).toEqual([]);
  });
});

describe('the paths themselves', () => {
  // The runtime resolves a relative path against the session's working directory, which is
  // not this process's, so it would mean somewhere else by the time it arrived.
  it('stores a relative path as an absolute one', () => {
    const nested = folder('nested');
    const previous = process.cwd();
    process.chdir(home);

    try {
      addDirectory('s1', 'nested');
    } finally {
      process.chdir(previous);
    }

    expect(extraDirectories('s1')).toEqual([nested]);
  });

  it('treats a trailing separator as the same directory', () => {
    const wiki = folder('wiki');
    addDirectory('s1', wiki);

    expect(addDirectory('s1', `${wiki}${sep}`)).toEqual([wiki]);
  });

  it('removes a directory named with a trailing separator', () => {
    const wiki = folder('wiki');
    addDirectory('s1', wiki);

    expect(removeDirectory('s1', `${wiki}${sep}`)).toEqual([]);
  });

  // The runtime skips an entry it cannot resolve, with a warning the reader never sees,
  // which would leave a path in the list looking granted while the agent could not reach it.
  it('refuses a directory that does not exist', () => {
    expect(() => addDirectory('s1', join(home, 'absent'))).toThrow(/Not a directory/);
  });

  it('refuses a file', () => {
    const file = join(home, 'notes.md');
    writeFileSync(file, 'hello');

    expect(() => addDirectory('s1', file)).toThrow(/Not a directory/);
  });

  it('leaves the list alone when it refuses one', () => {
    const wiki = folder('wiki');
    addDirectory('s1', wiki);

    expect(() => addDirectory('s1', join(home, 'absent'))).toThrow();

    expect(extraDirectories('s1')).toEqual([wiki]);
  });
});

describe('the file behind it', () => {
  // A session returned to its defaults should leave the same trace as one never touched.
  it('is removed once nothing is granted', () => {
    const wiki = folder('wiki');
    addDirectory('s1', wiki);
    expect(existsSync(storeOf('s1'))).toBe(true);

    removeDirectory('s1', wiki);

    expect(existsSync(storeOf('s1'))).toBe(false);
  });

  it('writes the directories it was given', () => {
    const wiki = folder('wiki');

    addDirectory('s1', wiki);

    expect(JSON.parse(readFileSync(storeOf('s1'), 'utf8'))).toEqual({ directories: [wiki] });
  });

  it('reads an unparseable file as none', () => {
    mkdirSync(join(home, 'session-state', 's1'), { recursive: true });
    writeFileSync(storeOf('s1'), '{ not json');

    expect(extraDirectories('s1')).toEqual([]);
  });

  it('ignores a file whose list is not a list', () => {
    mkdirSync(join(home, 'session-state', 's1'), { recursive: true });
    writeFileSync(storeOf('s1'), JSON.stringify({ directories: folder('wiki') }));

    expect(extraDirectories('s1')).toEqual([]);
  });

  it('keeps only the paths among whatever the file holds', () => {
    const real = folder('real');
    mkdirSync(join(home, 'session-state', 's1'), { recursive: true });
    writeFileSync(storeOf('s1'), JSON.stringify({ directories: [real, 7, null] }));

    expect(extraDirectories('s1')).toEqual([real]);
  });

  it('writes into a directory that does not exist yet', () => {
    const wiki = folder('wiki');

    expect(() => addDirectory('fresh', wiki)).not.toThrow();

    expect(extraDirectories('fresh')).toEqual([wiki]);
  });
});
