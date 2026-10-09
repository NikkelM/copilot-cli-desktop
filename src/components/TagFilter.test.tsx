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

/**
 * A list that appeared and left the keyboard on the button behind it would have to be
 * reached with Tab, which is what pressing the button was meant to save (#247).
 */
describe('reaching the tags without a mouse', () => {
  const known = [
    { tag: 'hades', count: 3 },
    { tag: 'copilot', count: 1 },
    { tag: 'mod', count: 2 },
  ];

  const show = (chosen: string[] = []) =>
    render(<TagFilter known={known} chosen={chosen} onToggle={() => {}} onClear={() => {}} />);

  const chips = () => [...document.querySelectorAll('.tag-filter-menu button.tag')] as HTMLElement[];
  const openIt = () => fireEvent.click(screen.getByRole('button', { name: /Filter by tag/ }));

  it('takes the keyboard to the first tag when it opens', () => {
    show();

    openIt();

    expect(document.activeElement).toBe(chips()[0]);
  });

  it.each([
    ['ArrowRight', 1],
    ['ArrowLeft', 2],
  ])('walks one tag along on %s', (key, landing) => {
    show();
    openIt();

    fireEvent.keyDown(chips()[0]!, { key });

    expect(document.activeElement, 'wrapping, as the other menus do').toBe(chips()[landing]);
  });

  /** They wrap across lines, so which arrow a reader reaches for depends on how they broke. */
  it('leaves every tag reachable by Tab as well', () => {
    show();
    openIt();

    expect(chips().every((chip) => chip.tabIndex >= 0)).toBe(true);
  });

  it('keeps the arrow to itself rather than letting the sidebar act on it', () => {
    show();
    openIt();

    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    chips()[0]!.dispatchEvent(event);

    expect(event.defaultPrevented, 'the list owns an arrow pressed inside it').toBe(true);
  });
});

/**
 * The tags wrap across however many lines the column allows, so down is not the next tag in
 * the list - it is the one below, which depends on where they happened to break.
 *
 * jsdom lays nothing out, so the lines are described here instead: six tags, three to a row,
 * each 60 wide and 20 tall.
 *
 *   0  1  2
 *   3  4  5
 */
describe('moving a line at a time through the tags', () => {
  const known = ['one', 'two', 'three', 'four', 'five', 'six'].map((tag, count) => ({ tag, count }));

  const chips = () => [...document.querySelectorAll('.tag-filter-menu button.tag')] as HTMLElement[];

  const laidOut = () => {
    render(<TagFilter known={known} chosen={[]} onToggle={() => {}} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Filter by tag/ }));

    chips().forEach((chip, index) => {
      const left = (index % 3) * 60;
      const top = Math.floor(index / 3) * 20;
      chip.getBoundingClientRect = () =>
        ({ left, top, width: 60, height: 20, right: left + 60, bottom: top + 20, x: left, y: top }) as DOMRect;
    });
    return chips();
  };

  it('goes to the tag below rather than the one after', () => {
    const all = laidOut();
    all[1]!.focus();

    fireEvent.keyDown(all[1]!, { key: 'ArrowDown' });

    expect(document.activeElement, 'the one under it, not the next in the list').toBe(all[4]);
  });

  it('goes to the tag above', () => {
    const all = laidOut();
    all[5]!.focus();

    fireEvent.keyDown(all[5]!, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(all[2]);
  });

  it('comes round to the first line from the last', () => {
    const all = laidOut();
    all[3]!.focus();

    fireEvent.keyDown(all[3]!, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(all[0]);
  });

  it('comes round to the last line from the first', () => {
    const all = laidOut();
    all[0]!.focus();

    fireEvent.keyDown(all[0]!, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(all[3]);
  });

  /**
   * Three lines, because with only two of them up and down land in the same place and a test
   * over such a list cannot tell the one from the other.
   *
   *   0  1  2
   *   3  4  5
   *   6  7  8
   */
  it.each([
    ['ArrowDown', 7],
    ['ArrowUp', 1],
  ])('goes the way it was asked on %s', (key, landing) => {
    const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((tag, count) => ({ tag, count }));
    render(<TagFilter known={nine} chosen={[]} onToggle={() => {}} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Filter by tag/ }));
    const all = chips();
    all.forEach((chip, index) => {
      const left = (index % 3) * 60;
      const top = Math.floor(index / 3) * 20;
      chip.getBoundingClientRect = () =>
        ({ left, top, width: 60, height: 20, right: left + 60, bottom: top + 20, x: left, y: top }) as DOMRect;
    });
    all[4]!.focus();

    fireEvent.keyDown(all[4]!, { key });

    expect(document.activeElement).toBe(all[landing]);
  });

  /** A short last line is the usual case, and down from above it has to land somewhere. */
  it('lands on the nearest tag when the line below is shorter', () => {
    render(<TagFilter known={known.slice(0, 5)} chosen={[]} onToggle={() => {}} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Filter by tag/ }));
    const all = chips();
    all.forEach((chip, index) => {
      const left = (index % 3) * 60;
      const top = Math.floor(index / 3) * 20;
      chip.getBoundingClientRect = () =>
        ({ left, top, width: 60, height: 20, right: left + 60, bottom: top + 20, x: left, y: top }) as DOMRect;
    });
    all[2]!.focus();

    fireEvent.keyDown(all[2]!, { key: 'ArrowDown' });

    expect(document.activeElement, 'the end of the line below, being nearest').toBe(all[4]);
  });
});
