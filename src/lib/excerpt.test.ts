import { describe, expect, it } from 'vitest';

import { marked, unmarked } from './excerpt';

const OPEN = '\u0002';
const SHUT = '\u0003';

/**
 * The marks come from SQLite rather than from this app, so they are parsed rather than
 * trusted: an unpaired one should still draw a readable line.
 */
describe('splitting an excerpt', () => {
  it('leaves text with no marks alone', () => {
    expect(marked('nothing matched here')).toEqual([{ text: 'nothing matched here', hit: false }]);
  });

  it('finds the part that matched', () => {
    expect(marked(`we discussed ${OPEN}eviction${SHUT} at length`)).toEqual([
      { text: 'we discussed ', hit: false },
      { text: 'eviction', hit: true },
      { text: ' at length', hit: false },
    ]);
  });

  it('finds every part that matched', () => {
    expect(marked(`${OPEN}a${SHUT} and ${OPEN}b${SHUT}`)).toEqual([
      { text: 'a', hit: true },
      { text: ' and ', hit: false },
      { text: 'b', hit: true },
    ]);
  });

  it('handles a match at the very start', () => {
    expect(marked(`${OPEN}eviction${SHUT} came first`)).toEqual([
      { text: 'eviction', hit: true },
      { text: ' came first', hit: false },
    ]);
  });

  // Drawing too much beats dropping the rest of the line silently.
  it('takes an unclosed mark as running to the end', () => {
    expect(marked(`we discussed ${OPEN}eviction at length`)).toEqual([
      { text: 'we discussed ', hit: false },
      { text: 'eviction at length', hit: true },
    ]);
  });

  it('has nothing to say about an empty excerpt', () => {
    expect(marked('')).toEqual([]);
  });
});

describe('the excerpt without its marks', () => {
  it('reads as the sentence it came from', () => {
    expect(unmarked(`the ${'\u0002'}eviction${'\u0003'} rule`)).toBe('the eviction rule');
  });

  it('leaves text that never had any alone', () => {
    expect(unmarked('nothing matched')).toBe('nothing matched');
  });
});
