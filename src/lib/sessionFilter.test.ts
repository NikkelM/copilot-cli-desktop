import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../shared/protocol';
import { isEmpty, matchesQuery, parseQuery } from './sessionFilter';

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    sessionId: 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8',
    title: 'Biomes',
    cwd: 'C:\\work\\hades',
    repository: 'NikkelM/Hades',
    branch: 'main',
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    loaded: false,
    ...over,
  }) as SessionSummary;

const asks = (raw: string) => parseQuery(raw);

describe('parseQuery', () => {
  it('leaves plain text as one string, not as words', () => {
    // Splitting would widen every query anyone already types: "hades biomes" has always
    // meant that phrase, not those two words anywhere.
    expect(asks('hades biomes')).toEqual({ text: 'hades biomes', tags: [] });
  });

  it('lowercases, so the box is not case sensitive', () => {
    expect(asks('Biomes').text).toBe('biomes');
  });

  it('pulls a tag term out of the text', () => {
    expect(asks('tag:bug')).toEqual({ text: '', tags: ['bug'] });
  });

  it('keeps the rest of the text beside it', () => {
    expect(asks('tag:bug hades')).toEqual({ text: 'hades', tags: ['bug'] });
    expect(asks('hades tag:bug')).toEqual({ text: 'hades', tags: ['bug'] });
  });

  it('takes several tags', () => {
    expect(asks('tag:bug tag:spike').tags).toEqual(['bug', 'spike']);
  });

  it('normalises a tag, so Bug finds bug', () => {
    expect(asks('tag:Bug').tags).toEqual(['bug']);
  });

  it('takes a quoted tag, for one with a space in it', () => {
    expect(asks('tag:"needs review"').tags).toEqual(['needs review']);
    expect(asks("tag:'needs review'").tags).toEqual(['needs review']);
  });

  it('ignores a bare tag: as someone reaching for the name', () => {
    // Matching every tagged session mid-type would empty the list and refill it a keystroke
    // later, which reads as the box breaking.
    expect(asks('tag:')).toEqual({ text: '', tags: [] });
  });

  it('is empty for an empty box, and for whitespace', () => {
    expect(isEmpty(asks(''))).toBe(true);
    expect(isEmpty(asks('   '))).toBe(true);
  });

  it('is not empty once anything is asked for', () => {
    expect(isEmpty(asks('hades'))).toBe(false);
    expect(isEmpty(asks('tag:bug'))).toBe(false);
  });
});

describe('matchesQuery', () => {
  const match = (raw: string, over: Partial<SessionSummary> = {}, tags: string[] = []) =>
    matchesQuery(session(over), parseQuery(raw), tags);

  it.each([
    ['a title', 'biomes'],
    ['a directory', 'hades'],
    ['a repository', 'nikkelm'],
    ['a branch', 'main'],
  ])('matches %s', (_what, query) => {
    expect(match(query)).toBe(true);
  });

  it('matches an id from the start, not from anywhere inside it', () => {
    expect(match('f1ec2c40')).toBe(true);
    // A short query would otherwise match nearly every session in the list.
    expect(match('9eb5')).toBe(false);
  });

  it('matches nothing it does not contain', () => {
    expect(match('nonsense')).toBe(false);
  });

  describe('by tag', () => {
    it('finds a session carrying the tag', () => {
      expect(match('tag:bug', {}, ['bug'])).toBe(true);
    });

    it('passes over one that is not', () => {
      expect(match('tag:bug', {}, ['spike'])).toBe(false);
      expect(match('tag:bug', {}, [])).toBe(false);
    });

    it('wants all of them, since adding a term is narrowing', () => {
      expect(match('tag:bug tag:spike', {}, ['bug', 'spike'])).toBe(true);
      expect(match('tag:bug tag:spike', {}, ['bug'])).toBe(false);
    });

    it('narrows the text with the tag rather than widening it', () => {
      expect(match('tag:bug biomes', {}, ['bug'])).toBe(true);
      expect(match('tag:bug nonsense', {}, ['bug'])).toBe(false);
      expect(match('tag:spike biomes', {}, ['bug'])).toBe(false);
    });

    it('finds a tag typed without the prefix', () => {
      // Someone who types a tag name and gets nothing back concludes it did not save.
      expect(match('spike', {}, ['spike'])).toBe(true);
      expect(match('spi', {}, ['spike'])).toBe(true);
    });
  });
});
