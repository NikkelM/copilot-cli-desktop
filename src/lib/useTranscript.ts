import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getTranscript } from './sidecar';
import { appendLive, timelineOf, type TimelineEvent } from './timeline';

/** How many stopped replies to keep per session. Whole replies, so a few is enough. */
const MAX_ABANDONED = 20;

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
  /**
   * What each session's stopped turns had already said, by the abort that ended them.
   *
   * Kept here rather than in state because it outlives the live list it came from: this
   * hook stays mounted while the reader moves between sessions, and the text would
   * otherwise be gone the moment they looked away.
   */
  const abandoned = useRef(new Map<string, Map<string, string>>());

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
  const loadOlder = useCallback(() => {    if (!sessionId || olderCursor === null) return;

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
    // Captured here rather than read inside the updater below, which React may run later
    // and more than once: the session on screen at that point is not necessarily the one
    // this event belongs to.
    const forSession = showing.current ?? '';

    // A stopped turn is the one case where what was on screen is not written down: the
    // runtime records streamed text only when a turn finishes. The text is moved out of the
    // live list and kept against the abort that ended it, so it survives leaving the
    // session and is shown in the same place on returning.
    if (event.type === 'abort' && event.id) {
      const abortId = event.id;
      setLive((current) => {
        const said = partOf(current);
        if (!said) return current;

        const kept = abandoned.current.get(forSession) ?? new Map<string, string>();
        kept.set(abortId, said.text);
        // Only the last few are worth keeping: they are whole replies, and a session
        // stopped a hundred times would otherwise hold a hundred of them for as long as
        // the app is open.
        while (kept.size > MAX_ABANDONED) kept.delete(kept.keys().next().value!);
        abandoned.current.set(forSession, kept);

        return current.filter((entry) => entry !== said.entry);
      });
    }

    setLive((current) => appendLive(current, event));
  }, []);

  /**
   * Show a prompt before the runtime has echoed it back. Resuming a cold session takes
   * seconds, and a prompt that appears only after that looks like it was not sent.
   */
  const showSent = useCallback((prompt: string) => {
    setLive((current) => [
      ...current,
      {
        type: 'user.message',
        data: { content: prompt },
        id: crypto.randomUUID(),
        // Stamped here so it is not the one untimed row until the runtime echoes it back.
        timestamp: new Date().toISOString(),
        local: true,
      },
    ]);
  }, []);

  const events = useMemo(() => timelineOf(history, live), [history, live]);

  return {
    events,
    hasOlder: olderCursor !== null,
    loadingOlder,
    loadOlder,
    push,
    showSent,
    abandoned: abandoned.current.get(sessionId ?? ''),
  };
}

/**
 * The reply being streamed when a turn was stopped, if there was one.
 *
 * A reply in flight is a single folded run of deltas at the end of the live list. Once the
 * turn ends normally the runtime sends the whole message and the run is replaced, so a run
 * still standing is one that will never be completed.
 */
function partOf(live: TimelineEvent[]): { entry: TimelineEvent; text: string } | null {
  for (let index = live.length - 1; index >= 0; index--) {
    const entry = live[index]!;
    if (entry.type !== 'assistant.message_delta') continue;

    const text = (entry.data as { deltaContent?: unknown } | null)?.deltaContent;
    return typeof text === 'string' && text.length > 0 ? { entry, text } : null;
  }
  return null;
}
