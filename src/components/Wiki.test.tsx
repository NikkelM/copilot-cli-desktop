// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Wiki, asTree, readFrontmatter } from './Wiki';
import type { WikiPage, WikiPageContent } from '../../shared/protocol';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const pages: WikiPage[] = [
  { path: 'index.md', title: 'Index' },
  { path: 'Home.md', title: 'Knowledge Base Home' },
  { path: 'projects/README.md', title: 'Projects' },
  { path: 'projects/app/overview.md', title: 'App overview', summary: 'what it is' },
  { path: 'resources/guides/rtk.md', title: 'RTK Install' },
];

const shown = (page: WikiPageContent | null, over: Partial<Parameters<typeof Wiki>[0]> = {}) =>
  render(
    <Wiki
      pages={pages}
      page={page}
      loading={false}
      failed={null}
      onOpen={() => {}}
      onBack={() => {}}
      onForward={() => {}}
      canGoBack={false}
      canGoForward={false}
      trail={page ? [page.path] : []}
      onClose={() => {}}
      {...over}
    />,
  );

describe('arranging the pages as the directories hold them', () => {
  it('keeps root pages at the root', () => {
    const tree = asTree(pages);

    expect(tree.pages.map((page) => page.path)).toEqual(['index.md', 'Home.md']);
  });

  it('puts a page under the directory that holds it', () => {
    const tree = asTree(pages);
    const projects = tree.folders.find((folder) => folder.name === 'projects');

    expect(projects?.pages.map((page) => page.title)).toEqual(['Projects']);
  });

  it('nests as deep as the paths go', () => {
    const tree = asTree(pages);
    const guides = tree.folders.find((f) => f.name === 'resources')?.folders.find((f) => f.name === 'guides');

    expect(guides?.path).toBe('resources/guides');
    expect(guides?.pages.map((page) => page.title)).toEqual(['RTK Install']);
  });

  it('makes one folder however many pages are in it', () => {
    const tree = asTree([...pages, { path: 'projects/second.md', title: 'Second' }]);

    expect(tree.folders.filter((folder) => folder.name === 'projects')).toHaveLength(1);
  });
});

describe('reading what a page declares about itself', () => {
  it('reads a plain field', () => {
    expect(readFrontmatter('title: A page')).toEqual([{ key: 'title', value: 'A page' }]);
  });

  it('gathers a list into the field it belongs to', () => {
    const fields = readFrontmatter('tags:\n  - copilot\n  - cli');

    expect(fields).toEqual([{ key: 'tags', value: 'copilot, cli' }]);
  });

  it('drops the quotes a value was written with', () => {
    expect(readFrontmatter('summary: "what it is about"')[0]?.value).toBe('what it is about');
  });

  /** A field with nothing after it says nothing, and an empty row is worse than no row. */
  it('leaves out a field with no value', () => {
    expect(readFrontmatter('title: A page\nsource:')).toEqual([{ key: 'title', value: 'A page' }]);
  });

  it('reads the fields a real page carries', () => {
    const fields = readFrontmatter(
      ['title: RTK Install', 'category: guide', 'tags:', '  - copilot', '  - tools', 'updated: 2026-06-24'].join('\n'),
    );

    expect(fields.map((field) => field.key)).toEqual(['title', 'category', 'tags', 'updated']);
  });
});

