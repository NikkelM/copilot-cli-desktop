import { describe, expect, it, vi } from 'vitest';

import { PendingRequests } from './pending.js';

describe('PendingRequests', () => {
  it('settles a request with the answer given', async () => {
    const pending = new PendingRequests<string>('t', 60_000, () => 'timeout');
    const { requestId, answered } = pending.add('session-a');

    expect(pending.settle(requestId, 'answered')).toBe('session-a');
    await expect(answered).resolves.toBe('answered');
  });

  it('ignores a second answer to the same request', async () => {
    const pending = new PendingRequests<string>('t', 60_000, () => 'timeout');
    const { requestId, answered } = pending.add('session-a');

    pending.settle(requestId, 'first');
    expect(pending.settle(requestId, 'second')).toBeNull();
    await expect(answered).resolves.toBe('first');
  });

  it('gives up on its own rather than blocking forever', async () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingRequests<string>('t', 1000, () => 'timeout');
      const { answered } = pending.add('session-a');

      vi.advanceTimersByTime(1000);
      await expect(answered).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  // The agent blocks on these promises, so a torn-down session must not leave one open.
  it('abandons only the requests belonging to one session', async () => {
    const pending = new PendingRequests<string>('t', 60_000, () => 'timeout');
    const a = pending.add('session-a');
    const b = pending.add('session-b');

    const abandoned = pending.abandon('session-a', 'gone');

    expect(abandoned).toEqual([a.requestId]);
    await expect(a.answered).resolves.toBe('gone');

    pending.settle(b.requestId, 'still answerable');
    await expect(b.answered).resolves.toBe('still answerable');
  });

  it('gives each request a distinct prefixed id', () => {
    const pending = new PendingRequests<string>('perm', 60_000, () => 'timeout');
    const first = pending.add('s');
    const second = pending.add('s');

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId.startsWith('perm-')).toBe(true);
  });
});
