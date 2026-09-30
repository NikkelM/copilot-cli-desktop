import { useCallback, useRef, useState } from 'react';

import { getAgentTranscript } from './sidecar';
import { useKeptSubagents } from './useKeptSubagents';
import { subagentNameIn } from './timeline';
import { appendLive } from './timeline';
import { showsInTranscript, type TranscriptEvent } from '../../shared/protocol';

/**
 * How many prompts a finished subagent survives before it stops being offered.
 *
 * A delegated task is interesting while it runs and for as long afterwards as its answer is
 * still what the conversation is about. Two prompts later it rarely is, and the sidebar is
 * worth more as a short list of what is happening now than as a complete archive of what
 * once did.
 *
 * Counted only once the subagent has finished. A running one never expires, however long
 * the reader spends typing at it.
 */
const PROMPTS_BEFORE_STALE = 3;

/** A subagent this app watched start, and what it has done since. */
export interface WatchedSubagent {
  /** The runtime's id for the agent instance, which is this entry's identity. */
  agentId: string;
  /** The session that delegated the work. */
  sessionId: string;
  /** What the agent is called, from the announcement that started it. */
  name: string;
  startedAt?: string;
  /** Absent while it is still working. */
  outcome?: 'completed' | 'failed';
  /** Its own events, by reference: the same objects the transcript holds, not copies. */
  events: TranscriptEvent[];
  /**
   * Whether the log has been shown to hold this run, so the events above were let go.
   *
   * What makes an entry survive its session. Until this is true the entry is the only
   * copy of its work; after it, the entry is a name and two ids.
   */
  onDisk?: boolean;
}

/**
 * The subagents this app has watched start, for the sidebar to offer.
 *
 * Deliberately only those. Finding the subagents already in a session's log means reading
 * the whole log - measured at 2.1 seconds for one 386 MB session, against 204 sessions on
 * this machine - and browsing must not cost that. A tail read is affordable but finds a
 * fraction of them, because a session's delegations are spread through the file rather than
 * gathered at the end: 47 of 257 in one log even at a 32 MB window.
 *
 * So this holds what it saw happen. Nothing is read from disk, and a subagent that ran
 * before the app opened is not offered rather than offered slowly (#178).
 *
 * The events are references to the objects the transcript already holds, so a subagent
 * costs its entry rather than a second copy of its work.
 */
