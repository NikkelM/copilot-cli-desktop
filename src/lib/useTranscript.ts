import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getTranscript } from './sidecar';
import { appendLive, timelineOf, type TimelineEvent } from './timeline';

/**
 * The transcript of one session: what is on disk, and what has happened since.
 *
 * Replaying history and receiving live events are separate concerns that used to share a
 * list, which let a slow replay overwrite the events that arrived while it was in flight.
 * Keeping them apart is the whole point, so they are kept apart here rather than in a
 * component with a dozen other things to think about.
 */
export function useTranscript(sessionId: string | null, onError: (message: string) => void) {
  /** Replayed from the log. Replaced wholesale by a fetch, so nothing live lives here. */
  const [history, setHistory] = useState<TimelineEvent[]>([]);
  /** Everything since the session was selected, which no replay may overwrite. */
  const [live, setLive] = useState<TimelineEvent[]>([]);
  /** Cursor for the page before the events held, or null at the start of the log. */
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Held in refs so a caller passing a fresh function, or changing session, does not
  // restart the effects below.
  const report = useRef(onError);
  report.current = onError;
  const showing = useRef(sessionId);
  showing.current = sessionId;

  // Selecting a session only replays its log from disk; nothing is resumed until the
  // user sends a message, which is what keeps idle sessions free.
  useEffect(() => {
    if (!sessionId) return;
    setHistory([]);
    setLive([]);
    setOlderCursor(null);

    // Selecting elsewhere, or React running this effect twice, leaves a reply in flight
    // that describes a transcript no longer on screen.
    let current = true;
    getTranscript(sessionId)
      .then((result) => {
        if (!current) return;
        setHistory(result.events);
        setOlderCursor(result.nextBefore);
      })
      .catch((e: unknown) => current && report.current(String(e)));

    return () => {
      current = false;
    };
  }, [sessionId]);

  /** Fetch the page before the events already held and prepend it. */
  const loadOlder = useCallback(() => {
    if (!sessionId || olderCursor === null) return;

    setLoadingOlder(true);
    getTranscript(sessionId, undefined, olderCursor)
      .then((result) => {
        // A page fetched for one session must not be spliced into another's transcript.
        if (showing.current !== sessionId) return;
        setHistory((current) => [...result.events, ...current]);
        setOlderCursor(result.nextBefore);
      })
      .catch((e: unknown) => report.current(String(e)))
      .finally(() => setLoadingOlder(false));
  }, [sessionId, olderCursor]);

  /** Record an event from the running session. */
  const push = useCallback((event: TimelineEvent) => {
    setLive((current) => appendLive(current, event));
  }, []);

  /**
   * Show a prompt before the runtime has echoed it back. Resuming a cold session takes
   * seconds, and a prompt that appears only after that looks like it was not sent.
   */
  const showSent = useCallback((prompt: string) => {
    setLive((current) => [
      ...current,
      { type: 'user.message', data: { content: prompt }, id: crypto.randomUUID(), local: true },
    ]);
  }, []);

  const events = useMemo(() => timelineOf(history, live), [history, live]);

  return { events, hasOlder: olderCursor !== null, loadingOlder, loadOlder, push, showSent };
}
