import { describe, expect, it } from 'vitest';

import { relativise, shortenHome } from './paths';

describe('relativise', () => {
  it('strips the working directory prefix', () => {
    expect(relativise('C:\\work\\repo\\src\\index.ts', 'C:\\work\\repo')).toBe('src/index.ts');
  });

  it('ignores case, since Windows paths are case-insensitive', () => {
    expect(relativise('c:\\Work\\Repo\\src\\a.ts', 'C:\\work\\repo')).toBe('src/a.ts');
  });

  it('tolerates a trailing separator on the working directory', () => {
    expect(relativise('C:\\work\\repo\\a.ts', 'C:\\work\\repo\\')).toBe('a.ts');
  });

  it('leaves paths outside the working directory alone', () => {
    expect(relativise('C:\\other\\a.ts', 'C:\\work\\repo')).toBe('C:\\other\\a.ts');
  });

  // A sibling directory shares the prefix as a string but is not inside it.
  it('does not strip a merely similar prefix', () => {
    expect(relativise('C:\\work\\repo-two\\a.ts', 'C:\\work\\repo')).toBe('C:\\work\\repo-two\\a.ts');
  });

  it('returns the path unchanged when there is no working directory', () => {
    expect(relativise('/tmp/a.ts', null)).toBe('/tmp/a.ts');
  });

  it('handles posix paths', () => {
    expect(relativise('/home/u/repo/src/a.ts', '/home/u/repo')).toBe('src/a.ts');
  });
});

describe('shortenHome', () => {
  it('writes the home directory as a tilde', () => {
    expect(shortenHome('C:\\Users\\test\\Projects\\thing', 'C:\\Users\\test')).toBe('~\\Projects\\thing');
  });

  it('keeps the separator the path was written with', () => {
    expect(shortenHome('/home/test/projects/thing', '/home/test')).toBe('~/projects/thing');
  });

  it('writes home itself as a tilde alone', () => {
    expect(shortenHome('C:\\Users\\test', 'C:\\Users\\test')).toBe('~');
  });

  it('ignores case, since Windows paths are case-insensitive', () => {
    expect(shortenHome('c:\\users\\Test\\work', 'C:\\Users\\test')).toBe('~\\work');
  });

  // A sibling directory whose name starts the same way is not inside home.
  it('leaves a path that only looks like home alone', () => {
    expect(shortenHome('C:\\Users\\test2\\work', 'C:\\Users\\test')).toBe('C:\\Users\\test2\\work');
  });

  it('leaves a path outside home alone', () => {
    expect(shortenHome('D:\\work\\repo', 'C:\\Users\\test')).toBe('D:\\work\\repo');
  });

  // The home directory is asked of the system, so there is a moment before it is known.
  it('leaves paths alone until home is known', () => {
    expect(shortenHome('C:\\Users\\test\\work', '')).toBe('C:\\Users\\test\\work');
  });
});
