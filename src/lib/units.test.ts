import { describe, expect, it } from 'vitest';

import { credits, tokens } from './units';

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