export function useSubagents() {
  const keeping = useKeptSubagents();
  /**
   * What is watched, seeded with what was kept (#180).
   *
   * A kept task is offered again from what was written down about it rather than from what
   * this app saw happen, which is how one survives a restart at all. Its work is not here:
   * that is read from the log when the task is opened, and is why keeping one is cheap.
   */
  const [watched, setWatched] = useState<WatchedSubagent[]>(() =>
    keeping.kept.map((entry) => ({ ...entry, events: [], onDisk: true })),
  );
  /** Which delegated task is being read in place of its session, if any. */
  const [openId, setOpenId] = useState<string | null>(null);
  /** Each watched task's session, for the handlers that run outside a render. */
  const ofSession = useRef(new Map<string, string>());

  /** Stop reading a delegated task and go back to the session that delegated it. */
  const close = useCallback(() => setOpenId(null), []);
  /**
   * How many prompts each session has seen, and the count each finished subagent finished
   * at. Staleness is the difference, which makes it a subtraction rather than a tally that
   * has to be kept up to date.
   *
   * Outside React state, because counting in state would rewrite every entry on every
   * prompt - a redraw of the sidebar to record something no row is showing. Both are
   * written from the event handler itself rather than from inside a state updater: React
   * invokes an updater twice under StrictMode and may replay one from a discarded render,
   * and an increment written there is applied each time. That alone made three prompts
   * behave as two in every development session.
   */
  const promptsIn = useRef(new Map<string, number>());
  const finishedAt = useRef(new Map<string, { sessionId: string; at: number }>());
  /** Whose work the log has been shown to hold, readable outside a render like the rest. */
  const settled = useRef(new Set<string>());
  /** The list as it is now, for the handlers and reads that run outside a render. */
  const watchedNow = useRef<WatchedSubagent[]>([]);
  /** Which tasks were asked for, readable from the handlers that run outside a render. */
  const keptNow = useRef(new Set<string>());

  /**
   * Hand a finished run over to the log, once the log can be shown to have it (#178).
   *
   * A subagent's work is the largest thing this list holds - one real run comes to 3.3 MB -
   * and a session that delegates all day holds every one of them. None of it is this app's
   * to keep: the log has it, and reading a run back takes about five milliseconds because a
   * run is contiguous and near the end of the file.
   *
   * Only against proof. The read has to come back with the announcement that opened the run
   * and with at least as much as is being held, so letting go is never a guess about
   * whether the writing has landed. Anything short of that keeps what it has and tries
   * again the next time the run finishes, which for a run that finishes once is never - the
   * cost of being wrong here is memory, and the cost of being wrong the other way is a
   * transcript nobody can read.
   */
  const settle = useCallback(async (sessionId: string, agentId: string) => {
    let stored: TranscriptEvent[];
    try {
      stored = (await getAgentTranscript(sessionId, agentId)).events;
    } catch {
      return;
    }

    const held = watchedNow.current.find((entry) => entry.agentId === agentId);
    if (!held || !stored.some((event) => event.type === 'subagent.started')) return;

    /*
     * Counted against what the log is able to hold, not against everything watched.
     *
     * The live stream carries the run's whole machinery - how it was configured, when each
     * turn began and ended - and the log carries only what a transcript draws. Comparing
     * one to the other asked whether ten was at least twenty-two, so the answer was always
     * no and a finished run could never be handed over (#180).
     */
    const drawable = held.events.filter((event) => showsInTranscript(event.type)).length;
    if (stored.length < drawable) return;

    settled.current.add(agentId);
    setWatched((current) =>
      current.map((entry) => (entry.agentId === agentId ? { ...entry, events: [], onDisk: true } : entry)),
    );
  }, []);

  watchedNow.current = watched;
  keptNow.current = new Set(keeping.kept.map((entry) => entry.agentId));

  /** Take a session event, and keep whatever it says about a subagent. */
  const observe = useCallback((sessionId: string, event: TranscriptEvent) => {
    const name = subagentNameIn(event);
    if (name && event.agentId) {
      const agentId = event.agentId;
      finishedAt.current.delete(agentId);
      setWatched((current) =>
        current.some((entry) => entry.agentId === agentId)
          ? current
          : [...current, { agentId, sessionId, name, startedAt: event.timestamp, events: [] }],
      );
      return;
    }

    if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
      const agentId = event.agentId;
      if (!agentId) return;
      const outcome = event.type === 'subagent.completed' ? 'completed' : 'failed';
      // The prompt it finished on, so the prompts after it can be counted by subtraction.
      finishedAt.current.set(agentId, { sessionId, at: promptsIn.current.get(sessionId) ?? 0 });
      setWatched((current) =>
        current.map((entry) => (entry.agentId === agentId ? { ...entry, outcome } : entry)),
      );
      // A finished run is not going to change, so the log is free to be the one that keeps
      // it (#178).
      void settle(sessionId, agentId);
      return;
    }

    /**
     * A prompt the reader sent, which ages the tasks that are already done.
     *
     * Only the session's own: a prompt carrying an agentId is the instruction a subagent was
     * given, and counting it would age the very task it started.
     */
    if (event.type === 'user.message' && !event.agentId) {
      const seen = (promptsIn.current.get(sessionId) ?? 0) + 1;
      promptsIn.current.set(sessionId, seen);

      setWatched((current) => {
        const kept = current.filter((entry) => {
          // Asked for, so it stays until it is explicitly let go (#180).
          if (keptNow.current.has(entry.agentId)) return true;
          if (entry.sessionId !== sessionId || !entry.outcome) return true;
          return seen - (finishedAt.current.get(entry.agentId)?.at ?? seen) < PROMPTS_BEFORE_STALE;
        });
        return kept.length === current.length ? current : kept;
      });
      return;
    }

    // Everything else a subagent produced is its work, kept so its timeline can be shown
    // without going back to disk for what this app already has in hand.
    //
    // Folded the way the transcript folds it. A reply arrives as hundreds of deltas and
    // then once more in full; appending them raw left each chunk as an event of its own,
    // which drew a row per fragment and made a four-hundred-word answer several hundred
    // rows to build. The same function the transcript uses, so the two cannot disagree
    // about what a reply looks like.
    if (event.agentId) {
      const agentId = event.agentId;
      setWatched((current) =>
        current.map((entry) =>
          entry.agentId === agentId ? { ...entry, events: appendLive(entry.events, event) } : entry,
        ),
      );
    }
  }, []);

  /**
   * Let a session's subagents go when the session itself is let go.
   *
   * Their work only exists here while it is held: nothing was read from disk to build it,
   * and an entry outliving the session would offer a transcript this app can no longer
   * produce.
   *
   * Closes the open view only when the session that goes is the one it belongs to. Closing
   * on any unload shut the transcript someone was reading because an unrelated session
   * aged out, which is the bug this pair of concerns produced while they lived apart.
   */
  /**
   * Let a session's subagents go when the session itself is let go.
   *
   * Only the ones this app is still the only copy of. A run the log has been shown to hold
   * outlives its session, because the transcript it offers can be produced again from disk
   * (#178) - which is the difference between a list of what is happening and a list of what
   * happened.
   *
   * Closes the open view only when the session that goes is the one it belongs to, and only
   * when what it was reading went with it. Closing on any unload shut the transcript
   * someone was reading because an unrelated session aged out, which is the bug this pair
   * of concerns produced while they lived apart.
   */
  const forget = useCallback((sessionId: string) => {
    promptsIn.current.delete(sessionId);

    // Decided from the refs rather than from `watched`, which this handler may have closed
    // over a render ago, and computed outside the updater because React runs updaters twice
    // under StrictMode.
    const gone = [...ofSession.current]
      .filter(([agentId, of]) => of === sessionId && !settled.current.has(agentId) && !keptNow.current.has(agentId))
      .map(([agentId]) => agentId);

    for (const agentId of gone) {
      finishedAt.current.delete(agentId);
      ofSession.current.delete(agentId);
    }
    setOpenId((open) => (open && gone.includes(open) ? null : open));
    setWatched((current) => {
      const kept = current.filter((entry) => !gone.includes(entry.agentId));
      return kept.length === current.length ? current : kept;
    });
  }, []);

  /**
   * Hide one, for a reader who is done with it before this app decides.
   *
   * The row and nothing else. A task's work is in the session's log either way, and stays
   * readable inside the row that delegated it, so this takes away where it was listed
   * rather than what it did.
   */
  const dismiss = useCallback(
    (agentId: string) => {
      finishedAt.current.delete(agentId);
      setOpenId((current) => (current === agentId ? null : current));
      setWatched((current) => current.filter((entry) => entry.agentId !== agentId));
      // Dismissing one that was being kept is the plainest way of saying to stop keeping it.
      keeping.drop(agentId);
    },
    [keeping],
  );

  /**
   * Ask for a task to be kept, or let a kept one go (#180).
   *
   * Only once the log has been shown to hold its work. Before that this app is the task's
   * only copy, so keeping it would mean keeping its events in memory indefinitely and
   * coming back after a restart to a row that opens onto nothing.
   */
  const keep = useCallback(
    (agentId: string) => {
      const entry = watchedNow.current.find((each) => each.agentId === agentId);
      if (!entry || !entry.onDisk) return;

      keeping.toggle({
        agentId,
        sessionId: entry.sessionId,
        name: entry.name,
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
      });
    },
    [keeping],
  );

  /** Whether a task can be asked for, which is what the sidebar offers the button on. */
  const keepable = useCallback((agentId: string) => {
    const entry = watchedNow.current.find((each) => each.agentId === agentId);
    return Boolean(entry?.onDisk);
  }, []);

  const find = useCallback(
    (agentId: string | null) => (agentId ? (watched.find((entry) => entry.agentId === agentId) ?? null) : null),
    [watched],
  );

  /** The delegated task being read, or nothing when the session itself is on screen. */
  const open = find(openId);

  /**
   * Which session the open task belongs to, readable without waiting for a render.
   *
   * `forget` runs from an event handler, where the `watched` list closed over by this
   * render may already be a version behind the entry being asked about.
   */
  ofSession.current = new Map(watched.map((entry) => [entry.agentId, entry.sessionId]));

  return {
    watched,
    observe,
    forget,
    dismiss,
    find,
    open,
    openId,
    setOpenId,
    close,
    keep,
    keepable,
    isKept: keeping.isKept,
  };
}
