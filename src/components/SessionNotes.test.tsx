// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

import { SessionNotes } from './SessionNotes';
import type { WikiPage, WikiPageContent } from '../../shared/protocol';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

const page = (over: Partial<WikiPage> = {}): WikiPage => ({
  path: 'resources/guides/desktop.md',
  title: 'Desktop app',
  ...over,
});

const content = (over: Partial<WikiPageContent> = {}): WikiPageContent => ({
  path: 'resources/guides/desktop.md',
  source: '# Desktop app\n\nHow it is built.',
  ...over,
}) as WikiPageContent;

const NOTES = [page(), page({ path: 'areas/copilot.md', title: 'Copilot CLI' })];

const show = (over: Partial<Parameters<typeof SessionNotes>[0]> = {}) => {
  const props = {
    notes: NOTES,
    pages: NOTES,
    page: content(),
    loading: false,
    failed: null,
    saving: false,
    draft: undefined,
    onOpen: vi.fn(),
    onEdit: vi.fn(),
    onRevert: vi.fn(),
    onSave: vi.fn(),
    onBrowse: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<SessionNotes {...props} />);
  return props;
};

/**
 * A note beside the session it is about (#35).
 *
 * The whole point is that the transcript stays on screen, so this draws one page rather
 * than the browser's tree-beside-a-page.
 */
describe('a note beside a session', () => {
  it('draws the page it was given', () => {
    show();

    expect(screen.getByRole('heading', { name: 'Desktop app' })).toBeTruthy();
  });

  it('says what it is, since the column has no other heading', () => {
    show();

    expect(screen.getByLabelText('Notes on this session')).toBeTruthy();
  });

  it('closes when asked', async () => {
    const props = show();

    await userEvent.click(screen.getByLabelText('Close the notes'));

    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('offers the whole browser for anything it is too narrow for', async () => {
    const props = show();

    await userEvent.click(screen.getByRole('button', { name: 'Browse' }));

    expect(props.onBrowse).toHaveBeenCalledOnce();
  });

  it('says what went wrong rather than drawing nothing', () => {
    show({ failed: 'Could not read it', page: null });

    expect(screen.getByText('Could not read it')).toBeTruthy();
  });

  it('says it is reading rather than looking empty', () => {
    show({ page: null, loading: true });

    expect(screen.getByText('Reading…')).toBeTruthy();
  });
});

describe('choosing which note to read', () => {
  it('lists the session notes when there is a choice', () => {
    show();

    const picker = screen.getByRole('navigation', { name: 'Which note to read' });
    expect([...picker.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Desktop app', 'Copilot CLI']);
  });

  /** A list of one says nothing the page's own heading does not. */
  it('offers no list for a session with one note', () => {
    show({ notes: [page()] });

    expect(screen.queryByRole('navigation', { name: 'Which note to read' })).toBeNull();
  });

  it('opens the one that was pressed', async () => {
    const props = show();

    await userEvent.click(screen.getByRole('button', { name: 'Copilot CLI' }));

    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith('areas/copilot.md');
  });

  it('marks the one being read', () => {
    show();

    expect(screen.getByRole('button', { name: 'Desktop app' }).className).toContain('on');
    expect(screen.getByRole('button', { name: 'Copilot CLI' }).className).not.toContain('on');
  });

  /**
   * A wikilink followed out of a note lands anywhere in the wiki. The picker should then
   * claim none of them rather than the one it started from.
   */
  it('marks none of them once the reader has followed a link elsewhere', () => {
    show({ page: content({ path: 'archives/something-else.md' }) });

    expect(screen.getByRole('button', { name: 'Desktop app' }).className).not.toContain('on');
  });
});

describe('editing a note where it is read', () => {
  it('shows the file when asked for it', async () => {
    show();

    await userEvent.click(screen.getByRole('button', { name: 'Raw' }));

    expect(screen.getByLabelText('Source of resources/guides/desktop.md')).toBeTruthy();
  });

  it('says what pressing it again would do', async () => {
    show();

    await userEvent.click(screen.getByRole('button', { name: 'Raw' }));

    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
  });

  it('hands over what was typed, for the page it is reading', async () => {
    const onEdit = vi.fn();
    show({ onEdit });
    await userEvent.click(screen.getByRole('button', { name: 'Raw' }));

    await userEvent.type(screen.getByLabelText('Source of resources/guides/desktop.md'), '!');

    expect(onEdit).toHaveBeenCalled();
    expect(onEdit.mock.lastCall?.[0]).toBe('resources/guides/desktop.md');
  });

  /** Reading three pages as source after fixing one line is not what was asked for. */
  it('goes back to the page when another note is opened', async () => {
    const { rerender } = render(
      <SessionNotes
        notes={NOTES}
        pages={NOTES}
        page={content()}
        loading={false}
        failed={null}
        saving={false}
        draft={undefined}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onRevert={vi.fn()}
        onSave={vi.fn()}
        onBrowse={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Raw' }));

    rerender(
      <SessionNotes
        notes={NOTES}
        pages={NOTES}
        page={content({ path: 'areas/copilot.md' })}
        loading={false}
        failed={null}
        saving={false}
        draft={undefined}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onRevert={vi.fn()}
        onSave={vi.fn()}
        onBrowse={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Raw' })).toBeTruthy();
  });

  it('offers nothing to save until something has been written', () => {
    show();

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('offers to save and to discard once something has', () => {
    show({ draft: '# Changed' });

    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
  });

  it('writes the page being read', async () => {
    const props = show({ draft: '# Changed' });

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(props.onSave).toHaveBeenCalledExactlyOnceWith('resources/guides/desktop.md');
  });

  it('gives up the edits when asked', async () => {
    const props = show({ draft: '# Changed' });

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(props.onRevert).toHaveBeenCalledExactlyOnceWith('resources/guides/desktop.md');
  });

  it('refuses both while a write is in flight', () => {
    show({ draft: '# Changed', saving: true });

    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(true);
  });

  /** The draft rather than the file, so previewing an edit shows the edit. */
  it('renders what was written rather than what is on disk', () => {
    show({ draft: '# A different heading' });

    expect(screen.getByRole('heading', { name: 'A different heading' })).toBeTruthy();
  });
});

describe('saving from the keyboard', () => {
  const press = () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));

  it('writes the page being read', () => {
    const props = show({ draft: '# Changed' });

    press();

    expect(props.onSave).toHaveBeenCalledExactlyOnceWith('resources/guides/desktop.md');
  });

  it('does nothing where there is nothing to write', () => {
    const props = show();

    press();

    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('stops listening once the column is gone', () => {
    const onSave = vi.fn();
    const { unmount } = render(
      <SessionNotes
        notes={NOTES}
        pages={NOTES}
        page={content()}
        loading={false}
        failed={null}
        saving={false}
        draft="# Changed"
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onRevert={vi.fn()}
        onSave={onSave}
        onBrowse={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    unmount();
    press();

    expect(onSave).not.toHaveBeenCalled();
  });
});
