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

    // Typed with a space and added as a tag has to be spelled: one word, dashed (#35).
    await userEvent.click(screen.getByText('Add'));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('brand-new');
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

/**
 * The words the wiki is already written in, offered while a tag is being typed (#35).
 *
 * A session tagged in the wiki's own words matches the pages written in them; one tagged in
 * different words matches nothing. Measured rather than imagined: a session tagged `ireland`
 * and a page tagged `dublin` were about the same thing here and never met.
 */
describe('tags borrowed from the wiki', () => {
  // As the sidecar delivers them: commonest first, which this draws in the order given
  // rather than sorting again.
  const wikiTags = [
    { tag: 'dublin', pages: 3 },
    { tag: 'unity', pages: 2 },
    { tag: 'duplicates', pages: 1 },
  ];

  const suggestions = () =>
    [...document.querySelectorAll('.tag-from-wiki .tag-name')] as HTMLElement[];

  /** The control that stops one being offered, which sits beside the name as a cross. */
  const refusals = () => [...document.querySelectorAll('.tag-from-wiki .tag-retire')] as HTMLElement[];

  const typing = async (text: string, over: Partial<Parameters<typeof TagPicker>[0]> = {}) => {
    const props = show({ wikiTags, ...over });
    await userEvent.type(screen.getByLabelText('Find or add a tag'), text);
    return props;
  };

  /**
   * At rest as well as while typing, so the words a wiki is mostly written in are visible to
   * somebody who does not know to look for them - which is the whole problem.
   */
  it('offers the commonest of them before anything is typed', () => {
    show({ wikiTags });

    expect(suggestions().map((s) => s.textContent)).toEqual(['dublin3', 'unity2', 'duplicates1']);
  });

  /** The sidecar has already ranked them, so drawing them in another order would undo that. */
  it('keeps the order it was given', () => {
    show({ wikiTags: [{ tag: 'zebra', pages: 9 }, { tag: 'apple', pages: 1 }] });

    expect(suggestions().map((s) => s.textContent)).toEqual(['zebra9', 'apple1']);
  });

  it('narrows to what is being typed', async () => {
    await typing('dub');

    expect(suggestions().map((s) => s.textContent)).toEqual(['dublin3']);
  });

  it('says how many pages each would reach, which is why one is worth preferring', async () => {
    await typing('dub');

    expect(suggestions()[0]?.getAttribute('title')).toBe('Used on 3 pages in your wiki');
  });

  it('counts one page as one', async () => {
    await typing('dupl');

    expect(suggestions()[0]?.getAttribute('title')).toBe('Used on 1 page in your wiki');
  });

  it('puts one on the session when it is pressed', async () => {
    const { onToggle } = await typing('dub');

    await userEvent.click(suggestions()[0]!);

    expect(onToggle).toHaveBeenCalledExactlyOnceWith('dublin');
  });

  /** A word the sessions already use is offered above, and twice is once too many. */
  it('leaves out a word the sessions already use', async () => {
    await typing('unit', { known: ['unity'] });

    expect(suggestions()).toHaveLength(0);
  });

  it('leaves out a word this session already carries', async () => {
    await typing('unit', { held: ['unity'] });

    expect(suggestions()).toHaveLength(0);
  });

  it('says nothing where the wiki has no such word', async () => {
    await typing('ireland');

    expect(suggestions()).toHaveLength(0);
    expect(screen.queryByText('From your wiki')).toBeNull();
  });

  /** Roughly three rows of the dialog: enough to read past the first few, short of 889. */
  it('offers no more than about three rows of them at once', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ tag: `hades-${i}`, pages: 1 }));
    await typing('hades', { wikiTags: many });

    expect(suggestions()).toHaveLength(10);
  });

  it('says nothing about the wiki where there is none', async () => {
    const props = show({});
    await userEvent.type(screen.getByLabelText('Find or add a tag'), 'dub');

    expect(props.onToggle).not.toHaveBeenCalled();
    expect(screen.queryByText('From your wiki')).toBeNull();
  });

  /**
   * A wiki's commonest tags include the ones it is organised by rather than the ones that
   * say what a thing is about - `hades-ii` is on 67 of 117 pages here. Those are not wrong,
   * they are just never the answer, and a list that keeps offering them gets ignored.
   */
  describe('refusing one', () => {
    it('offers a way to stop being shown each', () => {
      show({ wikiTags });

      expect(refusals()).toHaveLength(3);
    });

    it('says which word it would stop suggesting', () => {
      show({ wikiTags });

      expect(refusals()[0]?.getAttribute('title')).toBe('Stop suggesting dublin');
    });

    it('hands the word up when the cross is pressed', async () => {
      const onDismiss = vi.fn();
      show({ wikiTags, onDismiss });

      await userEvent.click(refusals()[0]!);

      expect(onDismiss).toHaveBeenCalledExactlyOnceWith('dublin');
    });

    /** Refusing a suggestion is not choosing it, and the two controls sit side by side. */
    it('does not put the word on the session as well', async () => {
      const { onToggle } = show({ wikiTags, onDismiss: vi.fn() });

      await userEvent.click(refusals()[0]!);

      expect(onToggle).not.toHaveBeenCalled();
    });

    it('still lets the name itself be chosen', async () => {
      const { onToggle } = show({ wikiTags, onDismiss: vi.fn() });

      await userEvent.click(suggestions()[0]!);

      expect(onToggle).toHaveBeenCalledExactlyOnceWith('dublin');
    });
  });

  /**
   * Built from the same parts as a tag in use, which is where its spacing comes from. As a
   * single button it had half the inset of everything around it.
   */
  it('is a pill holding a name and a second control, as a tag in use is', () => {
    show({ wikiTags });

    const pill = document.querySelector('.tag-list .tag.tag-from-wiki');
    expect(pill, 'the suggestion should be a pill like the others').toBeTruthy();
    expect(pill?.querySelector('.tag-name'), 'with the name inside it').toBeTruthy();
    expect(pill?.querySelector('.tag-retire'), 'and a second control beside it').toBeTruthy();
  });
});