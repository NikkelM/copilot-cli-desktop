// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useState } from 'react';

import { TurnSummary, type TurnView } from './TurnSummary';
import type { TurnChanges } from '../lib/turnChanges';

/**
 * The summary with somewhere to keep how it is being read.
 *
 * It is controlled now: the transcript holds that, because the summary is redrawn whenever
 * its turn gains a row and anything kept inside it would be lost.
 */
function Shown({ changes }: { changes: TurnChanges }) {
  const [view, setView] = useState<TurnView>({ open: false });
  return <TurnSummary changes={changes} view={view} onView={setView} />;
}

const patched = (line: string) => ['diff --git a/x b/x', '@@ -1,0 +1,1 @@', `+${line}`].join('\n');

const changes = {
  files: [
    { path: 'src/lib/patch.ts', added: 12, removed: 3, patches: [patched('the first thing')] },
    {
      path: 'README.md',
      added: 1,
      removed: 0,
      patches: [patched('the earlier wording'), patched('the later wording')],
    },
  ],
  added: 13,
  removed: 3,
  id: 'turn-1',
};

/** The line at the top, rather than any of the file rows under it. */
const head = () => screen.getByRole('button', { name: /files? changed/ });

describe('what a turn changed', () => {
  it('says how many files and what they came to, without being opened', () => {
    render(<Shown changes={changes} />);

    expect(screen.getByText('2 files changed')).toBeTruthy();
    expect(screen.getByText('+13')).toBeTruthy();
    expect(screen.getByText('−3')).toBeTruthy();
  });

  it('counts one file as one file', () => {
    render(<Shown changes={{ ...changes, files: [changes.files[0]!], added: 12, removed: 3 }} />);

    expect(screen.getByText('1 file changed')).toBeTruthy();
  });

  // Closed to a line: a list of files under every turn would be most of the transcript.
  it('keeps the files behind the line until it is opened', async () => {
    render(<Shown changes={changes} />);
    expect(screen.queryByText('patch.ts')).toBeNull();

    await userEvent.click(head());

    expect(screen.getByText('patch.ts')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  /** The name is what a reader recognises; the folder says where it is. */
  it('names the file apart from the folder it is in', async () => {
    render(<Shown changes={changes} />);
    await userEvent.click(head());

    expect(screen.getByText('patch.ts')).toBeTruthy();
    expect(screen.getByText('src/lib')).toBeTruthy();
  });

  it('says what each file came to', async () => {
    const { container } = render(<Shown changes={changes} />);
    await userEvent.click(head());

    // Scoped to the list: the totals on the line above use the same words.
    const files = container.querySelector('.turn-changes-files')!;
    expect(files.textContent).toContain('+12');
    expect(files.textContent).toContain('−3');
    expect(files.textContent).toContain('+1');
  });

  // On most rows it would be a 1 beside every file, saying nothing.
  it('says how often a file was written only when it was written more than once', async () => {
    render(<Shown changes={changes} />);
    await userEvent.click(head());

    expect(screen.getByText('2 edits')).toBeTruthy();
    expect(screen.queryByText('1 edits')).toBeNull();
  });

  /**
   * The point of the list: a file named but not openable leaves the reader to hunt back up
   * the transcript for the row that changed it.
   */
  it('opens a file onto the change itself', async () => {
    const { container } = render(<Shown changes={changes} />);
    await userEvent.click(head());
    expect(container.querySelector('.tool-diff')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /patch\.ts/ }));

    expect(container.querySelector('.tool-diff')).toBeTruthy();
    expect(screen.getByText('the first thing')).toBeTruthy();
  });

  /**
   * What the turn did to the file, rather than the writes it took to get there. Each edit's
   * line numbers count the file as the edit before it left it, so the hunks cannot be
   * interleaved - they are laid end to end with a gap between them instead.
   */
  it('shows every edit to one file as one diff', async () => {
    const { container } = render(<Shown changes={changes} />);
    await userEvent.click(head());
    await userEvent.click(screen.getByRole('button', { name: /README\.md/ }));

    expect(container.querySelectorAll('.tool-diff')).toHaveLength(1);
    expect(screen.getByText('the earlier wording')).toBeTruthy();
    expect(screen.getByText('the later wording')).toBeTruthy();
  });

  it('does not break them up into numbered steps', async () => {
    render(<Shown changes={changes} />);
    await userEvent.click(head());
    await userEvent.click(screen.getByRole('button', { name: /README\.md/ }));

    expect(screen.queryByText(/Edit \d+ of \d+/)).toBeNull();
  });

  /**
   * A gap between them, because the second edit's line numbers do not carry on from the
   * first one's: they count the file as the first edit left it.
   */
  it('marks where one edit ends and the next begins', async () => {
    const { container } = render(<Shown changes={changes} />);
    await userEvent.click(head());
    await userEvent.click(screen.getByRole('button', { name: /README\.md/ }));

    expect(container.querySelectorAll('tr.skip')).toHaveLength(1);
  });

  it('draws no gap in a file written only once', async () => {
    const { container } = render(<Shown changes={changes} />);
    await userEvent.click(head());
    await userEvent.click(screen.getByRole('button', { name: /patch\.ts/ }));

    expect(container.querySelectorAll('tr.skip')).toHaveLength(0);
  });

  // Two diffs at once is the transcript problem again, one level down.
  it('keeps one file open at a time', async () => {
    const { container } = render(<Shown changes={changes} />);
    await userEvent.click(head());

    await userEvent.click(screen.getByRole('button', { name: /patch\.ts/ }));
    await userEvent.click(screen.getByRole('button', { name: /README\.md/ }));

    expect(screen.queryByText('the first thing')).toBeNull();
    // One file open, and one file is one diff however many times the turn wrote it.
    expect(container.querySelectorAll('.tool-diff')).toHaveLength(1);
  });

  it('closes a file that is open when it is asked again', async () => {
    const { container } = render(<Shown changes={changes} />);
    await userEvent.click(head());

    await userEvent.click(screen.getByRole('button', { name: /patch\.ts/ }));
    await userEvent.click(screen.getByRole('button', { name: /patch\.ts/ }));

    expect(container.querySelector('.tool-diff')).toBeNull();
  });

  /**
   * Opening the line and then opening its only row is two clicks to reach the one thing
   * behind them, and nothing was being chosen between.
   */
  describe('a turn that changed one file', () => {
    const alone = { ...changes, files: [changes.files[0]!], added: 12, removed: 3 };

    it('opens that file without being asked', async () => {
      const { container } = render(<Shown changes={alone} />);
      await userEvent.click(head());

      expect(container.querySelector('.tool-diff')).toBeTruthy();
      expect(screen.getByText('the first thing')).toBeTruthy();
    });

    it('still closes when the reader asks it to', async () => {
      const { container } = render(<Shown changes={alone} />);
      await userEvent.click(head());

      await userEvent.click(screen.getByRole('button', { name: /patch\.ts/ }));

      expect(container.querySelector('.tool-diff')).toBeNull();
    });

    // With two there is a choice, and opening one of them would be making it for the reader.
    it('leaves them all closed once there is more than one', async () => {
      const { container } = render(<Shown changes={changes} />);
      await userEvent.click(head());

      expect(container.querySelector('.tool-diff')).toBeNull();
    });
  });
});