describe('browsing the wiki', () => {
  it('shows the page it was given', () => {
    shown({ path: 'index.md', body: '# The index\n\nsome prose' });

    expect(screen.getByText('The index')).toBeTruthy();
    expect(screen.getByText('some prose')).toBeTruthy();
  });

  it('shows what the page declares above what it says', () => {
    shown({ path: 'index.md', frontmatter: 'title: Index\ncategory: architecture', body: 'prose' });

    expect(screen.getByText('category')).toBeTruthy();
    expect(screen.getByText('architecture')).toBeTruthy();
  });

  /** Frontmatter rendered as body text puts a block of `title:` above every page. */
  it('does not render the frontmatter as prose', () => {
    const view = shown({ path: 'index.md', frontmatter: 'title: Index', body: 'prose' });

    expect(view.container.querySelector('.markdown')?.textContent).toBe('prose');
  });

  it('opens a page chosen from the tree', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'index.md', body: 'prose' }, { onOpen });

    // The folder's own row carries a count beside its name, so it is matched by name.
    await user.click(screen.getByRole('button', { name: /^projects/ }));
    await user.click(screen.getByRole('button', { name: 'Projects' }));

    expect(onOpen).toHaveBeenCalledWith('projects/README.md');
  });

  /**
   * A wikilink is what this wiki is written in, and the renderer has never heard of the
   * brackets: unrewritten they would show as punctuation instead of as a way through.
   */
  it('follows a wikilink to another page', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'index.md', body: 'see [[projects/README|Projects]] for more' }, { onOpen });

    await user.click(screen.getByRole('link', { name: 'Projects' }));

    expect(onOpen).toHaveBeenCalledWith('projects/README.md');
  });

  it('follows an ordinary relative link too', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'projects/README.md', body: 'see [the app](app/overview.md)' }, { onOpen });

    await user.click(screen.getByRole('link', { name: 'the app' }));

    expect(onOpen).toHaveBeenCalledWith('projects/app/overview.md');
  });

  // A link to nothing is left as the text it was written as rather than drawn as a way out.
  it('leaves a link to a page that is not there as text', () => {
    shown({ path: 'index.md', body: 'see [[never-written]] for more' });

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/never-written/)).toBeTruthy();
  });

  it('opens the directory holding the page being read', () => {
    shown({ path: 'resources/guides/rtk.md', body: 'prose' });

    expect(screen.getByRole('button', { name: 'RTK Install' })).toBeTruthy();
  });

  it('says so when there is no wiki at all', () => {
    shown(null, { pages: [] });

    expect(screen.getByText('No wiki on this machine.')).toBeTruthy();
  });

  it('reports a page it could not read', () => {
    shown(null, { failed: 'No page at gone.md' });

    expect(screen.getByText('No page at gone.md')).toBeTruthy();
  });

  it('goes back to the sessions', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'index.md', body: 'prose' }, { onClose });

    await user.click(screen.getByRole('button', { name: 'Sessions' }));

    expect(onClose).toHaveBeenCalled();
  });

  /**
   * Two buttons both saying back would each be explaining the other, so the one that leaves
   * the wiki is named for where it goes.
   */
  it('names the way out for where it goes', () => {
    shown({ path: 'index.md', body: 'prose' });

    expect(screen.getByRole('button', { name: 'Sessions' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '←' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '→' })).toBeTruthy();
  });

  // Disabled rather than absent, so the header does not move as the reader navigates.
  it('offers a way back only once there is somewhere to go', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'index.md', body: 'prose' }, { onBack });
    expect(screen.getByRole('button', { name: '←' })).toHaveProperty('disabled', true);

    shown({ path: 'projects/README.md', body: 'prose' }, { onBack, canGoBack: true });
    await user.click(screen.getAllByRole('button', { name: '←' })[1]!);

    expect(onBack).toHaveBeenCalled();
  });

  it('offers a way forward only once something is ahead', async () => {
    const onForward = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'index.md', body: 'prose' }, { onForward });
    expect(screen.getByRole('button', { name: '→' })).toHaveProperty('disabled', true);

    shown({ path: 'index.md', body: 'prose' }, { onForward, canGoForward: true });
    await user.click(screen.getAllByRole('button', { name: '→' })[1]!);

    expect(onForward).toHaveBeenCalled();
  });
});

/**
 * The gestures that already mean back, so retracing is not a trip to the header.
 */
