// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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