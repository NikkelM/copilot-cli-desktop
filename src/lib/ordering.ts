import type { SessionSummary } from '../../shared/protocol';

/**
 * Order the sidebar so positions stay predictable while sessions are in use.
 *
 * Active sessions are grouped at the top with no inactive ones between them, and keep a
 * fixed relative order: sending a message must not shuffle the list, otherwise "second
 * from the top" means something different from one moment to the next. A session that
 * becomes active enters at the top of that group, which is the only time the group
 * reorders. Everything else is sorted by last use, which does change as work happens.
 *
 * @param activeOrder session ids in activation order, most recently activated first
 */
export function orderSessions(sessions: SessionSummary[], activeOrder: string[]): SessionSummary[] {
  const rank = new Map(activeOrder.map((id, index) => [id, index]));

  const active: SessionSummary[] = [];
  const rest: SessionSummary[] = [];

  for (const session of sessions) {
    // `loaded` is authoritative; activeOrder only decides position within the group.
    (session.loaded ? active : rest).push(session);
  }

  active.sort((a, b) => {
    const left = rank.get(a.sessionId);
    const right = rank.get(b.sessionId);
    // A session loaded before this client saw it activate has no rank; keep it last.
    if (left === undefined && right === undefined) return byLastUsed(a, b);
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });

  rest.sort(byLastUsed);
  return [...active, ...rest];
}

function byLastUsed(a: SessionSummary, b: SessionSummary): number {
  return toTime(b.updatedAt) - toTime(a.updatedAt);
}

/** SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC without a zone marker, so make it explicit. */
export function toTime(value: string): number {
  const normalised = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalised).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
