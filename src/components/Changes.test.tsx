// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FileDiff, SessionChange } from '../../shared/protocol';
import { Changes } from './Changes';

const change = (over: Partial<SessionChange> = {}): SessionChange => ({
  path: 'C:\\work\\repo\\src\\thing.ts',
  status: 'modified',
  linesAdded: 4,
  linesRemoved: 1,
  turns: 1,
  changedAt: '2026-01-01T00:00:00.000Z',
  diffable: true,
  ...over,
});

const props = {
  changes: null as SessionChange[] | null,
  loading: false,
  failed: null as string | null,
  diffs: {} as Record<string, never>,
  onDiff: () => {},
  cwd: 'C:\\work\\repo',
  onClose: () => {},
  onReview: () => {},
  reviewedAt: null as string | null,
  showAll: false,
  onSpan: () => {},
};

describe('Changes', () => {
  it('says it is reading before the answer arrives', () => {
    render(<Changes {...props} loading />);
    expect(screen.getByText(/Reading what this session changed/)).toBeTruthy();
  });

  /**
   * Only tools that name the file they change leave a record, so a session that worked
   * through the shell genuinely changed things and shows nothing. Saying why is the
   * difference between an empty list and one that looks broken.
   */
  it('explains an empty list rather than showing nothing', () => {
    render(<Changes {...props} changes={[]} />);
    expect(screen.getByText(/Shell commands are not tracked/)).toBeTruthy();
  });

  it('counts the files and totals the lines', () => {
    render(
      <Changes
        {...props}
        changes={[change(), change({ path: 'C:\\work\\repo\\other.ts', linesAdded: 6, linesRemoved: 2 })]}
      />,
    );

    expect(screen.getByText('2 files changed')).toBeTruthy();
    expect(screen.getByText('+10')).toBeTruthy();
    expect(screen.getByText('−3')).toBeTruthy();
  });

  it('shortens paths to the part that identifies them', () => {
    render(<Changes {...props} changes={[change()]} />);
    expect(screen.getByText('src/thing.ts')).toBeTruthy();
  });

  it('says how many turns touched a file, when more than one did', () => {
    render(<Changes {...props} changes={[change({ turns: 3 })]} />);
    expect(screen.getByText('3 turns')).toBeTruthy();
  });

  it('does not say "1 turn", which is every other row', () => {
    render(<Changes {...props} changes={[change({ turns: 1 })]} />);
    expect(screen.queryByText(/turns?$/)).toBeNull();
  });

  // Fetching every diff up front is tens of megabytes almost none of which is looked at.
  it('asks for a diff only when a row is opened', () => {
    const onDiff = vi.fn();
    render(<Changes {...props} changes={[change()]} onDiff={onDiff} />);

    expect(onDiff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /thing\.ts/ }));
    expect(onDiff).toHaveBeenCalledWith('C:\\work\\repo\\src\\thing.ts');
  });

  /**
   * The list is reread underneath the panel when a turn ends or the span changes, which
   * drops the diffs on hand. A row left open has to ask again rather than sit on
   * "Reading the diff." for good.
   */
  it('asks again for an open row when the diffs are dropped', () => {
    const onDiff = vi.fn();
    const diff = { 'C:\\work\\repo\\src\\thing.ts': { patch: '@@', stale: false } } as never;
    const { rerender } = render(<Changes {...props} changes={[change()]} diffs={diff} onDiff={onDiff} />);

    fireEvent.click(screen.getByRole('button', { name: /thing\.ts/ }));
    onDiff.mockClear();

    rerender(<Changes {...props} changes={[change({ linesAdded: 9 })]} diffs={{}} onDiff={onDiff} />);
    expect(onDiff).toHaveBeenCalledWith('C:\\work\\repo\\src\\thing.ts');
  });

  it('closes an open row whose file has dropped off the list', () => {
    const { rerender } = render(<Changes {...props} changes={[change()]} />);

    fireEvent.click(screen.getByRole('button', { name: /thing\.ts/ }));
    rerender(<Changes {...props} changes={[change({ path: 'C:\\work\\repo\\other.ts' })]} />);
    expect(screen.queryByText('Reading the diff.')).toBeNull();
  });

  it('draws the diff once it arrives', () => {
    const { container } = render(
      <Changes
        {...props}
        changes={[change()]}
        diffs={{ 'C:\\work\\repo\\src\\thing.ts': { patch: '@@ -1,1 +1,1 @@\n-was\n+is', stale: false } } as never}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /thing\.ts/ }));
    // Changed text is split across nodes to highlight the part that differs, so the
    // rendered line is the whole row rather than any one element.
    const rows = [...container.querySelectorAll('tr')].map((row) => row.textContent);
    expect(rows).toContain('1−was');
    expect(rows).toContain('1+is');
  });

  /** Otherwise someone else's edit reads as the agent's work. */
  it('warns when the file has moved on since the session left it', () => {
    render(
      <Changes
        {...props}
        changes={[change()]}
        diffs={{ 'C:\\work\\repo\\src\\thing.ts': { patch: '@@ -1,1 +1,1 @@\n-was\n+is', stale: true } } as never}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /thing\.ts/ }));
    expect(screen.getByText(/not the current file/)).toBeTruthy();
  });

  it('says why there is no diff instead of showing an empty one', () => {
    render(
      <Changes
        {...props}
        changes={[change({ diffable: false })]}
        diffs={{ 'C:\\work\\repo\\src\\thing.ts': { patch: null, reason: 'gone', stale: false } }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /thing\.ts/ }));
    expect(screen.getByText(/no longer exists/)).toBeTruthy();
  });

  it('closes a row that is open rather than reopening it', () => {
    render(<Changes {...props} changes={[change()]} />);
    const row = screen.getByRole('button', { name: /thing\.ts/ });

    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape, as every other panel does', () => {
    const onClose = vi.fn();
    render(<Changes {...props} changes={[change()]} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows what went wrong when the read failed', () => {
    render(<Changes {...props} failed="no such session" />);
    expect(screen.getByText('no such session')).toBeTruthy();
  });
});

