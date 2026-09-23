// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HeaderTags } from './HeaderTags';

afterEach(cleanup);

describe('HeaderTags', () => {
  it('says what is true about the session being read', () => {
    render(<HeaderTags tags={['bug', 'unity']} onEdit={() => {}} />);

    expect([...document.querySelectorAll('.tag')].map((t) => t.textContent)).toEqual(['bug', 'unity']);
  });

  it('offers a way in when there is nothing to show', () => {
    // Otherwise tagging is reachable only from a right-click, which nobody finds by looking.
    render(<HeaderTags tags={[]} onEdit={() => {}} />);

    expect(screen.getByText('Add tags')).toBeTruthy();
  });

  it('opens the picker rather than filtering a list that may not be on screen', async () => {
    const onEdit = vi.fn();
    render(<HeaderTags tags={['bug']} onEdit={onEdit} />);

    await userEvent.click(screen.getByText('bug'));

    expect(onEdit).toHaveBeenCalledOnce();
  });

  it('opens it from the empty state too', async () => {
    const onEdit = vi.fn();
    render(<HeaderTags tags={[]} onEdit={onEdit} />);

    await userEvent.click(screen.getByText('Add tags'));

    expect(onEdit).toHaveBeenCalledOnce();
  });

  it('says what pressing it does, which differs by whether there is anything there', () => {
    render(<HeaderTags tags={['bug']} onEdit={() => {}} />);
    expect(screen.getByRole('button').getAttribute('title')).toBe('Edit tags');

    cleanup();
    render(<HeaderTags tags={[]} onEdit={() => {}} />);
    expect(screen.getByRole('button').getAttribute('title')).toBe('Tag this session');
  });

  it('is one control rather than one per tag', () => {
    // From here a tag is a fact about the session, not something to press on its own.
    render(<HeaderTags tags={['bug', 'unity', 'hades']} onEdit={() => {}} />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
