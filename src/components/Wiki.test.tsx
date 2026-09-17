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

/**
 * A page as the sidecar hands it over: the file, whole.
 *
 * Tests say what a page contains in the terms they care about - some frontmatter, some
 * prose - and this composes the file they would make. Given a `source` outright it uses
 * that instead, for the cases that are about exact spacing.
 */
const asPage = (page: PageFixture | null): WikiPageContent | null => {
  if (page === null) return null;
  if (page.source !== undefined) return { path: page.path, source: page.source };

  const front = page.frontmatter ? `---\n${page.frontmatter}\n---\n\n` : '';
  return { path: page.path, source: `${front}${page.body ?? ''}` };
};

interface PageFixture {
  path: string;
  frontmatter?: string;
  body?: string;
  source?: string;
}

const shown = (page: PageFixture | null, over: Partial<Parameters<typeof Wiki>[0]> = {}) =>
  render(
    <Wiki
      pages={pages}
      where={{ root: '/home/someone/.copilot/wiki', exists: true }}
      page={asPage(page)}
      loading={false}
      failed={null}
      saving={false}
      draft={undefined}
      unsaved={[]}
      onEdit={() => {}}
      onRevert={() => {}}
      onSave={() => {}}
      onCreate={() => {}}
      query=""
      onQuery={() => {}}
      results={null}
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

  it('reports a page it could not read', () => {
    shown(null, { failed: 'No page at gone.md' });

    expect(screen.getByText('No page at gone.md')).toBeTruthy();
  });

  it('goes back to the session', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'index.md', body: 'prose' }, { onClose });

    await user.click(screen.getByRole('button', { name: 'Back to session' }));

    expect(onClose).toHaveBeenCalled();
  });

  /**
   * The way out is named for where it goes, and the two ways through the wiki are arrows -
   * so the only word saying "back" belongs to exactly one of them.
   */
  it('names the way out and draws the ways through', () => {
    shown({ path: 'index.md', body: 'prose' });

    expect(screen.getByRole('button', { name: 'Back to session' })).toBeTruthy();
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


/**
 * The browser has to explain itself to someone meeting it for the first time. Left as an
 * empty tree beside an empty page it is a feature that appears broken, and the idea it
 * rests on - a folder of markdown the app reads - is not one it can assume anyone knows.
 */
describe('meeting the wiki for the first time', () => {
  const nothing = (exists: boolean) =>
    shown(null, { pages: [], where: { root: '/home/someone/.copilot/wiki', exists } });

  it('explains what a knowledge base is when there is none', () => {
    nothing(false);

    expect(screen.getByText('No knowledge base yet')).toBeTruthy();
  });

  it('names the folder to make, so the reader knows where it goes', () => {
    nothing(false);

    expect(screen.getAllByText('/home/someone/.copilot/wiki').length).toBeGreaterThan(0);
  });

  /** Different sentences: one needs the folder made, the other a page put in it. */
  it('tells an empty wiki apart from a missing one', () => {
    nothing(true);

    expect(screen.getByText('No pages here yet')).toBeTruthy();
    expect(screen.queryByText('No knowledge base yet')).toBeNull();
  });

  /** The page it writes says how a page is put together, so this does not say it too. */
  it('leaves the conventions to the page it creates', () => {
    const view = nothing(false);

    expect(view.container.querySelector('.wiki-onboarding ul')).toBeNull();
    expect(screen.queryByText(/wikilinks/)).toBeNull();
  });

  // An empty tree beside it would be the thing that reads as broken.
  it('gives the tree space to the explanation', () => {
    const view = nothing(false);

    expect(view.container.querySelector('.wiki-onboarding')).toBeTruthy();
    expect(view.container.querySelector('.wiki-nav')).toBeNull();
  });

  it('does not explain itself to a wiki that has pages', () => {
    const view = shown({ path: 'index.md', body: 'prose' });

    expect(view.container.querySelector('.wiki-onboarding')).toBeNull();
    expect(view.container.querySelector('.wiki-nav')).toBeTruthy();
  });

  /** Credit for writing pages belonged to one machine's scripts, which nobody else has. */
  it('says where it reads from without naming anyone tools', () => {
    const view = nothing(true);

    expect(view.container.querySelector('.changes-note')?.textContent).toContain(
      '/home/someone/.copilot/wiki',
    );
    expect(view.container.querySelector('.changes-note')?.textContent).not.toContain('scripts');
  });
});

/**
 * Editing, which is what the raw toggle is for: a typo noticed while reading should be
 * fixable where it was noticed rather than in another window.
 */
describe('showing a page as the file it is', () => {
  const file = {
    path: 'index.md',
    frontmatter: 'title: Index',
    body: '# The index',
    source: '---\ntitle: Index\n---\n\n# The index',
  };

  const editor = () => screen.queryByRole('textbox');

  it('renders the page until the toggle is pressed', () => {
    shown(file);

    expect(screen.getByText('The index')).toBeTruthy();
    expect(editor()).toBeNull();
  });

  it('shows the whole file, frontmatter and all', async () => {
    const user = userEvent.setup();
    shown(file);

    await user.click(screen.getByRole('button', { name: 'Raw' }));

    expect((editor() as HTMLTextAreaElement).value).toBe(file.source);
  });

  /** Reconstructing it would rewrite spacing the app was never asked to touch. */
  it('shows the file rather than a rebuild of its parts', async () => {
    const user = userEvent.setup();
    shown({ ...file, source: '---\ntitle: Index\n---\n\n\n\n# The index\n\n\n' });

    await user.click(screen.getByRole('button', { name: 'Raw' }));

    expect((editor() as HTMLTextAreaElement).value).toBe('---\ntitle: Index\n---\n\n\n\n# The index\n\n\n');
  });

  it('hands every edit up as it is typed', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    shown(file, { onEdit });

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    await user.type(editor()!, '!');

    expect(onEdit).toHaveBeenCalledWith('index.md', `${file.source}!`);
  });

  it('shows what is being edited rather than what is on disk', async () => {
    const user = userEvent.setup();
    shown(file, { draft: 'edited elsewhere' });

    await user.click(screen.getByRole('button', { name: 'Raw' }));

    expect((editor() as HTMLTextAreaElement).value).toBe('edited elsewhere');
  });

  /** Unsaved work put out of sight is unsaved work about to be lost - but previewing it is
   * most of the reason to have both views, so the toggle keeps working while dirty. */
  it('previews what is being written without saving it first', async () => {
    const user = userEvent.setup();
    shown(file, { draft: '---\ntitle: Index\n---\n\n# Rewritten' });

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(screen.getByText('Rewritten')).toBeTruthy();
    expect(editor()).toBeNull();
  });

  /** A page must not render differently depending on whether it has been saved yet. */
  it('reads the draft frontmatter as frontmatter rather than as prose', () => {
    const view = shown(file, { draft: '---\ntitle: Edited\ncategory: notes\n---\n\nthe prose' });

    expect(screen.getByText('category')).toBeTruthy();
    expect(screen.getByText('notes')).toBeTruthy();
    expect(view.container.querySelector('.markdown')?.textContent).toBe('the prose');
  });

  it('says which view it would switch to', async () => {
    const user = userEvent.setup();
    shown(file);
    expect(screen.getByRole('button', { name: 'Raw' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Raw' }));

    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Raw' })).toBeNull();
  });

  it('goes back to reading when the toggle is pressed again', async () => {
    const user = userEvent.setup();
    shown(file);

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(editor()).toBeNull();
    expect(screen.getByText('The index')).toBeTruthy();
  });

  // Turning it on for one page and reading three more as source is not what was asked for.
  it('goes back to reading when another page is opened', () => {
    const view = shown(file);

    view.rerender(
      <Wiki
        pages={pages}
        where={{ root: '/w', exists: true }}
        page={{ path: 'Home.md', source: 'prose' }}
        loading={false}
        failed={null}
        saving={false}
        draft={undefined}
        unsaved={[]}
        onEdit={() => {}}
        onRevert={() => {}}
        onSave={() => {}}
      onCreate={() => {}}
      query=""
      onQuery={() => {}}
      results={null}
        onOpen={() => {}}
        onBack={() => {}}
        onForward={() => {}}
        canGoBack={false}
        canGoForward={false}
        trail={['Home.md']}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('writing a page back', () => {
  const file = { path: 'index.md', body: '# The index', source: '# The index' };

  it('offers nothing to save until something is edited', () => {
    shown(file);

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('saves what is being edited', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    shown(file, { draft: 'edited', onSave });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith('index.md');
  });

  /** The key every editor answers to, and previewing an edit is part of writing it - so it
   * must not stop meaning save the moment the text goes out of sight. */
  it('saves on ctrl and s from the editor', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    shown(file, { draft: 'edited', onSave });

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Control>}s{/Control}');

    expect(onSave).toHaveBeenCalledWith('index.md');
  });

  it('saves on ctrl and s from the preview', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    shown(file, { draft: 'edited', onSave });

    expect(screen.queryByRole('textbox')).toBeNull();
    await user.keyboard('{Control>}s{/Control}');

    expect(onSave).toHaveBeenCalledWith('index.md');
  });

  it('saves nothing when there is nothing to save', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    shown(file, { onSave });

    await user.keyboard('{Control>}s{/Control}');

    expect(onSave).not.toHaveBeenCalled();
  });

  it('gives up the edits when they are discarded', async () => {
    const onRevert = vi.fn();
    const user = userEvent.setup();
    shown(file, { draft: 'edited', onRevert });

    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onRevert).toHaveBeenCalledWith('index.md');
  });

  /** Two buttons offering to save or discard are what having something unsaved looks like. */
  it('offers to save and discard once something is edited', () => {
    shown(file, { draft: 'edited' });

    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
  });

  it('says so while it is being written', () => {
    shown(file, { draft: 'edited', saving: true });

    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
  });

  /** A page can be left with edits, so the tree says which are waiting rather than losing them. */
  it('marks a page left behind with edits on it', () => {
    // A page at the root, so it is drawn without a folder needing to be opened first.
    shown(file, { unsaved: ['Home.md'] });

    const marked = screen.getByRole('button', { name: /Knowledge Base Home/ });
    expect(marked.querySelector('.wiki-dirty-mark')).toBeTruthy();
  });

  it('reports a page it could not write', () => {
    shown(file, { draft: 'edited', failed: 'Could not write index.md. It may be read-only.' });

    expect(screen.getByText(/Could not write index.md/)).toBeTruthy();
  });
});


/**
 * The onboarding used to name a folder and leave the reader to make it by hand, which is a
 * strange thing to be told by an app that could make it.
 */
describe('starting a knowledge base from the onboarding', () => {
  const nothing = (exists: boolean, over: Partial<Parameters<typeof Wiki>[0]> = {}) =>
    shown(null, { pages: [], where: { root: '/home/someone/.copilot/wiki', exists }, ...over });

  it('offers to create it rather than describing how', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    nothing(false, { onCreate });

    await user.click(screen.getByRole('button', { name: 'Create it' }));

    expect(onCreate).toHaveBeenCalled();
  });

  /** The folder is already there, so what is missing is a page rather than the base. */
  it('offers a first page when the folder is there but empty', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    nothing(true, { onCreate });

    await user.click(screen.getByRole('button', { name: 'Write a first page' }));

    expect(onCreate).toHaveBeenCalled();
  });

  it('still says where it will go', () => {
    nothing(false);

    expect(screen.getAllByText('/home/someone/.copilot/wiki').length).toBeGreaterThan(0);
  });

  it('says so while it is being made', () => {
    nothing(false, { saving: true });

    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveProperty('disabled', true);
  });

  it('reports a base it could not create', () => {
    nothing(false, { failed: 'Could not create the knowledge base. The folder may not be writable.' });

    expect(screen.getByText(/Could not create the knowledge base/)).toBeTruthy();
  });

  /** Somewhere already synced or already open in an editor beats a second copy here. */
  it('says the folder can be somewhere else', () => {
    nothing(false);

    expect(screen.getByText('COPILOT_WIKI_DIR')).toBeTruthy();
  });
});



/**
 * Search, which replaces the tree rather than sitting beside it: both answer the same
 * question - which page do I want - and two lists of pages at once is two things to look at.
 */
describe('searching the wiki', () => {
  const found = [
    {
      path: 'projects/app/overview.md',
      title: 'App overview',
      score: 26,
      matchedIn: ['keywords', 'content'],
      excerpt: '…the sentence the term appeared in…',
    },
    { path: 'Home.md', title: 'Knowledge Base Home', score: 4, matchedIn: ['content'] },
  ];

  it('shows the tree until something is asked', () => {
    const view = shown({ path: 'index.md', body: 'prose' });

    expect(view.container.querySelector('.wiki-tree')).toBeTruthy();
    expect(view.container.querySelector('.wiki-results')).toBeNull();
  });

  it('hands every keystroke up', async () => {
    const onQuery = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'index.md', body: 'prose' }, { onQuery });

    await user.type(screen.getByLabelText('Search the wiki'), 'h');

    expect(onQuery).toHaveBeenCalledWith('h');
  });

  it('puts the results where the tree was', () => {
    const view = shown({ path: 'index.md', body: 'prose' }, { query: 'hades', results: found });

    expect(view.container.querySelector('.wiki-results')).toBeTruthy();
    expect(view.container.querySelector('.wiki-tree')).toBeNull();
  });

  it('names each page it found', () => {
    shown({ path: 'index.md', body: 'prose' }, { query: 'hades', results: found });

    expect(screen.getByText('App overview')).toBeTruthy();
    expect(screen.getByText('Knowledge Base Home')).toBeTruthy();
  });

  /** What separates a page about the term from one that merely mentions it. */
  it('says where each page matched', () => {
    shown({ path: 'index.md', body: 'prose' }, { query: 'hades', results: found });

    expect(screen.getByText('keywords · content')).toBeTruthy();
  });

  it('shows the prose around the match', () => {
    shown({ path: 'index.md', body: 'prose' }, { query: 'hades', results: found });

    expect(screen.getByText(/the sentence the term appeared in/)).toBeTruthy();
  });

  it('opens a page chosen from the results', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    shown({ path: 'index.md', body: 'prose' }, { query: 'hades', results: found, onOpen });

    await user.click(screen.getByText('App overview'));

    expect(onOpen).toHaveBeenCalledWith('projects/app/overview.md');
  });

  // An empty list is an answer, and saying so beats showing nothing at all.
  it('says so when nothing matches', () => {
    shown({ path: 'index.md', body: 'prose' }, { query: 'nothing', results: [] });

    expect(screen.getByText('Nothing matches that.')).toBeTruthy();
  });

  it('gives the tree back when the search is cleared', () => {
    const view = shown({ path: 'index.md', body: 'prose' }, { query: '', results: null });

    expect(view.container.querySelector('.wiki-tree')).toBeTruthy();
  });
});
