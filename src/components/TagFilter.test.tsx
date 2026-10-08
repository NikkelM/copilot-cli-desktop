// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TagFilter } from './TagFilter';

afterEach(cleanup);

const KNOWN = [
  { tag: 'bug', count: 4 },
  { tag: 'spike', count: 2 },
];

const show = (over: Partial<Parameters<typeof TagFilter>[0]> = {}) => {
  const props = {
    known: KNOWN,
    chosen: [] as string[],
    onToggle: vi.fn(),
    onClear: vi.fn(),
    ...over,
  };
  render(<TagFilter {...props} />);
  return props;
};

const open = async () => userEvent.click(screen.getByRole('button', { name: /Filter by tag|Filtering by/ }));

describe('TagFilter', () => {
  it('says nothing at all until something has been tagged', () => {
    // A button that opens an empty list reads as a broken feature.
    show({ known: [] });

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps its list shut until it is asked for', () => {
    show();

    expect(screen.queryByRole('group')).toBeNull();
  });

  it('offers every tag in use, with how many carry it', async () => {
    show();

    await open();

    expect(screen.getByText('bug')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('spike')).toBeTruthy();
  });

  it('chooses one', async () => {
    const { onToggle } = show();
    await open();

    await userEvent.click(screen.getByText('bug'));

    expect(onToggle).toHaveBeenCalledExactlyOnceWith('bug');
  });

  it('stays open while several are chosen, since they narrow together', async () => {
    const { onToggle } = show();
    await open();

    await userEvent.click(screen.getByText('bug'));
    await userEvent.click(screen.getByText('spike'));

    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('group')).toBeTruthy();
  });

  it('marks what is already chosen', async () => {
    show({ chosen: ['bug'] });
    await open();

    const bug = screen.getByText('bug').closest('button') as HTMLElement;
    const spike = screen.getByText('spike').closest('button') as HTMLElement;
    expect(bug.getAttribute('aria-pressed')).toBe('true');
    expect(spike.getAttribute('aria-pressed')).toBe('false');
  });

  it('says a filter is on without having to be opened', () => {
    show({ chosen: ['bug', 'spike'] });

    const button = screen.getByRole('button');
    expect(button.classList.contains('on')).toBe(true);
    expect(button.textContent).toContain('2');
    expect(button.getAttribute('aria-label')).toBe('Filtering by bug, spike');
    // Drawn by the page rather than by `title`, so that arriving here with the keyboard does
    // not pop up a label nobody asked for.
    expect(button.getAttribute('data-tip')).toBe('Filtering by bug, spike');
    expect(button.getAttribute('title'), 'a native tooltip cannot be told when to appear').toBeNull();
  });

  it('says nothing is on when nothing is', () => {
    show();

    const button = screen.getByRole('button');
    expect(button.classList.contains('on')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Filter by tag');
    expect(button.getAttribute('data-tip')).toBe('Filter by tag');
  });

  it('offers a way out only once there is something to clear', async () => {
    show();
    await open();
    expect(screen.queryByText('Clear')).toBeNull();

    cleanup();
    const { onClear } = show({ chosen: ['bug'] });
    await open();
    await userEvent.click(screen.getByText('Clear'));

    expect(onClear).toHaveBeenCalledOnce();
  });

  it('shuts on Escape and on a click outside, without choosing anything', async () => {
    const first = show();
    await open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group')).toBeNull();
    expect(first.onToggle).not.toHaveBeenCalled();

    cleanup();
    show();
    await open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('shuts when its own button is pressed again', async () => {
    show();

    await open();
    expect(screen.getByRole('group')).toBeTruthy();

    await open();
    expect(screen.queryByRole('group')).toBeNull();
  });
});
