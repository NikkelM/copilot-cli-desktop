import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { explain } from './errors';
import { getTranscript } from './sidecar';
import { appendLive, timelineOf, type TimelineEvent } from './timeline';

/** How many stopped replies to keep per session. Whole replies, so a few is enough. */
const MAX_ABANDONED = 20;

/**
 * Events per page, both for opening a session and for reaching back through it.
 *
 * Smaller than the sidecar's own cap of 500, because the cost of a transcript is not the
 * DOM it makes - 500 events is 112 entries and about 1100 nodes, which is nothing - but the
 * markdown parsed to build it, at roughly 9ms per kilobyte. Measured on a real session, 500
 * events took 288ms to render and 100 took 31ms, of which about half was markdown.
 *
 * 150 is a few screens of conversation: enough that opening a session does not immediately
 * ration the reader, and little enough that it appears at once. Reaching further back is
 * already handled by scrolling up, so nothing is lost by asking for less to begin with.
 */
const PAGE_EVENTS = 150;

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
  /**
   * The page this session opened with, so reaching back can be undone.
   *
   * Its size is how much history to keep, and its cursor is where to start reading again.
   * Recorded rather than recomputed because the opening page is not always `PAGE_EVENTS`
   * long - a short session gives back everything it has.
   */
  const [opening, setOpening] = useState<{ count: number; cursor: number | null } | null>(null);

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
    setOpening(null);

    // Selecting elsewhere, or React running this effect twice, leaves a reply in flight
    // that describes a transcript no longer on screen.
    let current = true;
    getTranscript(sessionId, PAGE_EVENTS)
      .then((result) => {
        if (!current) return;
        setHistory(result.events);
        setOlderCursor(result.nextBefore);
        setOpening({ count: result.events.length, cursor: result.nextBefore });
      })
      .catch((e: unknown) => current && report.current(explain(e)));

    return () => {
      current = false;
    };
  }, [sessionId]);

  /** Fetch the page before the events already held and prepend it. */
  const loadOlder = useCallback(() => {
    if (!sessionId || olderCursor === null) return;

    setLoadingOlder(true);
    getTranscript(sessionId, PAGE_EVENTS, olderCursor)
      .then((result) => {
        // A page fetched for one session must not be spliced into another's transcript.
        if (showing.current !== sessionId) return;
        setHistory((current) => [...result.events, ...current]);
        setOlderCursor(result.nextBefore);
      })
      .catch((e: unknown) => report.current(explain(e)))
      .finally(() => setLoadingOlder(false));
  }, [sessionId, olderCursor]);

  /** Everything reached by scrolling up, beyond the page the session opened with. */
  const extraPages = opening !== null && history.length > opening.count;

  /**
   * Give back the history that was reached by scrolling up.
   *
   * Every row on screen is walked on every streamed chunk, so pages read and left behind
   * are charged for on each one afterwards: measured on a real session, twenty pages back
   * takes a chunk from 4ms to 27ms, and eighty takes it to 152ms. The reader accepted a
   * slow scroll, not a slow conversation for as long as they stay in the session.
   *
   * Only the pages loaded by reaching back go: the page the session opened with stays, so
   * this is never visible as the transcript getting shorter than it started. Scrolling up
   * fetches them again from the cursor they came from.
   */
  const dropOlder = useCallback(() => {
    // A page in flight was fetched to sit above history that is about to be discarded, and
    // would land as a run of events with a hole beneath it.
    if (!opening || loadingOlder) return;

    setHistory((current) => (current.length > opening.count ? current.slice(-opening.count) : current));
    setOlderCursor(opening.cursor);
  }, [opening, loadingOlder]);

  /**
   * Record an event from the running session.
   *
   * A subagent's work is kept, not dropped: it is nested inside the row that delegated it,
   * so a delegating turn can be watched as it happens rather than reported once it is over.
   * What decides where it goes is `toEntries`, which has the delegation to hang it on (#11).
   */
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
   *
   * Hands back the row's id so a send that then fails can take it away again.
   */
  const showSent = useCallback((prompt: string) => {
    const id = crypto.randomUUID();
    setLive((current) => [
      ...current,
      {
        type: 'user.message',
        data: { content: prompt },
        id,
        // Stamped here so it is not the one untimed row until the runtime echoes it back.
        timestamp: new Date().toISOString(),
        local: true,
      },
    ]);
    return id;
  }, []);

  /**
   * Take back a row this session put there itself.
   *
   * Only ever used to undo an optimistic prompt whose send failed: a row the runtime sent
   * is a record of something that happened, and is not ours to remove.
   */
  const remove = useCallback((id: string) => {
    setLive((current) => current.filter((event) => event.id !== id));
  }, []);

  /**
   * Put a row in the transcript that no event will ever bring.
   *
   * A slash command's output is returned to whoever ran it and written down nowhere, so
   * this is the only place it can exist. It lasts as long as the session stays open, which
   * matches the CLI: its command output does not survive a restart either.
   */
  const showLocal = useCallback((type: string, data: unknown) => {
    setLive((current) => [
      ...current,
      { type, data, id: crypto.randomUUID(), timestamp: new Date().toISOString(), local: true },
    ]);
  }, []);

  const events = useMemo(() => timelineOf(history, live), [history, live]);

  return {
    events,
    hasOlder: olderCursor !== null,
    loadingOlder,
    loadOlder,
    extraPages,
    dropOlder,
    push,
    showSent,
    showLocal,
    remove,
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
