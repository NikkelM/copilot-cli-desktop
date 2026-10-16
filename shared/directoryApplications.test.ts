import { describe, expect, it } from 'vitest';

import { customDirectoryApplications, directoryArguments, parseDirectoryArguments, formatDirectoryArguments } from './directoryApplications.js';

const target = { id: 'custom-editor', label: 'My editor', executable: 'C:\\Editor\\editor.exe', args: ['--new-window', '{cwd}'] };

describe('custom directory applications', () => {
  it('parses quoted values, empty arguments and literal shell characters', () => {
    expect(parseDirectoryArguments('--folder "{cwd}" --title "My folder" "" & literal'))
      .toEqual(['--folder', '{cwd}', '--title', 'My folder', '', '&', 'literal']);
  });

  it('preserves Windows paths and escaped quotes when formatting saved argument lists', () => {
    const args = ['C:\\a folder\\', 'plain', 'say "hello"', '', '{cwd}', 'C:\\no-spaces\\'];
    expect(parseDirectoryArguments(formatDirectoryArguments(args))).toEqual(args);
  });

  it('validates quotes on save but preserves unfinished input while editing', () => {
    const value = JSON.stringify([{ ...target, commandLine: '--title "unfinished' }]);
    expect(() => customDirectoryApplications(value)).toThrow('unclosed double quote');
    expect(customDirectoryApplications(value, true)[0]?.commandLine).toBe('--title "unfinished');
  });

  it('normalizes single-line arguments before directory substitution', () => {
    const value = JSON.stringify([{ ...target, commandLine: '--title "My folder" "{cwd}"' }]);
    expect(customDirectoryApplications(value)[0]?.args).toEqual(['--title', 'My folder', '{cwd}']);
  });
  it('keeps multiple named targets and their distinct arguments', () => {
    expect(customDirectoryApplications(JSON.stringify([target, { ...target, id: 'custom-second', args: [] }]))).toEqual([
      target, { ...target, id: 'custom-second', args: [] },
    ]);
  });

  it.each([
    '{}', '{', '[null]', JSON.stringify([{ ...target, id: 'folder' }]),
    JSON.stringify([{ ...target, label: '' }]), JSON.stringify([{ ...target, executable: '' }]),
    JSON.stringify([{ ...target, args: ['ok', 42] }]), JSON.stringify([target, target]),
    JSON.stringify([{ ...target, executable: 'bad\0exe' }]),
  ])('rejects invalid configuration %s', (value) => {
    expect(() => customDirectoryApplications(value)).toThrow();
  });

  it('allows incomplete form fields only while editing', () => {
    const value = JSON.stringify([{ ...target, label: '', executable: '' }]);
    expect(customDirectoryApplications(value, true)).toHaveLength(1);
    expect(() => customDirectoryApplications(value)).toThrow();
  });

  it('substitutes the directory without splitting or interpreting any characters', () => {
    const cwd = 'C:\\work\\C# & $(not-a-command) "quoted"';
    expect(directoryArguments(['--folder={cwd}', '{cwd}', 'literal'], cwd)).toEqual([
      `--folder=${cwd}`, cwd, 'literal',
    ]);
  });
});