describe('going back without the button', () => {
  it('goes back on alt and the left arrow', () => {
    const onBack = vi.fn();
    shown({ path: 'projects/README.md', body: 'prose' }, { onBack, canGoBack: true });

    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });

    expect(onBack).toHaveBeenCalled();
  });

  it('goes back on the mouse back button', () => {
    const onBack = vi.fn();
    shown({ path: 'projects/README.md', body: 'prose' }, { onBack, canGoBack: true });

    fireEvent.mouseUp(window, { button: 3 });

    expect(onBack).toHaveBeenCalled();
  });

  /** Left alone the webview follows it and leaves the app, which there is no way back from. */
  it('claims the mouse back button so the webview cannot navigate', () => {
    shown({ path: 'projects/README.md', body: 'prose' }, { canGoBack: true });

    const claimed = !fireEvent.mouseDown(window, { button: 3, cancelable: true });

    expect(claimed).toBe(true);
  });

  it('does nothing when there is nowhere to go back to', () => {
    const onBack = vi.fn();
    shown({ path: 'index.md', body: 'prose' }, { onBack, canGoBack: false });

    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    fireEvent.mouseUp(window, { button: 3 });

    expect(onBack).not.toHaveBeenCalled();
  });

  it('leaves an ordinary left arrow alone', () => {
    const onBack = vi.fn();
    shown({ path: 'projects/README.md', body: 'prose' }, { onBack, canGoBack: true });

    fireEvent.keyDown(window, { key: 'ArrowLeft' });

    expect(onBack).not.toHaveBeenCalled();
  });

  it('goes forward on alt and the right arrow', () => {
    const onForward = vi.fn();
    shown({ path: 'index.md', body: 'prose' }, { onForward, canGoForward: true });

    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });

    expect(onForward).toHaveBeenCalled();
  });

  it('goes forward on the mouse forward button', () => {
    const onForward = vi.fn();
    shown({ path: 'index.md', body: 'prose' }, { onForward, canGoForward: true });

    fireEvent.mouseUp(window, { button: 4 });

    expect(onForward).toHaveBeenCalled();
  });

  /** Left alone the webview follows either thumb button and leaves the app. */
  it('claims both thumb buttons so the webview cannot navigate', () => {
    shown({ path: 'projects/README.md', body: 'prose' }, { canGoBack: true, canGoForward: true });

    expect(!fireEvent.mouseDown(window, { button: 3, cancelable: true })).toBe(true);
    expect(!fireEvent.mouseDown(window, { button: 4, cancelable: true })).toBe(true);
  });

  it('does nothing when there is nothing ahead', () => {
    const onForward = vi.fn();
    shown({ path: 'index.md', body: 'prose' }, { onForward, canGoForward: false });

    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    fireEvent.mouseUp(window, { button: 4 });

    expect(onForward).not.toHaveBeenCalled();
  });

  // The listeners are the window's, so they must not outlive the view that set them up.
  it('stops listening once the wiki is closed', () => {
    const onBack = vi.fn();
    const view = shown({ path: 'projects/README.md', body: 'prose' }, { onBack, canGoBack: true });

    view.unmount();
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });

    expect(onBack).not.toHaveBeenCalled();
  });
});

/**
 * How the reader got here. The path was shown first and answered the wrong question: at the
 * root of the wiki a page's path is only its own filename, and it could not show that the
 * page was reached from the index.
 */
describe('the trail showing how a reader got here', () => {
  const crumbs = () => within(screen.getByLabelText('How you got here'));

  it('shows the pages that were walked through', () => {
    shown({ path: 'projects/README.md', body: 'prose' }, { trail: ['index.md', 'Home.md', 'projects/README.md'] });

    expect(crumbs().getByRole('button', { name: 'Index' })).toBeTruthy();
    expect(crumbs().getByRole('button', { name: 'Knowledge Base Home' })).toBeTruthy();
  });

  it('names a page by its title rather than its path', () => {
    shown({ path: 'projects/README.md', body: 'prose' }, { trail: ['index.md', 'projects/README.md'] });

    expect(crumbs().getByText('Projects')).toBeTruthy();
  });

  it('goes back to a page chosen from the trail', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'projects/README.md', body: 'prose' }, { onOpen, trail: ['index.md', 'projects/README.md'] });

    await user.click(crumbs().getByRole('button', { name: 'Index' }));

    expect(onOpen).toHaveBeenCalledWith('index.md');
  });

  /** Where the reader already is, so it says so rather than offering to go there. */
  it('does not offer to open the page already open', () => {
    shown({ path: 'projects/README.md', body: 'prose' }, { trail: ['index.md', 'projects/README.md'] });

    expect(crumbs().queryByRole('button', { name: 'Projects' })).toBeNull();
  });

  // A root page has no path to speak of, which is what made showing one useless.
  it('shows a single page on its own', () => {
    shown({ path: 'Home.md', body: 'prose' }, { trail: ['Home.md'] });

    expect(crumbs().getByText('Knowledge Base Home')).toBeTruthy();
  });

  /** A trail without a limit would push the buttons beside it off the header. */
  it('clips a long walk from the left, keeping the pages just before this one', () => {
    const long = ['Home.md', 'index.md', 'projects/README.md', 'projects/app/overview.md', 'Home.md', 'index.md'];
    shown({ path: 'index.md', body: 'prose' }, { trail: [...long, 'projects/README.md'] });

    expect(crumbs().getByText('…')).toBeTruthy();
    expect(crumbs().queryByRole('button', { name: 'Knowledge Base Home' })).toBeTruthy();
  });
});
