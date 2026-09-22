import { describe, expect, it } from 'vitest';

import { anyMatch, matches } from './settingsSearch';

describe('finding a setting', () => {
  const entry = {
    label: 'Keep a deleted session for',
    keywords: 'retention days recycle bin restore',
    options: ['stable', 'prerelease'],
  };

  it('finds one by what it is called', () => {
    expect(matches('deleted', entry)).toBe(true);
  });

  it('finds one by what it is about, which the label may not say', () => {
    expect(matches('retention', entry)).toBe(true);
  });

  // Searching `prerelease` should find the channel without anybody knowing its name.
  it('finds one by what it can be set to', () => {
    expect(matches('prerelease', entry)).toBe(true);
  });

  it('says no to something it does not hold', () => {
    expect(matches('proxy', entry)).toBe(false);
  });

  it('ignores case, since nobody types a label the way it is written', () => {
    expect(matches('KEPT DELETED', { label: 'Kept a deleted session' })).toBe(true);
  });

  /** "deleted keep" and "keep deleted" are the same question. */
  it('takes the words in any order', () => {
    expect(matches('deleted keep', entry)).toBe(true);
  });

  it('wants every word rather than any of them', () => {
    expect(matches('deleted proxy', entry)).toBe(false);
  });

  it('matches partway through a word, so a half-typed one still finds it', () => {
    expect(matches('delet', entry)).toBe(true);
  });

  it('matches everything before anything is typed', () => {
    expect(matches('', entry)).toBe(true);
  });

  it('treats a query of nothing but spaces as nothing typed', () => {
    expect(matches('   ', entry)).toBe(true);
  });

  it('copes with a setting that has nothing but a name', () => {
    expect(matches('model', { label: 'model' })).toBe(true);
    expect(matches('proxy', { label: 'model' })).toBe(false);
  });
});

describe('whether a category is worth opening', () => {
  const entries = [{ label: 'App scale' }, { label: 'Text size', keywords: 'font' }];

  it('is, when it holds one match', () => {
    expect(anyMatch('font', entries)).toBe(true);
  });

  it('is not, when it holds none', () => {
    expect(anyMatch('proxy', entries)).toBe(false);
  });

  it('is, before anything is typed', () => {
    expect(anyMatch('', entries)).toBe(true);
  });

  /** An empty category cannot hold a match, whatever was typed. */
  it('is not, when it holds nothing at all', () => {
    expect(anyMatch('anything', [])).toBe(false);
  });
});
