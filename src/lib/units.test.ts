import { describe, expect, it } from 'vitest';

import { bytes, credits, tokens } from './units';

describe('tokens', () => {
  // A context size is the whole difference between one tier and another, and 200000 is
  // harder to compare at a glance than 200k.
  it.each([
    [200_000, '200k'],
    [936_000, '936k'],
    [128_000, '128k'],
    [64_000, '64k'],
  ])('writes %i as %s', (count, expected) => {
    expect(tokens(count)).toBe(expected);
  });

  it('switches to millions once there are millions', () => {
    expect(tokens(1_000_000)).toBe('1M');
    expect(tokens(2_000_000)).toBe('2M');
  });

  it('keeps a decimal for a size between millions', () => {
    expect(tokens(1_500_000)).toBe('1.5M');
  });
});

describe('credits', () => {
  // The same rule the CLI uses: enough decimals to tell two prices apart, and no more.
  it('drops the decimals on a large price', () => {
    expect(credits(500)).toBe('500');
    expect(credits(2500)).toBe('2,500');
  });

  it('keeps one decimal in the tens', () => {
    expect(credits(12.34)).toBe('12.3');
  });

  it('keeps two below ten', () => {
    expect(credits(1.234)).toBe('1.23');
  });

  // A price too small to write is still not free, and rounding it to 0.00 would say it was.
  it('says a tiny price is tiny rather than zero', () => {
    expect(credits(0.0001)).toBe('<0.01');
  });

  it('writes free as free', () => {
    expect(credits(0)).toBe('0');
  });
});

describe('a size on disk', () => {
  it('leaves bytes alone', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(999)).toBe('999 B');
  });

  it('steps up at a thousand', () => {
    expect(bytes(1000)).toBe('1 kB');
    expect(bytes(2_400_000)).toBe('2.4 MB');
  });

  // One decimal below ten and none above, so a column of them lines up.
  it('spends a decimal only where it says something', () => {
    expect(bytes(1500)).toBe('1.5 kB');
    expect(bytes(12_300)).toBe('12 kB');
  });

  it('stops at gigabytes rather than naming a unit nobody reads', () => {
    expect(bytes(5_000_000_000_000)).toBe('5000 GB');
  });

  it('rounds a whole byte count rather than showing a fraction of one', () => {
    expect(bytes(1)).toBe('1 B');
  });
});
