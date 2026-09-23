// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Repository } from './Repository';
import type { RepoStatus } from '../../shared/protocol';

const clean: RepoStatus = { branch: 'main', detached: false, ahead: 0, behind: 0, files: [] };

const shown = (status: RepoStatus | null, over: Partial<Parameters<typeof Repository>[0]> = {}) =>
  render(
    <Repository
      status={status}
      loading={false}
      cwd={'C:\\repo'}
      diffs={{}}
      onDiff={() => {}}
      busy={[]}
      onStage={() => {}}
      onCommit={() => {}}
      committing={false}
      onSync={() => {}}
      syncing={null}
      diverged={false}
      onDismissDiverged={() => {}}
      onRememberStrategy={() => {}}
      branches={[]}
      onBranches={() => {}}
      onSwitch={() => {}}
      switching={false}
      failed={null}
      onRefresh={() => {}}
      onClose={() => {}}
      {...over}
    />,
  );

/**
 * The row that opens a diff, told apart from the stage button beside it - both carry the
 * file's name, so asking for a button by name alone finds two.
 */
const rows = (path: string) =>
  screen
    .getAllByRole('button', { name: new RegExp(path.replace(/\./g, '\\.')) })
    .filter((button) => button.classList.contains('changes-row'));

const row = (path: string) => rows(path)[0]!;

describe('what the repository is doing', () => {
  it('names the branch', () => {
    shown(clean);

    expect(screen.getByText('main')).toBeTruthy();
  });

  it('names the branch it tracks', () => {
    shown({ ...clean, upstream: 'origin/main' });

    expect(screen.getByText(/origin\/main/)).toBeTruthy();
  });

  it('says how far ahead and behind it is', () => {
    shown({ ...clean, upstream: 'origin/main', ahead: 3, behind: 2 });

    expect(screen.getByText('↑3')).toBeTruthy();
    expect(screen.getByText('↓2')).toBeTruthy();
  });

  /** A pair of zeroes on every clean repository is punctuation, not information. */
  it('says nothing about counts when there is nothing to say', () => {
    shown({ ...clean, upstream: 'origin/main' });

    expect(screen.queryByText('↑0')).toBeNull();
    expect(screen.queryByText('↓0')).toBeNull();
  });

  it('shows the commit when there is no branch to name', () => {
    shown({ ...clean, branch: 'f42b1f39', detached: true });

    expect(screen.getByText('f42b1f39')).toBeTruthy();
  });
});

describe('the files it lists', () => {
  const changed: RepoStatus = {
    ...clean,
    files: [
      { path: 'src/kept.ts', staged: 'modified' },
      { path: 'src/new.ts', unstaged: 'untracked' },
      { path: 'gone.ts', unstaged: 'deleted' },
    ],
  };

  it('separates what is staged from what is not', () => {
    shown(changed);

    expect(screen.getByText('Staged')).toBeTruthy();
    expect(screen.getByText('Changes')).toBeTruthy();
  });

  it('names each file', () => {
    shown(changed);

    expect(screen.getByText('kept.ts')).toBeTruthy();
    expect(screen.getByText('new.ts')).toBeTruthy();
    expect(screen.getByText('gone.ts')).toBeTruthy();
  });

  /** Read by filename, with the directories after it and quieter. */
  it('puts the folder after the name it belongs to', () => {
    const view = shown(changed);

    expect(view.container.querySelector('.repo-folder')?.textContent).toBe('src/');
  });

  /** Part of the file is going into the commit and part of it is not, which is two rows. */
  it('shows a file staged and then changed again under both headings', () => {
    shown({ ...clean, files: [{ path: 'both.ts', staged: 'modified', unstaged: 'modified' }] });

    expect(screen.getAllByText('both.ts')).toHaveLength(2);
  });

  it('leaves out a heading with nothing under it', () => {
    shown({ ...clean, files: [{ path: 'only.ts', unstaged: 'modified' }] });

    expect(screen.queryByText('Staged')).toBeNull();
    expect(screen.getByText('Changes')).toBeTruthy();
  });

  it('says where a rename came from', () => {
    shown({ ...clean, files: [{ path: 'new-name.ts', staged: 'renamed', from: 'old-name.ts' }] });

    expect(screen.getByTitle('new-name.ts (was old-name.ts)')).toBeTruthy();
  });

  it('says so when nothing has changed', () => {
    shown(clean);

    expect(screen.getByText(/Nothing to commit/)).toBeTruthy();
  });

  /**
   * A clean tree is not the same as nothing to do. Unpushed commits are as often the reason
   * the panel is open as edits are, and calling that "nothing" is how a reader decides the
   * panel is not working.
   */
  it('says what is waiting to be pushed on an otherwise clean tree', () => {
    shown({ ...clean, upstream: 'origin/main', ahead: 4 });

    expect(screen.getByText(/4 commits are waiting to be pushed/)).toBeTruthy();
  });

  it('counts a single commit as one', () => {
    shown({ ...clean, upstream: 'origin/main', ahead: 1 });

    expect(screen.getByText(/1 commit is waiting to be pushed/)).toBeTruthy();
  });

  it('says what is waiting to be pulled', () => {
    shown({ ...clean, upstream: 'origin/main', behind: 2 });

    expect(screen.getByText(/2 commits are waiting to be pulled/)).toBeTruthy();
  });

  it('says nothing further when the tree is clean and level', () => {
    shown({ ...clean, upstream: 'origin/main' });

    expect(screen.queryByText(/waiting/)).toBeNull();
  });
});

