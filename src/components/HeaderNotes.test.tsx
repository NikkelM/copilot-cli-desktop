// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { HeaderNotes } from './HeaderNotes';
import type { WikiPage } from '../../shared/protocol';

afterEach(cleanup);

const page = (path: string, title: string): WikiPage => ({ path, title });

/**
 * What this repository already has written down, in the session header (#35).
 *
 * The wiki is a destination nobody visits while working, so the notes that exist about a
 * repository are never found. This says they are there; pressing it goes to them.
 */
describe('the notes on a repository', () => {
  it('says how many there are', () => {
    render(<HeaderNotes pages={[page('a.md', 'A'), page('b.md', 'B')]} onOpen={() => {}} />);

    expect(screen.getByText('2 notes')).toBeTruthy();
  });

  it('counts one note as one', () => {
    render(<HeaderNotes pages={[page('a.md', 'A')]} onOpen={() => {}} />);

    expect(screen.getByText('1 note')).toBeTruthy();
  });

  /**
   * Silent rather than empty. Most repositories have no pages - measured, two of the three
   * busiest had none - and a header saying "no notes" on every one of them is a label
   * reporting an absence nobody asked about.
   */
  it('draws nothing at all where there are none', () => {
    const { container } = render(<HeaderNotes pages={[]} onOpen={() => {}} />);

    expect(container.querySelector('.header-notes')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('opens the first of them when pressed', () => {
    const onOpen = vi.fn();
    render(<HeaderNotes pages={[page('projects/x/first.md', 'First'), page('b.md', 'B')]} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith('projects/x/first.md');
  });

  /** One page can be named outright; several cannot, so the count is what is promised. */
  it('names the page where there is only one', () => {
    render(<HeaderNotes pages={[page('a.md', 'Conventions and testing')]} onOpen={() => {}} />);

    expect(screen.getByRole('button').getAttribute('title')).toContain('Conventions and testing');
  });

  it('says what it would open where there are several', () => {
    render(<HeaderNotes pages={[page('a.md', 'A'), page('b.md', 'B')]} onOpen={() => {}} />);

    expect(screen.getByRole('button').getAttribute('title')).toMatch(/2 pages/);
  });

  /**
   * The mark is decoration beside a count that already reads as words.
   *
   * Drawn rather than written as a character: a glyph brings its own font metrics into a
   * row whose text has different ones, and centring the two boxes left it sitting visibly
   * above the words beside it.
   */
  it('keeps its mark out of the text a reader is read', () => {
    const { container } = render(<HeaderNotes pages={[page('a.md', 'A')]} onOpen={() => {}} />);

    const mark = container.querySelector('.header-notes-mark')!;
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(mark.querySelector('svg'), 'a drawn mark cannot be misaligned by a font').toBeTruthy();
    expect(mark.textContent, 'nothing in it should be read out').toBe('');
  });

  it('says what it is for, since the mark says nothing out loud', () => {
    render(<HeaderNotes pages={[page('a.md', 'A')]} onOpen={() => {}} />);

    expect(screen.getByRole('button').textContent).toBe('1 note');
  });
});
