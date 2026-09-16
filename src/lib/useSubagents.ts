import { useCallback, useRef, useState } from 'react';

import { subagentNameIn } from './timeline';
import { appendLive } from './timeline';
import type { TranscriptEvent } from '../../shared/protocol';

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
  const [watched, setWatched] = useState<WatchedSubagent[]>([]);
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
   */
  const forget = useCallback((sessionId: string) => {
    promptsIn.current.delete(sessionId);
    for (const [agentId, finished] of finishedAt.current) {
      if (finished.sessionId === sessionId) finishedAt.current.delete(agentId);
    }
    setWatched((current) => {
      const kept = current.filter((entry) => entry.sessionId !== sessionId);
      return kept.length === current.length ? current : kept;
    });
  }, []);

  /** Take one off the list, for a reader who is done with it before this app decides. */
  const dismiss = useCallback((agentId: string) => {
    finishedAt.current.delete(agentId);
    setWatched((current) => current.filter((entry) => entry.agentId !== agentId));
  }, []);

  const find = useCallback(
    (agentId: string | null) => (agentId ? (watched.find((entry) => entry.agentId === agentId) ?? null) : null),
    [watched],
  );

  return { watched, observe, forget, dismiss, find };
}
