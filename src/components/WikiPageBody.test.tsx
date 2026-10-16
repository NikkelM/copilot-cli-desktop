// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WikiPageBody } from './WikiPageBody';
import type { WikiPage, WikiPageContent } from '../../shared/protocol';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

const PAGES: WikiPage[] = [
  { path: 'resources/guides/desktop.md', title: 'Desktop app' },
  { path: 'areas/copilot.md', title: 'Copilot CLI' },
];

const content = (source: string, path = 'resources/guides/desktop.md'): WikiPageContent =>
  ({ path, source }) as WikiPageContent;

const show = (over: Partial<Parameters<typeof WikiPageBody>[0]> = {}) => {
  const props = {
    page: content('# Desktop app\n\nHow it is built.'),
    pages: PAGES,
    source: '# Desktop app\n\nHow it is built.',
    raw: false,
    loading: false,
    onEdit: vi.fn(),
    onOpen: vi.fn(),
    ...over,
  };
  render(<WikiPageBody {...props} />);
  return props;
};

/**
 * One page, drawn the same way wherever it is read (#35).
 *
 * Its own component because every step here is a way the browser and the column beside a
 * session could come to disagree about what a page looks like.
 */
describe('a wiki page', () => {
  it('renders plain-document frontmatter once without treating it as Markdown prose', () => {
    show({
      page: { path: 'plan.md' }, pages: null, onOpen: undefined,
      source: '---\ntitle: A plain plan\n---\n\n# Implementation',
    });

    expect(screen.getByRole('heading', { name: 'Implementation' })).toBeTruthy();
    expect(screen.getAllByText(/A plain plan/)).toHaveLength(1);
    expect(document.querySelector('.wiki-meta')).toBeTruthy();
  });

  it('also renders and edits a plain Markdown document without a wiki page list', () => {
    show({
      page: { path: 'plan.md' }, pages: null,
      raw: true, sourceLabel: 'Plan Markdown', disabled: true,
    });
    const editor = screen.getByRole('textbox', { name: 'Plan Markdown' }) as HTMLTextAreaElement;
    expect(editor.className).toBe('wiki-source');
    expect(editor.disabled).toBe(true);
  });

  it('renders what it says', () => {
    show();

    expect(screen.getByRole('heading', { name: 'Desktop app' })).toBeTruthy();
  });

  it('shows the file itself when asked for it', () => {
    show({ raw: true });

    expect(screen.getByLabelText('Source of resources/guides/desktop.md')).toBeTruthy();
  });

  it('hands over what was typed into it', async () => {
    const onEdit = vi.fn();
    show({ raw: true, onEdit });

    await userEvent.type(screen.getByLabelText('Source of resources/guides/desktop.md'), 'x');

    expect(onEdit.mock.lastCall?.[0]).toBe('resources/guides/desktop.md');
  });

  it('says it is reading rather than looking empty', () => {
    show({ page: null, loading: true });

    expect(screen.getByText('Reading…')).toBeTruthy();
  });

  it('says so where no page has been chosen', () => {
    show({ page: null });

    expect(screen.getByText('Choose a page.')).toBeTruthy();
  });

  /** The column says something else, since "choose" is not what its reader is doing. */
  it('says what the place it is drawn in asked it to', () => {
    show({ page: null, empty: 'Nothing open.' });

    expect(screen.getByText('Nothing open.')).toBeTruthy();
  });

  it('shows the file rather than the prose even while a page is loading', () => {
    show({ raw: true, loading: true });

    expect(screen.getByLabelText('Source of resources/guides/desktop.md')).toBeTruthy();
  });
});

describe('what a page says about itself', () => {
  it('shows the fields it declares', () => {
    show({ source: '---\ntitle: Desktop app\ntags:\n  - copilot\n---\n\nProse.' });

    expect(screen.getByText('title')).toBeTruthy();
    expect(screen.getByText('Desktop app')).toBeTruthy();
  });

  it('draws no list at all for a page that declares nothing', () => {
    show({ source: 'Just prose.' });

    expect(document.querySelector('.wiki-meta')).toBeNull();
  });

  /** The frontmatter is in the text being edited, so it is not repeated above it. */
  it('leaves them out of the source view', () => {
    show({ source: '---\ntitle: Desktop app\n---\n\nProse.', raw: true });

    expect(document.querySelector('.wiki-meta')).toBeNull();
  });

  it('keeps the frontmatter out of the prose', () => {
    show({ source: '---\ntitle: Desktop app\n---\n\nThe body.' });

    expect(screen.getByText('The body.')).toBeTruthy();
    expect(screen.queryByText(/^---$/)).toBeNull();
  });
});

/**
 * This wiki is written almost entirely in `[[wikilinks]]`, which the renderer has never
 * heard of. Left alone they show as punctuation rather than as links.
 */
describe('links between pages', () => {
  it('draws a wikilink as a link rather than as brackets', () => {
    show({ source: 'See [[areas/copilot]] for that.' });

    expect(screen.getByRole('link', { name: 'areas/copilot' })).toBeTruthy();
  });

  it('opens the page a wikilink names', async () => {
    const onOpen = vi.fn();
    show({ source: 'See [[areas/copilot]] for that.', onOpen });

    await userEvent.click(screen.getByRole('link', { name: 'areas/copilot' }));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith('areas/copilot.md');
  });

  it('leaves a link to the web alone', async () => {
    const onOpen = vi.fn();
    show({ source: 'See [the docs](https://example.com) for that.', onOpen });

    await userEvent.click(screen.getByRole('link', { name: 'the docs' }));

    expect(onOpen).not.toHaveBeenCalled();
  });

  /**
   * A link to a heading scrolls rather than reopening the page the reader is already on,
   * which would lose their place. The renderer is what enforces this, but the guarantee is
   * about the page as drawn, so it is pinned where a page is drawn.
   */
  it('does not reopen the page for a link to a heading within it', async () => {
    const onOpen = vi.fn();
    show({ source: '## Somewhere\n\nSee [below](#somewhere) for that.', onOpen });

    await userEvent.click(screen.getByRole('link', { name: 'below' }));

    expect(onOpen).not.toHaveBeenCalled();
  });

  /**
   * A link to a page that is not there stays as it was written: a dead link looks like
   * something to press, where the brackets say plainly that the page is missing.
   */
  it('leaves a wikilink pointing at no page as it was written', () => {
    show({ source: 'See [[nothing/here]] for that.' });

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/\[\[nothing\/here\]\]/)).toBeTruthy();
  });

  it('leaves wikilinks as they are when the page list is not known yet', () => {
    show({ pages: null, source: 'See [[areas/copilot]] for that.' });

    expect(screen.queryByRole('link')).toBeNull();
  });
});

/**
 * Rendering the draft rather than the file is most of the reason to have both views:
 * previewing what has been written before committing it.
 */
describe('a page with unsaved edits', () => {
  it('renders what was written rather than what is on disk', () => {
    show({ source: '# Something else entirely' });

    expect(screen.getByRole('heading', { name: 'Something else entirely' })).toBeTruthy();
  });

  it('shows the same text in the source view', () => {
    show({ source: '# Something else entirely', raw: true });

    expect((screen.getByLabelText('Source of resources/guides/desktop.md') as HTMLTextAreaElement).value).toBe(
      '# Something else entirely',
    );
  });
});
