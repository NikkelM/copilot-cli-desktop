// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Excerpt } from './Excerpt';

const OPEN = '\u0002';
const SHUT = '\u0003';

describe('Excerpt', () => {
  it('says nothing when the session was not found by what it said', () => {
    const { container } = render(<Excerpt excerpt={undefined} />);
    expect(container.textContent).toBe('');
  });

  it('says nothing for a match with no words around it', () => {
    const { container } = render(<Excerpt excerpt="" />);
    expect(container.textContent).toBe('');
  });

  it('draws the matched words apart from the rest', () => {
    render(<Excerpt excerpt={`the ${OPEN}eviction${SHUT} rule`} />);

    const hit = screen.getByText('eviction');
    expect(hit.tagName).toBe('MARK');
  });

  // The row clips to two lines, so the whole of it has to be reachable some other way.
  it('carries the whole excerpt as plain text for a reader who hovers', () => {
    const { container } = render(<Excerpt excerpt={`the ${OPEN}eviction${SHUT} rule`} />);

    expect(container.querySelector('p')?.getAttribute('title')).toBe('the eviction rule');
  });
});

