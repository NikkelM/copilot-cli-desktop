import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatClock, formatElapsed, formatExact, formatRelative } from './time';

const at = (ms: number) => new Date(Date.now() - ms).toISOString();

afterEach(() => vi.useRealTimers());

describe('formatRelative', () => {
  it.each([
    [5_000, '5s ago'],
    [90_000, '1m ago'],
    [7_200_000, '2h ago'],
    [3 * 86_400_000, '3d ago'],
  ])('writes %ims ago as %s', (elapsed, expected) => {
    expect(formatRelative(at(elapsed))).toBe(expected);
  });

  // Under a second is still something that happened, and "0s ago" reads as broken.
  it('never counts down to nothing', () => {
    expect(formatRelative(at(200))).toBe('1s ago');
  });

  // A clock that disagrees with the runtime's should not produce a negative age.
  it('calls a time in the future just now', () => {
    expect(formatRelative(new Date(Date.now() + 60_000).toISOString())).toBe('just now');
  });

  // "312d ago" is worth less than knowing it was in November.
  it('gives a date once relative stops saying anything', () => {
    const old = formatRelative(at(400 * 86_400_000));

    expect(old).not.toContain('ago');
    expect(old).toMatch(/\d{4}/);
  });

  // The session store writes its own format, without a zone marker, in UTC.
  it('reads a time without a zone as UTC rather than local', () => {
    const iso = new Date(Date.now() - 5000).toISOString();
    const sqlite = iso.replace('T', ' ').replace(/\.\d+Z$/, '');

    expect(formatRelative(sqlite)).toBe('5s ago');
  });

  it('says nothing about a time it cannot read', () => {
    expect(formatRelative('not a time')).toBe('');
  });
});

describe('formatClock', () => {
  it('reads a moment as a clock does', () => {
    const at = new Date('2026-09-05T12:52:02.227Z');
    expect(formatClock(at.toISOString())).toBe(
      at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    );
  });

  // The store writes some timestamps in SQLite's own format rather than as ISO.
  it('reads the database format too', () => {
    expect(formatClock('2026-09-05 12:52:02')).toMatch(/\d/);
  });

  it('says nothing about a time it cannot read', () => {
    expect(formatClock('not a time')).toBe('');
  });
});

describe('formatExact', () => {
  it('gives the moment itself', () => {
    expect(formatExact('2026-09-05T12:52:02.227Z')).toContain('2026');
  });

  it('says nothing about a time it cannot read', () => {
    expect(formatExact('not a time')).toBe('');
  });
});

describe('formatElapsed', () => {
  it.each([
    [0, '0s'],
    [1500, '1s'],
    [59_000, '59s'],
    [79_000, '1m 19s'],
    [3_600_000, '1h 0m'],
    [5_400_000, '1h 30m'],
  ])('writes %ims as %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });

  it('says nothing about a duration that makes no sense', () => {
    expect(formatElapsed(-1)).toBe('');
    expect(formatElapsed(Number.NaN)).toBe('');
  });
});
