/**
 * How many sessions are stopped waiting on an answer, and a way to reach them.
 *
 * A status is read by someone already looking at the row. This is the alert: it has to reach
 * someone who is not, because the agent is stopped until it is answered and a permission
 * request expires after five minutes. Missing it costs a turn rather than a delay (#187).
 *
 * Drawn only when something is waiting. A count that reads zero most of the time is one the
 * reader stops seeing, which is the opposite of what it is for.
 */
export function Waiting({ count, onJump }: { count: number; onJump: () => void }) {
  if (count === 0) return null;

  return (
    <button
      type="button"
      className="waiting-count"
      onClick={onJump}
      title={count === 1 ? 'Go to the session waiting for an answer' : 'Go to the next session waiting for an answer'}
    >
      {/* The same warning square the rows use, so the count and the row it leads to are
          recognisably about the same thing. */}
      <span className="activity activity-blocked" aria-hidden />
      {count} waiting
    </button>
  );
}
