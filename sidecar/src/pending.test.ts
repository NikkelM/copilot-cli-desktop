import { describe, expect, it, vi } from 'vitest';

import { PendingRequests } from './pending.js';

describe('PendingRequests', () => {
  it('settles a request with the answer given', async () => {
    const pending = new PendingRequests<string>('t', () => 60_000, () => 'timeout');
    const { requestId, answered } = pending.add('session-a');

    expect(pending.settle(requestId, 'answered')).toBe('session-a');
    await expect(answered).resolves.toBe('answered');
  });

  it('ignores a second answer to the same request', async () => {
    const pending = new PendingRequests<string>('t', () => 60_000, () => 'timeout');
    const { requestId, answered } = pending.add('session-a');

    pending.settle(requestId, 'first');
    expect(pending.settle(requestId, 'second')).toBeNull();
    await expect(answered).resolves.toBe('first');
  });

  /**
   * An answered request leaves nothing behind. The stale timer would do no harm when it
   * fired - there is no entry left to settle - but it holds its closure until it does, and
   * a long session answers a great many of these.
   */
  it('drops the timer of a request that was answered', () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingRequests<string>('t', () => 60_000, () => 'timeout');
      const { requestId } = pending.add('session-a');
      expect(vi.getTimerCount()).toBe(1);

      pending.settle(requestId, 'answered');

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on its own rather than blocking forever', async () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingRequests<string>('t', () => 1000, () => 'timeout');
      const { answered } = pending.add('session-a');

      vi.advanceTimersByTime(1000);
      await expect(answered).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  // The agent blocks on these promises, so a torn-down session must not leave one open.
  it('abandons only the requests belonging to one session', async () => {
    const pending = new PendingRequests<string>('t', () => 60_000, () => 'timeout');
    const a = pending.add('session-a');
    const b = pending.add('session-b');

    const abandoned = pending.abandon('session-a', 'gone');

    expect(abandoned).toEqual([a.requestId]);
    await expect(a.answered).resolves.toBe('gone');

    pending.settle(b.requestId, 'still answerable');
    await expect(b.answered).resolves.toBe('still answerable');
  });

  it('gives each request a distinct prefixed id', () => {
    const pending = new PendingRequests<string>('perm', () => 60_000, () => 'timeout');
    const first = pending.add('s');
    const second = pending.add('s');

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId.startsWith('perm-')).toBe(true);
  });
});


/**
 * When a request lapses, reported so the prompt can warn before it does (#70). Only this
 * class knows the deadline, since only it owns the timer.
 */
describe('when a request lapses', () => {
  it('reports the deadline it was registered with', () => {
    const pending = new PendingRequests<string>('perm', () => 5000, () => 'gave up');
    const before = Date.now();

    const { expiresAt } = pending.add('session-a');

    const at = new Date(expiresAt!).getTime();
    expect(at).toBeGreaterThanOrEqual(before + 5000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('gives each request its own deadline', async () => {
    vi.useFakeTimers();
    const pending = new PendingRequests<string>('perm', () => 5000, () => 'gave up');

    const first = pending.add('session-a');
    vi.advanceTimersByTime(2000);
    const second = pending.add('session-a');

    expect(new Date(second.expiresAt!).getTime() - new Date(first.expiresAt!).getTime()).toBe(2000);
    vi.useRealTimers();
  });

  /**
   * The wait is asked for per request rather than kept, so a reader who changes it while
   * something is already waiting is answered on the next question rather than the next
   * sidecar. What is already waiting keeps the deadline it was given: the prompt says when
   * it lapses, and moving that afterwards would make the countdown a lie.
   */
  it('asks how long to wait each time rather than once', () => {
    vi.useFakeTimers();
    let wait = 5000;
    const pending = new PendingRequests<string>('perm', () => wait, () => 'gave up');
    const first = pending.add('session-a');

    wait = 60_000;
    const second = pending.add('session-a');

    expect(new Date(second.expiresAt!).getTime() - new Date(first.expiresAt!).getTime()).toBe(55_000);
    vi.useRealTimers();
  });
});

/**
 * No wait at all is a real answer: somebody who would rather come back to a question than
 * to a decision made on their behalf has said so, and the agent waits for them.
 */
describe('when there is no wait', () => {
  it('never gives up on its own', async () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingRequests<string>('t', () => 0, () => 'gave up');
      const { answered } = pending.add('session-a');
      let settled: string | null = null;
      void answered.then((value) => (settled = value));

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(settled).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers no deadline to count down to', () => {
    const pending = new PendingRequests<string>('t', () => 0, () => 'gave up');

    expect(pending.add('session-a').expiresAt).toBeNull();
  });

  it('still answers when somebody does', async () => {
    const pending = new PendingRequests<string>('t', () => 0, () => 'gave up');
    const { requestId, answered } = pending.add('session-a');

    pending.settle(requestId, 'answered');

    await expect(answered).resolves.toBe('answered');
  });

  /** Tearing a session down must not leave the agent blocked, wait or no wait. */
  it('still lets go when the session goes', async () => {
    const pending = new PendingRequests<string>('t', () => 0, () => 'gave up');
    const { answered } = pending.add('session-a');

    pending.abandon('session-a', 'abandoned');

    await expect(answered).resolves.toBe('abandoned');
  });
});
