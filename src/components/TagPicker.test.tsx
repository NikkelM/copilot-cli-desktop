// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TagPicker } from './TagPicker';

afterEach(cleanup);

const show = (over: Partial<Parameters<typeof TagPicker>[0]> = {}) => {
  const props = {
    title: 'Biomes',
    held: [] as string[],
    known: [] as string[],
    onToggle: vi.fn(),
    onRetire: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<TagPicker {...props} />);
  return props;
};

const chips = () => [...document.querySelectorAll('.tag-list .tag-name')] as HTMLElement[];

describe('TagPicker', () => {
  it('says which session it is about', () => {
    show();

    expect(screen.getByText('Biomes')).toBeTruthy();
  });

  it('adds what was typed', async () => {
    const { onToggle } = show();

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'bug');
    await userEvent.click(screen.getByText('Add'));

    expect(onToggle).toHaveBeenCalledExactlyOnceWith('bug');
  });

  it('adds on Enter, since that is what a box with one field means', async () => {
    const { onToggle } = show();

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'bug{Enter}');

    expect(onToggle).toHaveBeenCalledExactlyOnceWith('bug');
  });

  it('empties the box afterwards, so the next one starts clean', async () => {
    show();
    const field = screen.getByLabelText('Find or add a tag') as HTMLInputElement;

    await userEvent.type(field, 'bug{Enter}');

    expect(field.value).toBe('');
  });

  it('will not add nothing', async () => {
    const { onToggle } = show();

    await userEvent.type(screen.getByLabelText('Find or add a tag'), '   {Enter}');

    expect(onToggle).not.toHaveBeenCalled();
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not add one the session already has, since that would take it off', async () => {
    // Typing a name into a box called Add cannot reasonably mean remove.
    const { onToggle } = show({ held: ['bug'] });

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'bug{Enter}');

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('offers tags already in use, so two spellings do not both take hold', () => {
    show({ known: ['bug', 'spike'] });

    expect(chips().map((c) => c.textContent)).toEqual(['bug', 'spike']);
  });

  it('puts what is true first, then what could be', () => {
    show({ held: ['needs review'], known: ['bug', 'needs review', 'spike'] });

    expect(chips().map((c) => c.textContent)).toEqual(['needs review', 'bug', 'spike']);
  });

  it('keeps them where they are while they are being ticked', async () => {
    // Held-first is decided when the dialog opens, not on every render: reordering as tags
    // are chosen moves the next one someone was reaching for out from under the pointer.
    const view = render(
      <TagPicker title="Biomes" held={[]} known={['bug', 'spike', 'unity']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );
    expect(chips().map((c) => c.textContent)).toEqual(['bug', 'spike', 'unity']);

    // As the app would redraw it once the tag landed in the store.
    view.rerender(
      <TagPicker title="Biomes" held={['unity']} known={['bug', 'spike', 'unity']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );

    expect(chips().map((c) => c.textContent)).toEqual(['bug', 'spike', 'unity']);
    expect(chips()[2]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('puts a tag invented while it is open at the end, displacing nothing', () => {
    const view = render(
      <TagPicker title="Biomes" held={[]} known={['bug', 'spike']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );

    view.rerender(
      <TagPicker title="Biomes" held={['fresh']} known={['bug', 'spike', 'fresh']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );

    expect(chips().map((c) => c.textContent)).toEqual(['bug', 'spike', 'fresh']);
  });

  it('takes the order again the next time it is opened', () => {
    render(<TagPicker title="Biomes" held={['unity']} known={['bug', 'spike', 'unity']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />);

    expect(chips().map((c) => c.textContent)).toEqual(['unity', 'bug', 'spike']);
  });

  it('marks the ones the session carries', () => {
    show({ held: ['bug'], known: ['bug', 'spike'] });

    const [bug, spike] = chips();
    expect(bug?.getAttribute('aria-pressed')).toBe('true');
    expect(spike?.getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles one that is offered', async () => {
    const { onToggle } = show({ known: ['bug'] });

    await userEvent.click(screen.getByText('bug'));

    expect(onToggle).toHaveBeenCalledExactlyOnceWith('bug');
  });

  it('stays open while several are changed', async () => {
    // Tags change in handfuls, which is why this is a dialog rather than a menu row.
    const { onToggle, onClose } = show({ known: ['bug', 'spike'] });

    await userEvent.click(screen.getByText('bug'));
    await userEvent.click(screen.getByText('spike'));

    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Done, on Escape, and on a click outside', async () => {
    const first = show();
    await userEvent.click(screen.getByText('Done'));
    expect(first.onClose).toHaveBeenCalledOnce();

    cleanup();
    const second = show();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(second.onClose).toHaveBeenCalledOnce();

    cleanup();
    const third = show();
    fireEvent.mouseDown(document.querySelector('.confirm-backdrop') as HTMLElement);
    expect(third.onClose).toHaveBeenCalledOnce();
  });

  it('stays open when the pointer goes down on the dialog itself', () => {
    const { onClose } = show();

    fireEvent.mouseDown(screen.getByRole('dialog'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens with the box focused, since adding one is why it was opened', () => {
    show();

    expect(document.activeElement?.getAttribute('aria-label')).toBe('Find or add a tag');
  });
});

describe('retiring a tag', () => {
  it('offers a way to take a name off every session', async () => {
    const { onRetire } = show({ known: ['bug'] });

    await userEvent.click(screen.getByLabelText('Remove bug from every session'));

    expect(onRetire).toHaveBeenCalledExactlyOnceWith('bug');
  });

  it('does not also change this session', async () => {
    // Two reaches from one row, so the wrong one must not fire alongside the right one.
    const { onToggle } = show({ known: ['bug'] });

    await userEvent.click(screen.getByLabelText('Remove bug from every session'));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('offers it for one the session carries too', async () => {
    const { onRetire } = show({ held: ['bug'], known: ['bug'] });

    await userEvent.click(screen.getByLabelText('Remove bug from every session'));

    expect(onRetire).toHaveBeenCalledExactlyOnceWith('bug');
  });

  it('stays open, since retiring several is the same handful of changes', async () => {
    const { onRetire, onClose } = show({ known: ['bug', 'spike'] });

    await userEvent.click(screen.getByLabelText('Remove bug from every session'));
    await userEvent.click(screen.getByLabelText('Remove spike from every session'));

    expect(onRetire).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says what it reaches, since the pill beside it reaches only this session', () => {
    show({ known: ['bug'] });

    expect(screen.getByLabelText('Remove bug from every session').getAttribute('title')).toBe(
      'Remove bug from every session',
    );
  });
  it('holds the name and the cross in one pill', () => {
    // A pill that is itself a control could not contain either of them.
    show({ known: ['bug'] });

    const pill = document.querySelector('.tag-list .tag') as HTMLElement;
    expect(pill.tagName).toBe('SPAN');
    expect(pill.querySelector('.tag-name')?.textContent).toBe('bug');
    expect(pill.querySelector('.tag-retire')).toBeTruthy();
  });
});

/**
 * The box that adds a tag also finds one. No second control and no threshold: it is as
 * useful at three tags as at three hundred, and typing a name that does not exist leaves an
 * empty list beside the Add button, which is exactly the choice being made.
 */
describe('finding a tag by typing', () => {
  const many = ['bug', 'spike', 'needs review', 'unity'];

  it('narrows to what matches', async () => {
    show({ known: many });

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'u');

    expect(chips().map((c) => c.textContent)).toEqual(['bug', 'unity']);
  });

  it('matches anywhere in the name, not only the start', async () => {
    show({ known: many });

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'review');

    expect(chips().map((c) => c.textContent)).toEqual(['needs review']);
  });

  it('ignores case, as the tags themselves do', async () => {
    show({ known: many });

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'BUG');

    expect(chips().map((c) => c.textContent)).toEqual(['bug']);
  });

  it('keeps the order it opened with rather than rebuilding it', async () => {
    show({ held: ['unity'], known: many });

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'u');

    // held-first, then the rest as they were - filtered, not reordered.
    expect(chips().map((c) => c.textContent)).toEqual(['unity', 'bug']);
  });

  it('puts everything back when the box is emptied', async () => {
    show({ known: many });
    const field = screen.getByLabelText('Find or add a tag');

    await userEvent.type(field, 'u');
    await userEvent.clear(field);

    expect(chips().map((c) => c.textContent)).toEqual(many);
  });

  it('offers nothing when nothing matches, which is the case for adding one', async () => {
    const { onToggle } = show({ known: many });

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'brand new');
    expect(chips()).toHaveLength(0);

    await userEvent.click(screen.getByText('Add'));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('brand new');
  });

  it('refuses to add one the session already has, and says why', async () => {
    show({ held: ['bug'], known: many });

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'bug');

    const add = screen.getByText('Add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('title')).toBe('This session already has bug');
  });

  it('still offers to add one that exists but is not on this session', async () => {
    show({ held: [], known: many });

    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'bug');

    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('a tag retired while the dialog is open', () => {
  it('leaves at once rather than waiting to be reopened', async () => {
    // The order is frozen so ticking does not move anything, which is why a name that has
    // gone has to be dropped deliberately.
    const view = render(
      <TagPicker title="Biomes" held={[]} known={['bug', 'spike']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );
    expect(chips().map((c) => c.textContent)).toEqual(['bug', 'spike']);

    view.rerender(
      <TagPicker title="Biomes" held={[]} known={['spike']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );

    expect(chips().map((c) => c.textContent)).toEqual(['spike']);
  });

  it('leaves the rest where they were', async () => {
    const view = render(
      <TagPicker title="Biomes" held={['unity']} known={['bug', 'spike', 'unity']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );
    expect(chips().map((c) => c.textContent)).toEqual(['unity', 'bug', 'spike']);

    view.rerender(
      <TagPicker title="Biomes" held={['unity']} known={['spike', 'unity']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );

    expect(chips().map((c) => c.textContent)).toEqual(['unity', 'spike']);
  });

  it('keeps one the session still carries, whatever the known list says', async () => {
    // A tag on the session in front of the reader is a fact about it, and dropping it from
    // the list would leave no way to take it off.
    const view = render(
      <TagPicker title="Biomes" held={[]} known={['bug']} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );

    view.rerender(
      <TagPicker title="Biomes" held={['bug']} known={[]} onToggle={vi.fn()} onRetire={vi.fn()} onClose={vi.fn()} />,
    );

    expect(chips().map((c) => c.textContent)).toEqual(['bug']);
  });
});