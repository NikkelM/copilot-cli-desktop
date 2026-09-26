// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { TurnSummary } from './TurnSummary';

const changes = {
  files: [
    { path: 'src/lib/patch.ts', added: 12, removed: 3, edits: 1 },
    { path: 'README.md', added: 1, removed: 0, edits: 2 },
  ],
  added: 13,
  removed: 3,
};

describe('what a turn changed', () => {
  it('says how many files and what they came to, without being opened', () => {
    render(<TurnSummary changes={changes} />);

    expect(screen.getByText('2 files changed')).toBeTruthy();
    expect(screen.getByText('+13')).toBeTruthy();
    expect(screen.getByText('−3')).toBeTruthy();
  });

  it('counts one file as one file', () => {
    render(<TurnSummary changes={{ files: [changes.files[0]!], added: 12, removed: 3 }} />);

    expect(screen.getByText('1 file changed')).toBeTruthy();
  });

  // Closed to a line: a list of files under every turn would be most of the transcript.
  it('keeps the files behind the line until it is opened', async () => {
    render(<TurnSummary changes={changes} />);
    expect(screen.queryByText('patch.ts')).toBeNull();

    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByText('patch.ts')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  /** The name is what a reader recognises; the folder says where it is. */
  it('names the file apart from the folder it is in', async () => {
    render(<TurnSummary changes={changes} />);
    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByText('patch.ts')).toBeTruthy();
    expect(screen.getByText('src/lib')).toBeTruthy();
  });

  it('says what each file came to', async () => {
    const { container } = render(<TurnSummary changes={changes} />);
    await userEvent.click(screen.getByRole('button'));

    // Scoped to the list: the totals on the line above use the same words.
    const files = container.querySelector('.turn-changes-files')!;
    expect(files.textContent).toContain('+12');
    expect(files.textContent).toContain('−3');
    expect(files.textContent).toContain('+1');
  });

  // On most rows it would be a 1 beside every file, saying nothing.
  it('says how often a file was written only when it was written more than once', async () => {
    render(<TurnSummary changes={changes} />);
    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByText('2 edits')).toBeTruthy();
    expect(screen.queryByText('1 edits')).toBeNull();
  });
});
