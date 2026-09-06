// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getChanges = vi.fn();
const getDiff = vi.fn();
vi.mock('../lib/sidecar', () => ({
  getChanges: (...args: unknown[]) => getChanges(...args),
  getDiff: (...args: unknown[]) => getDiff(...args),
}));

const { Changes } = await import('./Changes');

const CWD = 'C:\\work\\repo';

const patch = [
  'diff --git a/src/a.ts b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' kept',
  '-gone',
  '+added',
].join('\n');

beforeEach(() => {
  getChanges.mockReset();
  getDiff.mockReset();
  getChanges.mockResolvedValue({ root: CWD, changes: [], points: [] });
  getDiff.mockResolvedValue({ patch });
});

const show = (revision = 0) => render(<Changes sessionId="s1" revision={revision} cwd={CWD} />);

describe('Changes', () => {
  // A session that changed nothing should not take up room saying so.
  it('shows nothing when the agent changed nothing', async () => {
    const { container } = show();
    await waitFor(() => expect(getChanges).toHaveBeenCalled());
    expect(container.querySelector('.changes')).toBeNull();
  });

  it('counts the files that changed', async () => {
    getChanges.mockResolvedValue({
      root: CWD,
      changes: [
        { path: `${CWD}\\src\\a.ts`, status: 'modified' },
        { path: `${CWD}\\src\\b.ts`, status: 'added' },
      ],
      points: [],
    });

    show();
    expect(await screen.findByText('2 files changed')).toBeTruthy();
  });

  it('says one file rather than one files', async () => {
    getChanges.mockResolvedValue({ root: CWD, changes: [{ path: `${CWD}\\a.ts`, status: 'added' }], points: [] });
    show();
    expect(await screen.findByText('1 file changed')).toBeTruthy();
  });

  it('lists the files once opened', async () => {
    getChanges.mockResolvedValue({ root: CWD, changes: [{ path: `${CWD}\\src\\a.ts`, status: 'modified' }], points: [] });
    show();

    await userEvent.click(await screen.findByText('1 file changed'));
    expect(screen.getByText('src\\a.ts')).toBeTruthy();
  });

  /**
   * A patch is far larger than the line naming it, and a session can touch many files, so
   * nothing is read until the file it belongs to is opened.
   */
  it('does not read a patch until its file is opened', async () => {
    getChanges.mockResolvedValue({ root: CWD, changes: [{ path: `${CWD}\\src\\a.ts`, status: 'modified' }], points: [] });
    show();

    await userEvent.click(await screen.findByText('1 file changed'));
    expect(getDiff).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText('src\\a.ts'));
    await waitFor(() => expect(getDiff).toHaveBeenCalledWith('s1', `${CWD}\\src\\a.ts`));
  });

  it('shows the change with the lines it touched', async () => {
    getChanges.mockResolvedValue({ root: CWD, changes: [{ path: `${CWD}\\src\\a.ts`, status: 'modified' }], points: [] });
    const { container } = show();

    await userEvent.click(await screen.findByText('1 file changed'));
    await userEvent.click(screen.getByText('src\\a.ts'));

    await waitFor(() => expect(container.querySelector('tr.added')).not.toBeNull());
    expect(container.querySelector('tr.added .code')?.textContent).toBe('added');
    expect(container.querySelector('tr.removed .code')?.textContent).toBe('gone');
  });

  it('counts what the patch added and removed', async () => {
    getChanges.mockResolvedValue({ root: CWD, changes: [{ path: `${CWD}\\src\\a.ts`, status: 'modified' }], points: [] });
    show();

    await userEvent.click(await screen.findByText('1 file changed'));
    await userEvent.click(screen.getByText('src\\a.ts'));

    expect(await screen.findByText('+1')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
  });

  // A file the agent touched outside the session's directory has no shorter name.
  it('shows a path outside the working directory in full', async () => {
    const outside = 'C:\\Users\\nikke\\Downloads\\notes.txt';
    getChanges.mockResolvedValue({ root: null, changes: [{ path: outside, status: 'modified' }], points: [] });
    show();

    await userEvent.click(await screen.findByText('1 file changed'));
    expect(screen.getByText(outside)).toBeTruthy();
  });

  it('reads the changes again when a turn finishes', async () => {
    const { rerender } = show(0);
    await waitFor(() => expect(getChanges).toHaveBeenCalledTimes(1));

    rerender(<Changes sessionId="s1" revision={1} cwd={CWD} />);
    await waitFor(() => expect(getChanges).toHaveBeenCalledTimes(2));
  });

  it('says nothing rather than failing when the changes cannot be read', async () => {
    getChanges.mockRejectedValue(new Error('no runtime'));
    const { container } = show();

    await waitFor(() => expect(getChanges).toHaveBeenCalled());
    expect(container.querySelector('.changes')).toBeNull();
  });
});