describe('Changes, once reviewed', () => {
  it('offers nothing to review when there is nothing listed', () => {
    render(<Changes {...props} changes={[]} />);
    expect(screen.queryByRole('button', { name: 'Seen this' })).toBeNull();
  });

  it('marks what is listed as seen', () => {
    const onReview = vi.fn();
    render(<Changes {...props} changes={[change()]} onReview={onReview} />);

    fireEvent.click(screen.getByRole('button', { name: 'Seen this' }));
    expect(onReview).toHaveBeenCalled();
  });

  // Without it the count reads as the whole session, which is a different number.
  it('says the count is only what is new', () => {
    render(<Changes {...props} changes={[change()]} reviewedAt="2026-01-01T00:00:00.000Z" />);
    expect(screen.getByText(/since you last reviewed/)).toBeTruthy();
  });

  it('does not say that when the whole session is on show', () => {
    render(<Changes {...props} changes={[change()]} reviewedAt="2026-01-01T00:00:00.000Z" showAll />);
    expect(screen.queryByText(/since you last reviewed/)).toBeNull();
  });

  it('offers no span to switch to before anything has been reviewed', () => {
    render(<Changes {...props} changes={[change()]} />);
    expect(screen.queryByRole('button', { name: /Whole session|Only what is new/ })).toBeNull();
  });

  it('switches to the whole session and back', () => {
    const onSpan = vi.fn();
    const { rerender } = render(
      <Changes {...props} changes={[change()]} reviewedAt="2026-01-01T00:00:00.000Z" onSpan={onSpan} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Whole session' }));
    expect(onSpan).toHaveBeenCalledWith(true);

    rerender(<Changes {...props} changes={[change()]} reviewedAt="2026-01-01T00:00:00.000Z" showAll onSpan={onSpan} />);
    fireEvent.click(screen.getByRole('button', { name: 'Only what is new' }));
    expect(onSpan).toHaveBeenCalledWith(false);
  });

  /**
   * An empty list after a review means caught up, not that the session did nothing - and
   * those two want opposite words.
   */
  it('says nothing is new rather than nothing was recorded', () => {
    render(<Changes {...props} changes={[]} reviewedAt="2026-01-01T00:00:00.000Z" />);

    expect(screen.getByText(/Nothing new since you reviewed this/)).toBeTruthy();
    expect(screen.queryByText(/Shell commands are not tracked/)).toBeNull();
  });

  it('offers a way out of an empty list', () => {
    const onSpan = vi.fn();
    render(<Changes {...props} changes={[]} reviewedAt="2026-01-01T00:00:00.000Z" onSpan={onSpan} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show the whole session' }));
    expect(onSpan).toHaveBeenCalledWith(true);
  });
});

describe('the file type beside a change', () => {
  it('marks a file with its type', () => {
    const { container } = render(<Changes {...props} changes={[change({ path: 'C:\\work\\repo\\src\\App.tsx' })]} />);
    const badge = container.querySelector('.changes-badge');

    expect(badge?.textContent).toBe('TX');
    expect(badge?.getAttribute('data-tone')).toBe('blue');
  });

  // Beside the mark rather than instead of it: whether a file was created, changed or
  // deleted is the whole point of this list.
  it('leaves the created, modified and deleted mark alone', () => {
    const { container } = render(<Changes {...props} changes={[change({ path: 'a.ts', status: 'created' })]} />);

    expect(container.querySelector('.changes-status.created')?.textContent).toBe('+');
    expect(container.querySelector('.changes-badge')?.textContent).toBe('TS');
  });

  // Blank rather than absent, so a list of mixed types still has its paths in one column.
  it('keeps the column for a file whose type it does not know', () => {
    const { container } = render(<Changes {...props} changes={[change({ path: 'notes.txt' })]} />);
    const badge = container.querySelector('.changes-badge');

    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('');
    expect(badge?.getAttribute('data-tone')).toBeNull();
  });
});

/**
 * A row for work that has not finished (#140).
 *
 * The CLI writes a turn's snapshot when the next turn begins, so this row was built from
 * the events as the tools ran. Its count is about to change, and saying so is cheaper than
 * letting somebody read a half-finished number as the answer.
 */
describe('a turn that is still running', () => {
  it('says so on the row', () => {
    render(<Changes {...props} changes={[change({ running: true })]} />);

    expect(screen.getByText('still working')).toBeTruthy();
  });

  it('says nothing of the sort for work that has finished', () => {
    render(<Changes {...props} changes={[change()]} />);

    expect(screen.queryByText('still working')).toBeNull();
  });

  it('still says what has changed so far', () => {
    render(<Changes {...props} changes={[change({ running: true, linesAdded: 7, linesRemoved: 2 })]} />);

    // Scoped to the row: the panel's own header counts the same lines up again.
    const row = document.querySelector('.changes-row')!;
    expect(row.querySelector('.added')?.textContent).toBe('+7');
    expect(row.querySelector('.removed')?.textContent).toBe('\u22122');
  });

  it('draws the running rows alongside the finished ones', () => {
    render(
      <Changes
        {...props}
        changes={[change({ path: 'C:\\work\\repo\\a.ts', running: true }), change({ path: 'C:\\work\\repo\\b.ts' })]}
      />,
    );

    expect(screen.getAllByText(/still working/)).toHaveLength(1);
    expect(document.querySelectorAll('.changes-row')).toHaveLength(2);
  });
});

/**
 * Opening a row whose turn has not finished (#140).
 *
 * The store has no snapshot for it yet, but every write reported a diff, so the row opens
 * onto what the turn has done rather than onto an explanation of why it cannot.
 */
describe('opening a row the turn is still writing', () => {
  const patch = (line: string) =>
    ['diff --git a/thing.ts b/thing.ts', '--- a/thing.ts', '+++ b/thing.ts', '@@ -1,0 +1,1 @@', `+${line}`].join('\n');

  const openRow = (diff?: FileDiff) => {
    const onDiff = vi.fn();
    render(
      <Changes
        {...props}
        changes={[change({ running: true })]}
        diffs={diff ? ({ 'C:\\work\\repo\\src\\thing.ts': diff } as Record<string, FileDiff>) : ({} as Record<string, never>)}
        onDiff={onDiff}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /thing\.ts/ }));
    return onDiff;
  };

  it('shows what the turn has written', () => {
    openRow({ patch: null, patches: [patch('the new line')], stale: false });

    expect(screen.getByText('the new line')).toBeTruthy();
  });

  it('joins the writes into one diff', () => {
    openRow({ patch: null, patches: [patch('the first'), patch('the second')], stale: false });

    expect(document.querySelectorAll('.tool-diff')).toHaveLength(1);
    expect(screen.getByText('the first')).toBeTruthy();
    expect(screen.getByText('the second')).toBeTruthy();
  });

  it('does not claim nothing was recorded', () => {
    openRow({ patch: null, patches: [patch('the new line')], stale: false });

    expect(screen.queryByText(/No snapshot was taken/)).toBeNull();
  });

  it('asks for it, since there is something to answer with', () => {
    const onDiff = openRow();

    expect(onDiff).toHaveBeenCalledWith('C:\\work\\repo\\src\\thing.ts');
  });

  /** Said in terms of the turn, since what is being waited for is the turn's own writing. */
  it('says what it is waiting for while the answer is on its way', () => {
    openRow();

    expect(screen.getByText('Reading what it has written.')).toBeTruthy();
  });

  it('still asks for one on a row that has finished', () => {
    const onDiff = vi.fn();
    render(<Changes {...props} changes={[change()]} onDiff={onDiff} />);

    fireEvent.click(screen.getByRole('button', { name: /thing\.ts/ }));

    expect(onDiff).toHaveBeenCalledWith('C:\\work\\repo\\src\\thing.ts');
  });
});
