import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../shared/protocol';
import { orderSessions } from './ordering';

const session = (id: string, updatedAt: string, loaded = false): SessionSummary => ({
  sessionId: id,
  title: id,
  cwd: null,
  repository: null,
  branch: null,
  createdAt: updatedAt,
  updatedAt,
  loaded,
});

const ids = (list: SessionSummary[]) => list.map((s) => s.sessionId);

describe('orderSessions', () => {
  it('sorts inactive sessions by last use', () => {
    const list = [session('older', '2026-09-05 10:00:00'), session('newer', '2026-09-05 12:00:00')];
    expect(ids(orderSessions(list, []))).toEqual(['newer', 'older']);
  });

  it('groups active sessions above every inactive one', () => {
    const list = [
      session('stale-but-active', '2020-01-01 00:00:00', true),
      session('fresh-inactive', '2026-09-05 12:00:00'),
    ];
    expect(ids(orderSessions(list, ['stale-but-active']))).toEqual(['stale-but-active', 'fresh-inactive']);
  });

  it('orders the active group by activation rather than last use', () => {
    const list = [
      session('a', '2026-09-05 10:00:00', true),
      session('b', '2026-09-05 11:00:00', true),
      session('c', '2026-09-05 09:00:00'),
    ];
    expect(ids(orderSessions(list, ['b', 'a']))).toEqual(['b', 'a', 'c']);
  });

  // The point of the whole grouping: positions must hold still while work happens,
  // otherwise "second from the top" means something different each time it is clicked.
  it('does not reorder the active group when a session is used', () => {
    const afterSend = [
      session('a', '2026-09-05 13:00:00', true),
      session('b', '2026-09-05 11:00:00', true),
      session('c', '2026-09-05 09:00:00'),
    ];
    expect(ids(orderSessions(afterSend, ['b', 'a']))).toEqual(['b', 'a', 'c']);
  });

  it('puts a newly activated session at the top of the group', () => {
    const list = [
      session('a', '2026-09-05 13:00:00', true),
      session('b', '2026-09-05 11:00:00', true),
      session('c', '2026-09-05 09:00:00'),
      session('d', '2026-09-05 08:00:00', true),
    ];
    expect(ids(orderSessions(list, ['d', 'b', 'a']))).toEqual(['d', 'b', 'a', 'c']);
  });

  it('keeps an active session with no known activation order last in the group', () => {
    const list = [
      session('ranked', '2026-09-05 10:00:00', true),
      session('unranked', '2026-09-05 12:00:00', true),
    ];
    expect(ids(orderSessions(list, ['ranked']))).toEqual(['ranked', 'unranked']);
  });

  it('reads SQLite timestamps as UTC even without a zone marker', () => {
    // '2026-09-05 12:00:00' is UTC; naive local parsing would misorder these.
    const list = [session('sqlite', '2026-09-05 12:00:00'), session('iso', '2026-09-05T11:59:00Z')];
    expect(ids(orderSessions(list, []))).toEqual(['sqlite', 'iso']);
  });
});
