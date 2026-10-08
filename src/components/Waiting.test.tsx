// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Waiting } from './Waiting';

afterEach(cleanup);

describe('Waiting', () => {
  it('says nothing when nothing is waiting', () => {
    // A count that reads zero most of the time is one the reader stops seeing.
    render(<Waiting count={0} onJump={() => {}} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says how many are', () => {
    render(<Waiting count={3} onJump={() => {}} />);

    expect(screen.getByRole('button').textContent).toContain('3 waiting');
  });

  it('goes to one when pressed', () => {
    const onJump = vi.fn();
    render(<Waiting count={2} onJump={onJump} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onJump).toHaveBeenCalledOnce();
  });

  it('offers the next one when there are several, and the one when there is one', () => {
    render(<Waiting count={1} onJump={() => {}} />);
    expect(screen.getByRole('button').getAttribute('data-tip')).toBe('Go to the session waiting for an answer');

    cleanup();
    render(<Waiting count={2} onJump={() => {}} />);
    expect(screen.getByRole('button').getAttribute('data-tip')).toBe('Go to the next session waiting for an answer');
  });

  it('wears the mark the rows wear, so the count and the row read as one thing', () => {
    render(<Waiting count={1} onJump={() => {}} />);

    expect(screen.getByRole('button').querySelector('.activity-blocked')).toBeTruthy();
  });
});
