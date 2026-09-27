import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { explain } from './errors';
import { getTranscript } from './sidecar';
import { appendLive, timelineOf, type TimelineEvent } from './timeline';
import { showsInTranscript } from '../../shared/protocol';

/**
 * How many stopped replies to keep per session. Whole replies, so a few is enough.
 *
 * Dropping the oldest past this is not a loss of something that would otherwise have been
 * kept: the CLI keeps none at all. Measured across twelve real logs and 24,783 events, no
 * `assistant.message_delta` is ever written to disk - only the finished `assistant.message`
 * is - and every abort in them is preceded by `assistant.turn_start` with nothing between.
 * Whatever the model had said by then is gone the moment the CLI's own session is resumed.
 *
 * So this window already keeps more than the tool it wraps, and the cap bounds an extra
 * rather than discarding a record. Writing them to disk would mean this app becoming the
 * only place text the CLI deliberately does not keep is kept, which is a decision about
 * what a session is rather than a bug to fix.
 */
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
/** A page that belongs to no session, so nothing is ever drawn under the wrong one. */
const NO_PAGE: { of: string | null; events: TimelineEvent[] } = { of: null, events: [] };

export function useTranscript(sessionId: string | null, onError: (message: string) => void, openAt?: number | null) {
  /**
   * The replayed page, and which session it is a page of.
   *
   * The two are held together rather than cleared by an effect, because an effect runs after
   * the render that changed the session - so for one render the previous conversation was on
   * screen under the new one's name. Everything downstream believed it: a search result
   * looked for its words in the session before, found them or gave up there, and had already
   * answered by the time the right page arrived.
   */
  const [held, setHeld] = useState(NO_PAGE);
  const history = held.of === sessionId ? held.events : NO_PAGE.events;
  /**
   * Everything since the session was selected, which no replay may overwrite.
   *
   * Tied to its session for the same reason the page is: cleared in an effect, it stayed on
   * screen for the render after the session changed, and anything reading the transcript in
   * that render read the conversation before this one.
   */
  const [liveHeld, setLiveHeld] = useState(NO_PAGE);
  const live = liveHeld.of === sessionId ? liveHeld.events : NO_PAGE.events;
  const setLive = useCallback(
    (next: TimelineEvent[] | ((current: TimelineEvent[]) => TimelineEvent[])) => {
      setLiveHeld((current) => {
        const held = current.of === showing.current ? current.events : NO_PAGE.events;
        return { of: showing.current, events: typeof next === 'function' ? next(held) : next };
      });
    },
    [],
  );
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
  /**
   * Whether the CLI could open this session again, which it cannot when the log no longer
   * begins where a run does.
   *
   * Starts true, so a session being read is not accused of having lost its history in the
   * moment before its log has been looked at.
   */
  const [reopenable, setReopenable] = useState(true);

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

  /**
   * Bumped to read the log again from the start.
   *
   * A number rather than the caller holding a flag, because it goes in the effect's
   * dependencies: anything with an identity would re-run it on every render.
   *
   * Wanted when the log stops being what this app last read - which a rewind does on
   * purpose, discarding turns the transcript is still showing (#156).
   */
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((count) => count + 1), []);

  // Selecting a session only replays its log from disk; nothing is resumed until the
  // user sends a message, which is what keeps idle sessions free.
  useEffect(() => {
    if (!sessionId) return;
    // The page itself is already disowned by the render that changed the session; this is
    // what lets go of the memory it was holding.
    setHeld(NO_PAGE);
    setLive([]);
    setOlderCursor(null);
    setOpening(null);
    setReopenable(true);

    // Selecting elsewhere, or React running this effect twice, leaves a reply in flight
    // that describes a transcript no longer on screen.
    let current = true;
    // A cursor opens the session partway back, at a turn somebody went looking for. Without
    // one it opens where a session is normally read from, which is the end.
    getTranscript(sessionId, PAGE_EVENTS, openAt ?? undefined)
      .then((result) => {
        if (!current) return;
        setHeld({ of: sessionId, events: result.events });
        setOlderCursor(result.nextBefore);
        setOpening({ count: result.events.length, cursor: result.nextBefore });
        // Absent means a sidecar that predates the question, which is not an answer of no.
        setReopenable(result.reopenable !== false);
      })
      .catch((e: unknown) => current && report.current(explain(e)));

    return () => {
      current = false;
    };
  }, [sessionId, openAt, reloads]);

  /** Fetch the page before the events already held and prepend it. */
  const loadOlder = useCallback(() => {
    if (!sessionId || olderCursor === null) return;

    setLoadingOlder(true);
    getTranscript(sessionId, PAGE_EVENTS, olderCursor)
      .then((result) => {
        // A page fetched for one session must not be spliced into another's transcript.
        if (showing.current !== sessionId) return;
        setHeld((current) => ({ of: sessionId, events: [...result.events, ...current.events] }));
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

    setHeld((current) => ({
      of: current.of,
      events: current.events.length > opening.count ? current.events.slice(-opening.count) : current.events,
    }));
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
    /**
     * Held only if the transcript shows it.
     *
     * A sitting only ever appends to this list, so whatever it holds is held for as long as
     * the session stays open. Roughly three in five of the events a long session receives
     * are turn markers, hook markers and session bookkeeping that the transcript has no row
     * for: about 2 kB each, walked on every streamed chunk, and drawn never.
     *
     * `showsInTranscript` rather than a list of its own, because the sidecar already reads
     * history through it. Two lists would mean live and history held different things: a
     * `session.plan_changed` arriving here would be kept forever while the same event read
     * back from the log never was.
     *
     * Dropped where the transcript decides what to keep rather than on arrival, so they are
     * still delivered and still read as they pass - the busy clock starts on
     * `assistant.turn_start` and the Send button waits for it. Every other observer has
     * already seen this event by the time it reaches here, which is why this call is last.
     *
     * Rows this app invents are not pushed, so none of them comes through here.
     */
    if (!showsInTranscript(event.type)) return;

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
        // Oldest first, and see MAX_ABANDONED for why losing one is not losing a record.
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
    reload,
    reopenable,
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
