import type { SessionSummary } from '../../shared/protocol';

/**
 * Overlay previews taken from live events onto a freshly fetched list.
 *
 * Not a correction any more. Since #164 the sidecar reads previews from the event logs,
 * which trail the live stream by about nine milliseconds, so a fetch and an event agree on
 * what was said. What they disagree on is when: the sidebar is refetched only when the
 * history database changes, debounced by a second and a half, and nothing watches the logs.
 *
 * For a session this app holds open the reply is already here, so showing it at once is
 * free. Without the overlay a fetch landing between the reply and the write that announces
 * it would put the previous turn back on screen, which reads as the sidebar lagging.
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
