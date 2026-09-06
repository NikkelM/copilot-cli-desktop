// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Queue } from './Queue';

describe('Queue', () => {
  // The row is a frame around messages; with none it is a frame around nothing.
  it('shows nothing when nothing is waiting', () => {
    const { container } = render(<Queue messages={[]} />);
    expect(container.textContent).toBe('');
  });

  it('lists what is waiting, in the order it will be sent', () => {
    render(
      <Queue
        messages={[
          { id: 'a', prompt: 'first thing' },
          { id: 'b', prompt: 'second thing' },
        ]}
      />,
    );

    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items[0]).toContain('first thing');
    expect(items[1]).toContain('second thing');
  });

  // Which one goes next is the only ordering worth showing.
  it('marks the one that goes next', () => {
    render(
      <Queue
        messages={[
          { id: 'a', prompt: 'first thing' },
          { id: 'b', prompt: 'second thing' },
        ]}
      />,
    );

    expect(screen.getAllByRole('listitem')[0].textContent).toContain('Next');
    expect(screen.getAllByRole('listitem')[1].textContent).toContain('2');
  });

  it('says how many are waiting', () => {
    render(<Queue messages={[{ id: 'a', prompt: 'one' }]} />);
    expect(screen.getByText(/1 queued/)).toBeTruthy();
  });
});
