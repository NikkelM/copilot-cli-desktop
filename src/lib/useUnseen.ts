import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { TranscriptEvent } from '../../shared/protocol';
import type { Blocking } from './activity';

/**
 * What a session did that the reader has not seen (#265).
 *
 * Distinct from `Activity`, which answers what a session is doing *now*. A session that
 * finished an hour ago is `idle`, and so is one that has sat untouched for a week - the
 * present tense cannot tell them apart, and every surface under #85 needs exactly that
 * difference. `failed` is not in the activity model at all: a turn that ends in
 * `session.error` reads as idle the moment it stops.
 */
export type Unseen = 'finished' | 'failed' | 'blocked';

/** What a turn left behind, which is remembered. Being blocked is read, not remembered. */
type Ended = 'finished' | 'failed';

export interface UnseenMarks {
  /** What each session did unseen. Sessions with nothing to report are absent. */
  marks: Readonly<Record<string, Unseen>>;
  /**
   * Take a session's event, whichever session it belongs to.
   *
   * Registered once by `App` and never handed over again, so this keeps one identity for
   * the life of the app and reads the session on screen from a ref rather than a dependency.
   */
  observe: (sessionId: string, event: TranscriptEvent) => void;
  /** Drop a session that no longer exists, so its mark does not outlive it. */
  forget: (sessionId: string) => void;
}

/**
 * Remember what happened in the sessions the reader was not looking at.
 *
 * Three marks, each answering "does this session want you, and why", for a reader who is
 * somewhere else. Two of them are remembered and one is read:
 *
 * - `finished` and `failed` are recorded when a turn ends, because a reply goes on waiting
 *   whether or not anything else happens afterwards. Looking at the session forgets it.
 * - `blocked` is taken from the prompts still outstanding rather than stored, because the
 *   prompts are the truth about what is owed. A question answered from another window stops
 *   blocking without the session saying so, and a remembered mark would outlast it.
 *
 * The epic's rule lives here rather than in each surface: the session on screen never
 * carries a mark, because the reader can see it. Holding that in one place is what keeps
 * the taskbar, the sidebar and any notification from disagreeing about what counts as seen.
 */
/**
 * What the mark says when hovered, and what a reader is told it means.
 *
 * Only the two that are drawn: being blocked is already on the row as an activity dot, since
 * a session cannot be blocked without being loaded - releasing one abandons its prompts.
 */
export function describeUnseen(mark: Unseen): string | null {
  switch (mark) {
    case 'finished':
      return 'Finished while you were elsewhere. The reply is waiting';
    case 'failed':
      return 'Ended in an error while you were elsewhere';
    default:
      return null;
  }
}

export function useUnseen(selectedId: string | null, blocking: readonly Blocking[]): UnseenMarks {
  const [ended, setEnded] = useState<Record<string, Ended>>({});

  // Read by `observe` rather than closed over, which is what lets `observe` keep one
  // identity: `App` subscribes once and would otherwise hold the session that was open
  // when it started, for ever.
  const showing = useRef(selectedId);
  showing.current = selectedId;

  /**
   * Sessions with a turn in flight, so an ending can be told from a session merely settling.
   *
   * Without this every resume would report a finish: the runtime says `session.idle` when a
   * session settles and not only when it has been working, and a sidebar that marks every
   * session the reader opens is saying nothing at all.
   */
  const turning = useRef(new Set<string>());

  const observe = useCallback((sessionId: string, event: TranscriptEvent) => {
    if (event.type === 'assistant.turn_start') {
      turning.current.add(sessionId);
      return;
    }

    // A stopped turn is not a reply to collect, so it ends the flight without marking.
    if (event.type === 'abort') {
      turning.current.delete(sessionId);
      return;
    }

    // An error ends the turn as surely as an idle does, and is worth telling apart from a
    // plain finish, so it is taken whether or not a turn was seen to start.
    const mark: Ended | undefined =
      event.type === 'session.error'
        ? 'failed'
        : event.type === 'session.idle' && turning.current.has(sessionId)
          ? 'finished'
          : undefined;
    if (!mark) return;

    turning.current.delete(sessionId);
    // Nothing is recorded against the session being read, which is what the rule means at
    // the moment a turn ends under the reader's eyes.
    if (sessionId === showing.current) return;

    // A failure outranks a finish, so an error is not buried by whatever settles after it.
    setEnded((current) => (current[sessionId] === 'failed' ? current : { ...current, [sessionId]: mark }));
  }, []);

  const drop = useCallback((sessionId: string) => {
    setEnded((current) => {
      if (!(sessionId in current)) return current;
      const { [sessionId]: _gone, ...rest } = current;
      return rest;
    });
  }, []);

  // Looking at a session is what makes it seen. Before paint rather than after, so a
  // session selected while it carried a mark does not show it for the frame in between.
  useLayoutEffect(() => {
    if (selectedId) drop(selectedId);
  }, [selectedId, drop]);

  const forget = useCallback(
    (sessionId: string) => {
      turning.current.delete(sessionId);
      drop(sessionId);
    },
    [drop],
  );

  /**
   * A session is shown what it did unseen, and being blocked is read from what is still
   * owed rather than from anything remembered.
   */
  const marks = useMemo(() => {
    const all: Record<string, Unseen> = { ...ended };
    // Last, and so winning: being stopped is the one that asks something of the reader now,
    // and a session that finished a turn and then asked a question is asking a question.
    for (const { sessionId } of blocking) {
      if (sessionId !== selectedId) all[sessionId] = 'blocked';
    }
    return all;
  }, [ended, blocking, selectedId]);

  return { marks, observe, forget };
}
