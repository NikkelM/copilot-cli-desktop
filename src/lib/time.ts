/** How the parts of an elapsed time are named, smallest first. */
const UNITS: [limit: number, divisor: number, label: string][] = [
  [60_000, 1000, 's'],
  [3_600_000, 60_000, 'm'],
  [86_400_000, 3_600_000, 'h'],
];

/** Past this, "312d ago" says less than a date does. */
const OLD_MS = 7 * 86_400_000;

/**
 * Times written the way they are usually read: SQLite's own format has no zone marker.
 *
 * The session store writes `YYYY-MM-DD HH:MM:SS` in UTC, while the event log writes ISO
 * with a Z. Reading one as the other puts a session hours out, so both are accepted here
 * rather than in each caller.
 */
function parse(iso: string): number {
  const normalised = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  return new Date(normalised).getTime();
}

/**
 * How long ago something was, in the coarsest terms that still say something.
 *
 * Relative while that is useful, and a date once it is not: a week in, knowing a session
 * was touched 312 days ago is worth less than knowing it was in November.
 */
export function formatRelative(iso: string): string {
  const elapsed = Date.now() - parse(iso);
  if (!Number.isFinite(elapsed)) return '';
  if (elapsed < 0) return 'just now';

  for (const [limit, divisor, label] of UNITS) {
    if (elapsed < limit) return `${Math.max(1, Math.floor(elapsed / divisor))}${label} ago`;
  }

  if (elapsed < OLD_MS) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(parse(iso)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * When something was said, as a clock reads.
 *
 * "2h ago" is the right shape for a list of sessions, where what matters is which was
 * touched most recently. Inside a session it is the wrong one: the transcript is already in
 * order, and what a reader wants from a line is when it happened, not how long ago.
 */
export function formatClock(iso: string): string {
  const at = parse(iso);
  if (!Number.isFinite(at)) return '';

  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The moment itself, for a reader who wants to know exactly.
 *
 * The clock says nothing about the day, and a session can run over several.
 */
export function formatExact(iso: string): string {
  const at = parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : '';
}

/** How old something is, for anyone deciding whether it is still worth following. */
export function ageOf(iso: string): number {
  return Date.now() - parse(iso);
}

/**
 * A duration, as an action's own length rather than as a time of day.
 *
 * Seconds up to a minute and minutes and seconds past it, which is how long-running work
 * is talked about: "1m 19s", not "79 seconds" and not "00:01:19".
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
