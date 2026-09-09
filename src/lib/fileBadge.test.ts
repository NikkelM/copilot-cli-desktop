import { describe, expect, it } from 'vitest';

import { fileBadge } from './fileBadge';

describe('fileBadge', () => {
  it.each([
    ['a.ts', 'TS', 'blue'],
    ['a.mts', 'TS', 'blue'],
    ['a.cts', 'TS', 'blue'],
    ['a.tsx', 'TX', 'blue'],
    ['a.js', 'JS', 'yellow'],
    ['a.jsx', 'JX', 'yellow'],
    ['a.json', '{}', 'green'],
    ['a.md', 'MD', 'gray'],
    ['a.rs', 'RS', 'red'],
    ['a.py', 'PY', 'cyan'],
    ['a.c', 'C', 'cyan'],
    ['a.cpp', 'C+', 'cyan'],
    ['a.cs', 'C#', 'green'],
    ['a.yml', 'YM', 'gray'],
    ['a.html', 'HT', 'yellow'],
    ['a.css', 'SS', 'cyan'],
    ['a.sql', 'SQ', 'green'],
  ])('marks %s as %s', (path, label, tone) => {
    expect(fileBadge(path)).toEqual({ label, tone });
  });

  it('tells a tsx apart from a ts', () => {
    expect(fileBadge('a.ts')?.label).not.toBe(fileBadge('a.tsx')?.label);
  });

  it('reads the extension of the file, not of a directory along the way', () => {
    expect(fileBadge('C:\\work\\my.app\\index.ts')).toEqual({ label: 'TS', tone: 'blue' });
    expect(fileBadge('/srv/my.app/notes')).toBeNull();
  });

  it('accepts either separator, since the path comes from wherever the session ran', () => {
    expect(fileBadge('C:\\a\\b\\main.rs')).toEqual({ label: 'RS', tone: 'red' });
    expect(fileBadge('/home/a/b/main.rs')).toEqual({ label: 'RS', tone: 'red' });
  });

  it('ignores case, so an uppercase extension is still known', () => {
    expect(fileBadge('README.MD')).toEqual({ label: 'MD', tone: 'gray' });
  });

  it('takes the last extension of several', () => {
    expect(fileBadge('patch.test.ts')).toEqual({ label: 'TS', tone: 'blue' });
    expect(fileBadge('bundle.min.js')).toEqual({ label: 'JS', tone: 'yellow' });
  });

  it('reads a leading dot as the start of a name rather than an extension', () => {
    expect(fileBadge('.gitignore')).toBeNull();
    expect(fileBadge('/home/me/.bashrc')).toBeNull();
  });

  it('has nothing for a name with no extension, or a trailing dot', () => {
    expect(fileBadge('Makefile')).toBeNull();
    expect(fileBadge('archive.')).toBeNull();
    expect(fileBadge('')).toBeNull();
  });

  it('guesses nothing for an extension it does not know', () => {
    expect(fileBadge('notes.txt')).toBeNull();
    expect(fileBadge('image.png')).toBeNull();
    expect(fileBadge('a.zig')).toBeNull();
  });

  // Beyond the CLI's own table: another spelling of something it already lists, or a type
  // that turns up in real sessions here and had no badge to show.
  it.each([
    ['a.xml', 'XM', 'gray'],
    ['a.svg', 'SV', 'gray'],
    ['a.lua', 'LU', 'blue'],
    ['a.ps1', 'PS', 'blue'],
    ['a.astro', 'AS', 'yellow'],
    ['a.hpp', 'H', 'cyan'],
    ['a.cxx', 'C+', 'cyan'],
    ['a.jsonc', '{}', 'green'],
    ['a.zsh', 'SH', 'gray'],
    ['a.htm', 'HT', 'yellow'],
    ['a.sass', 'SS', 'cyan'],
    ['a.less', 'LS', 'cyan'],
  ])('also marks %s as %s', (path, label, tone) => {
    expect(fileBadge(path)).toEqual({ label, tone });
  });

  // A sibling exists to read the same as the entry it was added for, so if one is ever
  // retuned and the other is not, this says so.
  it.each([
    ['a.md', 'a.markdown'],
    ['a.json', 'a.jsonc'],
    ['a.sh', 'a.zsh'],
    ['a.html', 'a.htm'],
    ['a.scss', 'a.sass'],
    ['a.cpp', 'a.cxx'],
    ['a.h', 'a.hxx'],
  ])('gives %s and %s the same mark', (one, other) => {
    expect(fileBadge(one)).toEqual(fileBadge(other));
  });
});
