import { describe, expect, it } from 'vitest';

import { relativise } from './paths';

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
