// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { usePlan } from '../lib/usePlan';
import { SessionPlan } from './SessionPlan';

vi.mock('./Markdown', () => ({ Markdown: ({ body }: { body: string }) => <div data-testid="markdown">{body}</div> }));

function state(over: Partial<ReturnType<typeof usePlan>> = {}): ReturnType<typeof usePlan> {
  return {
    plan: { content: '# Original', revision: 'r1', path: 'C:\\session\\plan.md' },
    draft: undefined, loading: false, failed: undefined, saving: false, conflict: false,
    notifying: false, notificationFailed: undefined, retryNotification: vi.fn(),
    edit: vi.fn(), change: vi.fn(), discard: vi.fn(), save: vi.fn(), refresh: vi.fn(),
    ...over,
  };
}

describe('session plan panel', () => {
  it('offers to retry a failed agent notification without saving the file again', () => {
    const plan = state({ notificationFailed: 'The plan is saved, but the agent has not been notified. Offline' });
    render(<SessionPlan plan={plan} onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('agent has not been notified');
    fireEvent.click(screen.getByRole('button', { name: 'Retry notification' }));
    expect(plan.retryNotification).toHaveBeenCalledOnce();
    expect(plan.save).not.toHaveBeenCalled();
  });

  it('shows notification progress and disables duplicate retries', () => {
    const plan = state({ notifying: true, saving: true });
    render(<SessionPlan plan={plan} onClose={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('Notifying agent...');
    expect(screen.queryByRole('button', { name: 'Retry notification' })).toBeNull();
  });

  it('renders Markdown in the notes column with the path available on its title', () => {
    const plan = state();
    render(<SessionPlan plan={plan} onClose={vi.fn()} />);
    expect(screen.getByTestId('markdown').textContent).toBe('# Original');
    expect(screen.getByTitle('C:\\session\\plan.md').textContent).toBe('Plan');
    const column = screen.getByRole('complementary', { name: 'Session plan' });
    expect(column.dataset.region).toBe('panel');
    expect(column.className).toBe('notes');
    expect(column.querySelector('.notes-body')).toBeTruthy();
    expect(column.classList.contains('changes')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(plan.edit).toHaveBeenCalledOnce();
  });

  it('edits and previews the local draft, saving on click or Ctrl+S', () => {
    const plan = state({ draft: { content: '# Edited', revision: 'r1' } });
    render(<SessionPlan plan={plan} onClose={vi.fn()} />);
    const editor = screen.getByRole('textbox', { name: 'Plan Markdown' });
    expect(editor.className).toBe('wiki-source');
    expect(editor.closest('.notes-body')).toBeTruthy();
    fireEvent.change(editor, { target: { value: '# More edits' } });
    expect(plan.change).toHaveBeenCalledWith('# More edits');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('markdown').textContent).toBe('# Edited');
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByRole('textbox')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', ctrlKey: true });
    expect(plan.save).toHaveBeenCalledTimes(2);
  });

  it('shares the wiki viewer frontmatter rendering and keeps the complete source editable', () => {
    const source = '---\ntitle: My plan\n---\n\n# Build it';
    render(<SessionPlan plan={state({
      draft: { content: source, revision: 'r1' },
    })} onClose={vi.fn()} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(source);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('title')).toBeTruthy();
    expect(screen.getByText('My plan')).toBeTruthy();
    expect(screen.getByTestId('markdown').textContent).toBe('# Build it');
  });

  it('disables the shared Markdown editor while a save is in progress', () => {
    render(<SessionPlan plan={state({
      draft: { content: 'draft', revision: 'r1' }, saving: true,
    })} onClose={vi.fn()} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it.each([
    { conflict: true }, { loading: true }, { saving: true },
    { draft: { content: '# Original', revision: 'r1' } },
  ])('does not save unavailable or unchanged edits: %j', (over) => {
    const plan = state({ draft: { content: 'draft', revision: 'r1' }, ...over });
    render(<SessionPlan plan={plan} onClose={vi.fn()} />);
    const button = screen.getByRole('button', { name: /^(Save|Saving\.\.\.)$/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', ctrlKey: true });
    expect(plan.save).not.toHaveBeenCalled();
  });

  it('requires confirmation before discarding changed edits and allows cancelling', () => {
    const plan = state({ draft: { content: 'draft', revision: 'r1' } });
    render(<SessionPlan plan={plan} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Discard plan edits?' });
    expect(plan.discard).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard edits' }));
    expect(plan.discard).toHaveBeenCalledOnce();
  });

  it('closes without discarding the recoverable draft, and supports manual reloading', () => {
    const plan = state({ draft: { content: 'draft', revision: 'r1' } });
    const close = vi.fn();
    render(<SessionPlan plan={plan} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(plan.refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Close plan' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(2);
    expect(plan.discard).not.toHaveBeenCalled();
    expect(screen.getByText(/Draft kept locally/)).toBeTruthy();
  });

  it('shows failures and the external-change warning without hiding the draft', () => {
    render(<SessionPlan plan={state({
      draft: { content: 'my work', revision: 'r1' }, conflict: true, failed: 'Disk is read-only',
    })} onClose={vi.fn()} />);
    expect(screen.getAllByRole('alert').map((node) => node.textContent)).toEqual([
      'Disk is read-only',
      expect.stringContaining('plan changed on disk'),
    ]);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('my work');
  });

  it('shows a deleted plan honestly while keeping a recovered draft editable', () => {
    const view = render(<SessionPlan plan={state({ plan: null })} onClose={vi.fn()} />);
    expect(screen.getByText('This session has no plan file.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<SessionPlan plan={state({ plan: null, draft: { content: 'recovered', revision: 'r1' }, conflict: true })} onClose={vi.fn()} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('recovered');
  });
});
