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

    await userEvent.type(screen.getByLabelText('Add a tag'), 'bug');
    await userEvent.click(screen.getByText('Add'));

    expect(onToggle).toHaveBeenCalledExactlyOnceWith('bug');
  });

  it('adds on Enter, since that is what a box with one field means', async () => {
    const { onToggle } = show();

    await userEvent.type(screen.getByLabelText('Add a tag'), 'bug{Enter}');

    expect(onToggle).toHaveBeenCalledExactlyOnceWith('bug');
  });

  it('empties the box afterwards, so the next one starts clean', async () => {
    show();
    const field = screen.getByLabelText('Add a tag') as HTMLInputElement;

    await userEvent.type(field, 'bug{Enter}');

    expect(field.value).toBe('');
  });

  it('will not add nothing', async () => {
    const { onToggle } = show();

    await userEvent.type(screen.getByLabelText('Add a tag'), '   {Enter}');

    expect(onToggle).not.toHaveBeenCalled();
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not add one the session already has, since that would take it off', async () => {
    // Typing a name into a box called Add cannot reasonably mean remove.
    const { onToggle } = show({ held: ['bug'] });

    await userEvent.type(screen.getByLabelText('Add a tag'), 'bug{Enter}');

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

    expect(document.activeElement?.getAttribute('aria-label')).toBe('Add a tag');
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