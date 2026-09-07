// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Elapsed } from './Elapsed';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

afterEach(() => vi.useRealTimers());

describe('Elapsed', () => {
  // A duration that appears, says "1s" and vanishes is noise, not information.
  it('says nothing about something that has barely started', () => {
    const { container } = render(<Elapsed since={ago(500)} />);
    expect(container.textContent).toBe('');
  });

  it('says how long something has been going', () => {
    render(<Elapsed since={ago(79_000)} />);
    expect(screen.getByText('1m 19s')).toBeTruthy();
  });

  // The point of the whole thing: a slow command should feel like progress, not a hang.
  it('counts up while it runs', () => {
    vi.useFakeTimers();
    render(<Elapsed since={ago(10_000)} />);
    expect(screen.getByText('10s')).toBeTruthy();

    act(() => void vi.advanceTimersByTime(3000));

    expect(screen.getByText('13s')).toBeTruthy();
  });

  // Knowing a command took two minutes is worth as much after it finished as during.
  it('keeps the length of something already over', () => {
    const started = new Date(Date.now() - 300_000).toISOString();
    const ended = new Date(Date.now() - 200_000).toISOString();

    render(<Elapsed since={started} until={ended} />);

    expect(screen.getByText('1m 40s')).toBeTruthy();
  });

  // An interrupted call has no completion of its own, and a timer left running on one
  // would count for as long as the transcript stayed open.
  it('does not tick once it has ended', () => {
    vi.useFakeTimers();
    const started = new Date(Date.now() - 60_000).toISOString();
    const ended = new Date(Date.now() - 30_000).toISOString();
    render(<Elapsed since={started} until={ended} />);

    act(() => void vi.advanceTimersByTime(10_000));

    expect(screen.getByText('30s')).toBeTruthy();
  });

  it('says nothing about something that never started', () => {
    const { container } = render(<Elapsed />);
    expect(container.textContent).toBe('');
  });
});