/** A session in a plain folder is an ordinary session, not an error. */
describe('a session that is not in a repository', () => {
  it('says so rather than showing an empty list', () => {
    shown(null);

    expect(screen.getByText('Not a git repository.')).toBeTruthy();
  });

  it('says so when the session has no directory at all', () => {
    shown(null, { cwd: null });

    expect(screen.getByText('This session has no working directory.')).toBeTruthy();
  });

  // Nothing read yet is not the same as nothing there, and saying the wrong one is worse.
  it('does not call it a plain folder while it is still reading', () => {
    shown(null, { loading: true });

    expect(screen.getByText('Reading the repository…')).toBeTruthy();
    expect(screen.queryByText('Not a git repository.')).toBeNull();
  });
});

describe('asking again', () => {
  it('reads the repository again on request', async () => {
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    shown(clean, { onRefresh });

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(onRefresh).toHaveBeenCalled();
  });

  it('cannot be asked twice at once', () => {
    shown(clean, { loading: true });

    expect(screen.getByRole('button', { name: 'Reading…' })).toHaveProperty('disabled', true);
  });

  it('closes on request', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    shown(clean, { onClose });

    // The same cross every other panel here closes with, rather than a word of its own.
    await user.click(screen.getByRole('button', { name: 'Close source control' }));

    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * Opening a file to its diff, which works the way the changes panel works - a reader who
 * has learnt one of these panels should not have to learn the other.
 */
describe('opening a file to its diff', () => {
  const both: RepoStatus = {
    ...clean,
    files: [{ path: 'src/both.ts', staged: 'modified', unstaged: 'modified' }],
  };

  const patch = '--- a/src/both.ts\n+++ b/src/both.ts\n@@ -1 +1 @@\n-before\n+after';

  it('asks for the diff when a row is opened', async () => {
    const onDiff = vi.fn();
    const user = userEvent.setup();
    shown({ ...clean, files: [{ path: 'a.ts', unstaged: 'modified' }] }, { onDiff });

    await user.click(row('a.ts'));

    expect(onDiff).toHaveBeenCalledWith('a.ts', false);
  });

  /**
   * The same file in both lists is two different diffs - the index against HEAD, and the
   * tree against the index - so the side has to be asked for rather than guessed.
   */
  it('asks for the side the row belongs to', async () => {
    const onDiff = vi.fn();
    const user = userEvent.setup();
    shown(both, { onDiff });

    const sides = rows('both.ts');
    await user.click(sides[0]!);
    await user.click(sides[1]!);

    expect(onDiff).toHaveBeenNthCalledWith(1, 'src/both.ts', true);
    expect(onDiff).toHaveBeenNthCalledWith(2, 'src/both.ts', false);
  });

  it('draws the diff it was given', async () => {
    const user = userEvent.setup();
    const view = shown(
      { ...clean, files: [{ path: 'a.ts', unstaged: 'modified' }] },
      { diffs: { 'unstaged:a.ts': { patch, stale: false } } },
    );

    await user.click(row('a.ts'));

    expect(view.container.querySelector('.tool-diff')).toBeTruthy();
  });

  /** Opening one row of a file must not open the other, or the two diffs would be confused. */
  it('opens one side without opening the other', async () => {
    const user = userEvent.setup();
    const view = shown(both, {
      diffs: { 'staged:src/both.ts': { patch, stale: false }, 'unstaged:src/both.ts': { patch, stale: false } },
    });

    await user.click(rows('both.ts')[0]!);

    expect(view.container.querySelectorAll('.tool-diff')).toHaveLength(1);
  });

  it('closes the row when it is clicked again', async () => {
    const user = userEvent.setup();
    const view = shown(
      { ...clean, files: [{ path: 'a.ts', unstaged: 'modified' }] },
      { diffs: { 'unstaged:a.ts': { patch, stale: false } } },
    );

    const opened = row('a.ts');
    await user.click(opened);
    await user.click(opened);

    expect(view.container.querySelector('.tool-diff')).toBeNull();
  });

  it('says it is reading until the diff arrives', async () => {
    const user = userEvent.setup();
    shown({ ...clean, files: [{ path: 'a.ts', unstaged: 'modified' }] });

    await user.click(row('a.ts'));

    expect(screen.getByText('Reading the diff.')).toBeTruthy();
  });

  it('says why there is no diff rather than showing an empty row', async () => {
    const user = userEvent.setup();
    shown(
      { ...clean, files: [{ path: 'image.png', unstaged: 'modified' }] },
      { diffs: { 'unstaged:image.png': { patch: null, reason: 'binary', stale: false } } },
    );

    await user.click(row('image.png'));

    expect(screen.getByText('Not a text file.')).toBeTruthy();
  });
});


/**
 * Reading the tree again drops every held diff, because a diff describes the state the
 * status was read in. The open row has to notice and ask again - without that it said it
 * was reading and then never was, until it was collapsed and reopened.
 */
describe('an open row when the tree is read again', () => {
  const one: RepoStatus = { ...clean, files: [{ path: 'a.ts', unstaged: 'modified' }] };
  const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after';

  it('asks again when its diff is dropped', async () => {
    const onDiff = vi.fn();
    const user = userEvent.setup();
    const view = shown(one, { onDiff, diffs: { 'unstaged:a.ts': { patch, stale: false } } });
    await user.click(row('a.ts'));
    onDiff.mockClear();

    // What a refresh does: the status stands, the diffs are gone.
    view.rerender(
      <Repository
        status={one}
        loading={false}
        cwd={'C:\\repo'}
        diffs={{}}
        onDiff={onDiff}
        busy={[]}
        onStage={() => {}}
        onCommit={() => {}}
        committing={false}
        onSync={() => {}}
        syncing={null}
        diverged={false}
        onDismissDiverged={() => {}}
        onRememberStrategy={() => {}}
        branches={[]}
        onBranches={() => {}}
        onSwitch={() => {}}
        switching={false}
        failed={null}
        onRefresh={() => {}}
        onClose={() => {}}
      />,
    );

    expect(onDiff).toHaveBeenCalledWith('a.ts', false);
  });

  it('draws the new diff once it arrives', async () => {
    const user = userEvent.setup();
    const view = shown(one, { diffs: { 'unstaged:a.ts': { patch, stale: false } } });
    await user.click(row('a.ts'));

    const after = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+something else entirely';
    view.rerender(
      <Repository
        status={one}
        loading={false}
        cwd={'C:\\repo'}
        diffs={{ 'unstaged:a.ts': { patch: after, stale: false } }}
        onDiff={() => {}}
      busy={[]}
      onStage={() => {}}
      onCommit={() => {}}
      committing={false}
      onSync={() => {}}
      syncing={null}
      diverged={false}
      onDismissDiverged={() => {}}
      onRememberStrategy={() => {}}
      branches={[]}
      onBranches={() => {}}
      onSwitch={() => {}}
      switching={false}
      failed={null}
        onRefresh={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/something else entirely/)).toBeTruthy();
  });

  /** A diff that cannot be read is still recorded, so the absence this reacts to is filled. */
  it('stops asking once the answer is that there is no diff', async () => {
    const onDiff = vi.fn();
    const user = userEvent.setup();
    const view = shown(one, { onDiff, diffs: { 'unstaged:a.ts': { patch: null, stale: false } } });
    await user.click(row('a.ts'));
    onDiff.mockClear();

    view.rerender(
      <Repository
        status={one}
        loading={false}
        cwd={'C:\\repo'}
        diffs={{ 'unstaged:a.ts': { patch: null, stale: false } }}
        onDiff={onDiff}
        busy={[]}
        onStage={() => {}}
        onCommit={() => {}}
        committing={false}
        onSync={() => {}}
        syncing={null}
        diverged={false}
        onDismissDiverged={() => {}}
        onRememberStrategy={() => {}}
        branches={[]}
        onBranches={() => {}}
        onSwitch={() => {}}
        switching={false}
        failed={null}
        onRefresh={() => {}}
        onClose={() => {}}
      />,
    );

    expect(onDiff).not.toHaveBeenCalled();
  });
});




/**
 * Staging, the first thing this panel does that changes anything (#43).
 */
describe('putting a file into the next commit', () => {
  const one: RepoStatus = { ...clean, files: [{ path: 'a.ts', unstaged: 'modified' }] };
  const already: RepoStatus = { ...clean, files: [{ path: 'a.ts', staged: 'modified' }] };

  it('offers to stage a file that is not staged', async () => {
    const onStage = vi.fn();
    const user = userEvent.setup();
    shown(one, { onStage });

    await user.click(screen.getByRole('button', { name: 'Stage a.ts' }));

    expect(onStage).toHaveBeenCalledWith(['a.ts'], true);
  });

  it('offers to take back a file that is staged', async () => {
    const onStage = vi.fn();
    const user = userEvent.setup();
    shown(already, { onStage });

    await user.click(screen.getByRole('button', { name: 'Unstage a.ts' }));

    expect(onStage).toHaveBeenCalledWith(['a.ts'], false);
  });

  /** Each row acts on its own side, so the file in both lists can be moved either way. */
  it('offers both directions for a file in both lists', () => {
    shown({ ...clean, files: [{ path: 'a.ts', staged: 'modified', unstaged: 'modified' }] });

    expect(screen.getByRole('button', { name: 'Stage a.ts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unstage a.ts' })).toBeTruthy();
  });

  it('cannot be clicked twice while it is working', () => {
    shown(one, { busy: ['a.ts'] });

    expect(screen.getByRole('button', { name: 'Stage a.ts' })).toHaveProperty('disabled', true);
  });

  it('leaves other rows alone while one is working', () => {
    shown({ ...clean, files: [{ path: 'a.ts', unstaged: 'modified' }, { path: 'b.ts', unstaged: 'modified' }] }, {
      busy: ['a.ts'],
    });

    expect(screen.getByRole('button', { name: 'Stage b.ts' })).toHaveProperty('disabled', false);
  });

  /** Staging half a conflict would record it as the resolution, and this panel cannot resolve one. */
  it('does not offer to stage an unmerged file', () => {
    shown({ ...clean, files: [{ path: 'a.ts', unstaged: 'unmerged' }] });

    expect(screen.queryByRole('button', { name: /Stage a\.ts/ })).toBeNull();
  });

  it('says what could not be done rather than appearing to do nothing', () => {
    shown(one, { failed: 'Could not stage a.ts' });

    expect(screen.getByText('Could not stage a.ts')).toBeTruthy();
  });

  // Opening the diff and staging are different intentions, on different controls.
  it('does not open the diff when the stage button is clicked', async () => {
    const user = userEvent.setup();
    const view = shown(one, { diffs: { 'unstaged:a.ts': { patch: 'x', stale: false } } });

    await user.click(screen.getByRole('button', { name: 'Stage a.ts' }));

    expect(view.container.querySelector('.tool-diff')).toBeNull();
  });
});




const staged = (path: string) => ({ path, staged: 'modified' as const });

const box = () => screen.getByLabelText('Commit message') as HTMLTextAreaElement;
const commitButton = () => screen.getByRole('button', { name: /^Commit/ });

describe('writing a commit', () => {
  it('will not commit without a message', () => {
    shown({ ...clean, files: [staged('a.ts')] });

    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not commit a message that is only whitespace', async () => {
    shown({ ...clean, files: [staged('a.ts')] });

    await userEvent.type(box(), '   ');

    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not commit with nothing staged', async () => {
    shown(clean);

    await userEvent.type(box(), 'Fix the thing');

    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('commits what was written', async () => {
    const onCommit = vi.fn();
    shown({ ...clean, files: [staged('a.ts')] }, { onCommit });

    await userEvent.type(box(), 'Fix the thing');
    await userEvent.click(commitButton());

    expect(onCommit).toHaveBeenCalledWith('Fix the thing', false);
  });

  it('empties the box once the commit is made', async () => {
    shown({ ...clean, files: [staged('a.ts')] });

    await userEvent.type(box(), 'Fix the thing');
    await userEvent.click(commitButton());

    expect(box().value).toBe('');
  });

  it('commits on Ctrl+Enter', async () => {
    const onCommit = vi.fn();
    shown({ ...clean, files: [staged('a.ts')] }, { onCommit });

    await userEvent.type(box(), 'Fix the thing');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    expect(onCommit).toHaveBeenCalledWith('Fix the thing', false);
  });

  it('does not commit on Ctrl+Enter when it could not be clicked either', async () => {
    const onCommit = vi.fn();
    shown({ ...clean, files: [staged('a.ts')] }, { onCommit });

    box().focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('leaves a plain Enter as a newline', async () => {
    const onCommit = vi.fn();
    shown({ ...clean, files: [staged('a.ts')] }, { onCommit });

    await userEvent.type(box(), 'Subject{Enter}{Enter}Body');

    expect(onCommit).not.toHaveBeenCalled();
    expect(box().value).toBe('Subject\n\nBody');
  });

  it('says how many files are going in', () => {
    shown({ ...clean, files: [staged('a.ts'), staged('b.ts')] });

    expect(screen.getByText('2 staged files')).toBeTruthy();
  });

  it('counts one file as one file', () => {
    shown({ ...clean, files: [staged('a.ts')] });

    expect(screen.getByText('1 staged file')).toBeTruthy();
  });

  it('counts the subject, not the whole message', async () => {
    shown({ ...clean, files: [staged('a.ts')] });

    await userEvent.type(box(), 'Subject{Enter}{Enter}A much longer body than the subject line is');

    expect(screen.getByText('7')).toBeTruthy();
  });

  it('marks a subject that is getting wide', async () => {
    shown({ ...clean, files: [staged('a.ts')] });

    await userEvent.type(box(), 'x'.repeat(60));

    expect(screen.getByText('60').className).toBe('repo-subject wide');
  });

  it('marks a subject that is too long', async () => {
    shown({ ...clean, files: [staged('a.ts')] });

    await userEvent.type(box(), 'x'.repeat(80));

    expect(screen.getByText('80').className).toBe('repo-subject long');
  });

  it('leaves a comfortable subject unmarked', async () => {
    shown({ ...clean, files: [staged('a.ts')] });

    await userEvent.type(box(), 'x'.repeat(20));

    expect(screen.getByText('20').className).toBe('repo-subject');
  });

  it('offers no amend for a commit that is already published', () => {
    shown({ ...clean, upstream: 'origin/main', ahead: 0, files: [staged('a.ts')] });

    expect(screen.queryByLabelText(/Amend/)).toBeNull();
  });

  it('offers to amend a commit that has not been pushed', () => {
    shown({ ...clean, upstream: 'origin/main', ahead: 1, files: [staged('a.ts')] });

    expect(screen.getByLabelText(/Amend/)).toBeTruthy();
  });

  it('offers to amend in a repository with no upstream at all', () => {
    shown({ ...clean, files: [staged('a.ts')] });

    expect(screen.getByLabelText(/Amend/)).toBeTruthy();
  });

  it('amends when asked to', async () => {
    const onCommit = vi.fn();
    shown({ ...clean, files: [staged('a.ts')] }, { onCommit });

    await userEvent.click(screen.getByLabelText(/Amend/));
    await userEvent.type(box(), 'A better message');
    await userEvent.click(commitButton());

    expect(onCommit).toHaveBeenCalledWith('A better message', true);
  });

  it('lets a message be reworded with nothing staged', async () => {
    shown(clean);

    await userEvent.click(screen.getByLabelText(/Amend/));
    await userEvent.type(box(), 'A better message');

    expect((commitButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('says that an amend with nothing staged only touches the message', async () => {
    shown(clean);

    await userEvent.click(screen.getByLabelText(/Amend/));

    expect(screen.getByText('Amending the message only')).toBeTruthy();
  });

  it('will not commit twice while the first is still going', () => {
    shown({ ...clean, files: [staged('a.ts')] }, { committing: true });

    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers nothing to commit outside a repository', () => {
    shown(null);

    expect(screen.queryByLabelText('Commit message')).toBeNull();
  });
});


describe('staging and unstaging a whole group', () => {
  const mixed = {
    ...clean,
    files: [
      { path: 'a.ts', staged: 'modified' as const },
      { path: 'b.ts', staged: 'added' as const },
      { path: 'c.ts', unstaged: 'modified' as const },
      { path: 'd.ts', unstaged: 'deleted' as const },
    ],
  };

  it('stages every changed file at once', async () => {
    const onStage = vi.fn();
    shown(mixed, { onStage });

    await userEvent.click(screen.getByRole('button', { name: 'Stage all' }));

    expect(onStage).toHaveBeenCalledWith(['c.ts', 'd.ts'], true);
  });

  it('unstages every staged file at once', async () => {
    const onStage = vi.fn();
    shown(mixed, { onStage });

    await userEvent.click(screen.getByRole('button', { name: 'Unstage all' }));

    expect(onStage).toHaveBeenCalledWith(['a.ts', 'b.ts'], false);
  });

  it('offers no unstage all when nothing is staged', () => {
    shown({ ...clean, files: [{ path: 'c.ts', unstaged: 'modified' }] });

    expect(screen.queryByRole('button', { name: 'Unstage all' })).toBeNull();
  });

  it('offers no stage all when nothing is changed', () => {
    shown({ ...clean, files: [{ path: 'a.ts', staged: 'modified' }] });

    expect(screen.queryByRole('button', { name: 'Stage all' })).toBeNull();
  });

  it('takes a file that is in both lists from the side the button belongs to', async () => {
    const onStage = vi.fn();
    shown(
      {
        ...clean,
        files: [
          { path: 'both.ts', staged: 'modified', unstaged: 'modified' },
          { path: 'staged-only.ts', staged: 'added' },
        ],
      },
      { onStage },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Stage all' }));

    expect(onStage).toHaveBeenCalledWith(['both.ts'], true);
  });

  it('will not stage all again while one of its files is still moving', () => {
    shown(mixed, { busy: ['c.ts'] });

    expect((screen.getByRole('button', { name: 'Stage all' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves the other group usable while one is busy', () => {
    shown(mixed, { busy: ['c.ts'] });

    expect((screen.getByRole('button', { name: 'Unstage all' }) as HTMLButtonElement).disabled).toBe(false);
  });
});



describe('syncing with the remote', () => {
  const tracking = { ...clean, upstream: 'origin/main' };

  it('pushes when asked to', async () => {
    const onSync = vi.fn();
    shown(tracking, { onSync });

    await userEvent.click(screen.getByRole('button', { name: 'Push' }));

    expect(onSync).toHaveBeenCalledWith('push');
  });

  it('pulls when asked to', async () => {
    const onSync = vi.fn();
    shown(tracking, { onSync });

    await userEvent.click(screen.getByRole('button', { name: 'Pull' }));

    expect(onSync).toHaveBeenCalledWith('pull');
  });

  it('offers to publish a branch that tracks nothing', () => {
    shown(clean);

    expect((screen.getByRole('button', { name: 'Push' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('will not pull into a branch that tracks nothing', () => {
    shown(clean);

    expect((screen.getByRole('button', { name: 'Pull' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers neither on a detached HEAD, where there is no branch to sync', () => {
    shown({ ...clean, detached: true, branch: 'a1b2c3d' });

    expect(screen.queryByRole('button', { name: 'Push' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pull' })).toBeNull();
  });

  it('offers neither outside a repository', () => {
    shown(null);

    expect(screen.queryByRole('button', { name: 'Push' })).toBeNull();
  });

  it('says which way it is going while it goes', () => {
    shown(tracking, { syncing: 'push' });

    expect(screen.getByRole('button', { name: 'Pushing…' })).toBeTruthy();
  });

  it('will not start the other direction while one is running', () => {
    shown(tracking, { syncing: 'push' });

    expect((screen.getByRole('button', { name: 'Pull' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('never offers to force anything', () => {
    shown({ ...tracking, ahead: 2, behind: 3 });

    expect(screen.queryByText(/force/i)).toBeNull();
  });
});



describe('choosing a branch', () => {
  const some = [
    { name: 'main', current: true },
    { name: 'feature', current: false },
  ];

  it('says which branch it is on, where a screen reader can hear it', () => {
    shown(clean);

    expect(screen.getByLabelText('Switch branch, on main')).toBeTruthy();
  });

  it('reads the branches only when the picker is opened', async () => {
    const onBranches = vi.fn();
    shown(clean, { onBranches });
    expect(onBranches).not.toHaveBeenCalled();

    await userEvent.click(screen.getByLabelText(/Switch branch/));

    expect(onBranches).toHaveBeenCalled();
  });

  it('lists them once it is open', async () => {
    shown(clean, { branches: some });

    await userEvent.click(screen.getByLabelText(/Switch branch/));

    expect(screen.getByRole('button', { name: 'feature' })).toBeTruthy();
  });

  it('switches to the one that is clicked', async () => {
    const onSwitch = vi.fn();
    shown(clean, { branches: some, onSwitch });

    await userEvent.click(screen.getByLabelText(/Switch branch/));
    await userEvent.click(screen.getByRole('button', { name: 'feature' }));

    expect(onSwitch).toHaveBeenCalledWith('feature', false);
  });

  it('does not switch to the branch it is already on', async () => {
    const onSwitch = vi.fn();
    shown(clean, { branches: some, onSwitch });

    await userEvent.click(screen.getByLabelText(/Switch branch/));
    await userEvent.click(screen.getByRole('button', { name: 'main' }));

    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('closes once a branch is chosen', async () => {
    shown(clean, { branches: some });

    await userEvent.click(screen.getByLabelText(/Switch branch/));
    await userEvent.click(screen.getByRole('button', { name: 'feature' }));

    expect(screen.queryByRole('button', { name: 'feature' })).toBeNull();
  });

  it('makes a branch and checks it out', async () => {
    const onSwitch = vi.fn();
    shown(clean, { branches: some, onSwitch });

    await userEvent.click(screen.getByLabelText(/Switch branch/));
    await userEvent.type(screen.getByLabelText('New branch name'), 'try-something');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSwitch).toHaveBeenCalledWith('try-something', true);
  });

  it('will not create a branch with no name', async () => {
    shown(clean, { branches: some });

    await userEvent.click(screen.getByLabelText(/Switch branch/));

    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not create a branch named only with spaces', async () => {
    shown(clean, { branches: some });

    await userEvent.click(screen.getByLabelText(/Switch branch/));
    await userEvent.type(screen.getByLabelText('New branch name'), '   ');

    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says that uncommitted work comes along', async () => {
    shown({ ...clean, files: [{ path: 'a.ts', unstaged: 'modified' }] }, { branches: some });

    await userEvent.click(screen.getByLabelText(/Switch branch/));

    expect(screen.getByText('1 changed file carries over')).toBeTruthy();
  });

  it('counts more than one of them', async () => {
    shown(
      { ...clean, files: [{ path: 'a.ts', unstaged: 'modified' }, { path: 'b.ts', staged: 'added' }] },
      { branches: some },
    );

    await userEvent.click(screen.getByLabelText(/Switch branch/));

    expect(screen.getByText('2 changed files carry over')).toBeTruthy();
  });

  it('says nothing about work when there is none', async () => {
    shown(clean, { branches: some });

    await userEvent.click(screen.getByLabelText(/Switch branch/));

    expect(screen.queryByText(/comes? with you/)).toBeNull();
  });

  it('offers no picker on a detached HEAD, which is a commit rather than a branch', () => {
    shown({ ...clean, detached: true, branch: 'a1b2c3d' });

    expect(screen.queryByLabelText(/Switch branch/)).toBeNull();
    expect(screen.getByText('a1b2c3d')).toBeTruthy();
  });

  it('cannot be opened while a checkout is running', () => {
    shown(clean, { switching: true });

    expect((screen.getByLabelText(/Switch branch/) as HTMLButtonElement).disabled).toBe(true);
  });
});


/**
 * A pull that found the branches had both moved on. There is no fast-forward from there and
 * no right answer, so the reader is asked - which is what the CLI does too, since its
 * `mergeStrategy` has no default either (#205).
 */
describe('choosing how to pull', () => {
  const asking = (over: Partial<Parameters<typeof Repository>[0]> = {}) =>
    shown(clean, { diverged: true, ...over });

  it('says nothing while the pull went through', () => {
    shown(clean);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks once the pull has nowhere to fast-forward to', () => {
    asking();

    expect(screen.getByRole('dialog', { name: /how to pull/i })).toBeTruthy();
  });

  it('pulls again the way it was told', async () => {
    const onSync = vi.fn();
    asking({ onSync });

    await userEvent.click(screen.getByRole('button', { name: 'Rebase' }));

    expect(onSync).toHaveBeenCalledWith('pull', 'rebase');
  });

  it('can be told the other way', async () => {
    const onSync = vi.fn();
    asking({ onSync });

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }));

    expect(onSync).toHaveBeenCalledWith('pull', 'merge');
  });

  // Asked and answered, without being asked to remember: this pull only.
  it('does not write the answer down unless asked to', async () => {
    const onRememberStrategy = vi.fn();
    asking({ onRememberStrategy });

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }));

    expect(onRememberStrategy).not.toHaveBeenCalled();
  });

  it('writes the answer down when asked to stop asking', async () => {
    const onRememberStrategy = vi.fn();
    const onSync = vi.fn();
    asking({ onRememberStrategy, onSync });

    await userEvent.click(screen.getByRole('checkbox', { name: /Remember this choice/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Rebase' }));

    expect(onRememberStrategy).toHaveBeenCalledWith('rebase');
    // Remembering is not answering: this pull still has to happen.
    expect(onSync).toHaveBeenCalledWith('pull', 'rebase');
  });

  it('puts the question away without pulling when it is cancelled', async () => {
    const onDismissDiverged = vi.fn();
    const onSync = vi.fn();
    asking({ onDismissDiverged, onSync });

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onDismissDiverged).toHaveBeenCalled();
    expect(onSync).not.toHaveBeenCalled();
  });
});