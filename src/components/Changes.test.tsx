// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionChange } from '../../shared/protocol';
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
    expect(screen.getByText(/tools that name the file/)).toBeTruthy();
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
    expect(screen.getByText(/not the file as it stands/)).toBeTruthy();
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
    expect(screen.getByText(/not on disk any more/)).toBeTruthy();
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
    expect(screen.queryByText(/tools that name the file/)).toBeNull();
  });

  it('offers a way out of an empty list', () => {
    const onSpan = vi.fn();
    render(<Changes {...props} changes={[]} reviewedAt="2026-01-01T00:00:00.000Z" onSpan={onSpan} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show the whole session' }));
    expect(onSpan).toHaveBeenCalledWith(true);
  });
});
