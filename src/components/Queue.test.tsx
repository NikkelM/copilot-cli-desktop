// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { QueuedItem } from '../../shared/protocol';

import { Queue } from './Queue';

const message = (id: string, text: string): QueuedItem => ({ id, kind: 'message', text });

describe('Queue', () => {
  // The row is a frame around what is waiting; with nothing it is a frame around nothing.
  it('shows nothing when nothing is waiting', () => {
    const { container } = render(<Queue items={[]} />);
    expect(container.textContent).toBe('');
  });

  it('lists what is waiting, in the order it will run', () => {
    render(<Queue items={[message('a', 'first thing'), message('b', 'second thing')]} />);

    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items[0]).toContain('first thing');
    expect(items[1]).toContain('second thing');
  });

  // Which one goes next is the only ordering worth showing.
  it('marks the one that goes next', () => {
    render(<Queue items={[message('a', 'first thing'), message('b', 'second thing')]} />);

    expect(screen.getAllByRole('listitem')[0].textContent).toContain('Next');
    expect(screen.getAllByRole('listitem')[1].textContent).toContain('2');
  });

  it('says how many are waiting', () => {
    render(<Queue items={[message('a', 'one')]} />);
    expect(screen.getByText(/1 queued/)).toBeTruthy();
  });

  // A queued command is not a message, and reads as one without being marked.
  it('distinguishes a queued command from a message', () => {
    render(<Queue items={[message('a', 'one'), { id: 'b', kind: 'command', text: '/compact' }]} />);

    const rows = screen.getAllByRole('listitem');
    expect(rows[0].querySelector('.queue-text.command')).toBeNull();
    expect(rows[1].querySelector('.queue-text.command')).not.toBeNull();
  });
});
/**
 * Changing your mind about something already waiting (#76). The runtime owns the queue and
 * is consuming from it as the turn runs, so everything here only asks - what is waiting
 * afterwards is whatever the runtime then reports.
 */
describe('Queue, changing what is waiting', () => {
  const user = userEvent.setup();

  it('offers nothing to change when nothing can be', () => {
    render(<Queue items={[message('a', 'first thing')]} />);

    expect(screen.queryByLabelText('Take this back')).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Clear')).toBeNull();
  });

  it('takes one back', async () => {
    const onRemove = vi.fn();
    render(<Queue items={[message('a', 'first thing')]} onRemove={onRemove} />);

    await user.click(screen.getByLabelText('Take this back'));

    expect(onRemove).toHaveBeenCalledWith('a');
  });

  it('drops everything waiting', async () => {
    const onClear = vi.fn();
    render(<Queue items={[message('a', 'first'), message('b', 'second')]} onClear={onClear} />);

    await user.click(screen.getByText('Clear'));

    expect(onClear).toHaveBeenCalled();
  });

  it('rewrites one, keeping the words that were there to start from', async () => {
    const onEdit = vi.fn();
    render(<Queue items={[message('a', 'first thing')]} onEdit={onEdit} />);

    await user.click(screen.getByText('Edit'));
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.value).toBe('first thing');

    await user.clear(box);
    await user.type(box, 'something else{Enter}');

    expect(onEdit).toHaveBeenCalledWith('a', 'something else');
  });

  it('leaves it alone when the rewrite is abandoned', async () => {
    const onEdit = vi.fn();
    render(<Queue items={[message('a', 'first thing')]} onEdit={onEdit} />);

    await user.click(screen.getByText('Edit'));
    await user.type(screen.getByRole('textbox'), ' and more{Escape}');

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText('first thing')).toBeTruthy();
  });

  /** Emptying the box is the other way of saying you no longer want it. */
  it('takes one back when it is rewritten to nothing', async () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(<Queue items={[message('a', 'first thing')]} onEdit={onEdit} onRemove={onRemove} />);

    await user.click(screen.getByText('Edit'));
    await user.clear(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');

    expect(onRemove).toHaveBeenCalledWith('a');
    expect(onEdit).not.toHaveBeenCalled();
  });

  /** A queued command or a model change is not text somebody wrote, so there is nothing to rewrite. */
  it('does not offer to rewrite a queued command', () => {
    render(<Queue items={[{ id: 'c', kind: 'command', text: '/model' }]} onEdit={() => {}} onRemove={() => {}} />);

    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.getByLabelText('Take this back')).toBeTruthy();
  });

  it('moves one sooner and later, by where it is shown', async () => {
    const onMove = vi.fn();
    render(
      <Queue items={[message('a', 'first'), message('b', 'second'), message('c', 'third')]} onMove={onMove} />,
    );

    const sooner = screen.getAllByLabelText('Run this one sooner');
    const later = screen.getAllByLabelText('Run this one later');

    await user.click(sooner[2]!);
    expect(onMove).toHaveBeenCalledWith('c', 1);

    await user.click(later[0]!);
    expect(onMove).toHaveBeenCalledWith('a', 1);
  });

  it('cannot move the first one sooner or the last one later', () => {
    render(<Queue items={[message('a', 'first'), message('b', 'second')]} onMove={() => {}} />);

    expect((screen.getAllByLabelText('Run this one sooner')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByLabelText('Run this one later')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  /** Nowhere to move to, so the arrows would only ever be two disabled buttons. */
  it('offers no reordering for a queue of one', () => {
    render(<Queue items={[message('a', 'alone')]} onMove={() => {}} />);

    expect(screen.queryByLabelText('Run this one sooner')).toBeNull();
  });

  /**
   * The turn can take the entry being rewritten while somebody is still typing into it. The
   * box goes with the row it belongs to, so there is nothing left to save words into.
   */
  it('closes the box when the turn takes the entry being rewritten', async () => {
    const onEdit = vi.fn();
    const { rerender } = render(<Queue items={[message('a', 'first'), message('b', 'second')]} onEdit={onEdit} />);

    await user.click(screen.getAllByText('Edit')[0]!);
    expect(screen.getByRole('textbox')).toBeTruthy();

    rerender(<Queue items={[message('b', 'second')]} onEdit={onEdit} />);

    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
