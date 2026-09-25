// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Excerpt, marked } from './Excerpt';

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

describe('Excerpt', () => {
  it('says nothing when the session was not found by what it said', () => {
    const { container } = render(<Excerpt match={undefined} />);
    expect(container.textContent).toBe('');
  });

  it('says nothing for a match with no words around it', () => {
    const { container } = render(<Excerpt match={{ sessionId: 'a', excerpt: '', turn: 1 }} />);
    expect(container.textContent).toBe('');
  });

  it('draws the matched words apart from the rest', () => {
    render(<Excerpt match={{ sessionId: 'a', excerpt: `the ${OPEN}eviction${SHUT} rule`, turn: 1 }} />);

    const hit = screen.getByText('eviction');
    expect(hit.tagName).toBe('MARK');
  });

  // The row clips to two lines, so the whole of it has to be reachable some other way.
  it('carries the whole excerpt as plain text for a reader who hovers', () => {
    const { container } = render(
      <Excerpt match={{ sessionId: 'a', excerpt: `the ${OPEN}eviction${SHUT} rule`, turn: 1 }} />,
    );

    expect(container.querySelector('p')?.getAttribute('title')).toBe('the eviction rule');
  });
});
