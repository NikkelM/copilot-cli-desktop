import type { SessionSummary } from '../../shared/protocol';

/**
 * Overlay previews taken from live events onto a freshly fetched list.
 *
 * The sidecar reads previews from the `turns` table, which is flushed well after the
 * fact: for a session this app holds open, the newest turn was measured minutes behind.
 * The app sees that session's events as they happen, so for a loaded session it is the
 * authority on what was last said. Without this merge the refetch, which fires on every
 * store change, would immediately put the stale text back.
 *
 * Only the preview is overridden. `updatedAt` comes from the event log's mtime and is
 * already accurate; the two values are not measured against the same clock, so comparing
 * them to pick a winner gives the wrong answer.
 *
 * The caller drops entries when a session unloads, which is what stops an override
 * outliving the app's knowledge of that session.
 */
export function mergeLivePreviews(
  sessions: SessionSummary[],
  live: ReadonlyMap<string, string | null>,
): SessionSummary[] {
  if (live.size === 0) return sessions;

  return sessions.map((session) =>
    live.has(session.sessionId)
      ? { ...session, preview: live.get(session.sessionId) ?? null }
      : session,
  );
}
