import { useEffect, useRef, useState } from 'react';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

import type { Unseen } from './useUnseen';

/** A session wanting the reader, named so a notification can say which one. */
export interface Wanted {
  sessionId: string;
  mark: Unseen;
  /** What the sidebar calls it, or nothing for a session that was never titled. */
  title: string | null;
}

/** What a notification says happened, in the words the sidebar uses for the same marks. */
const SAYS: Record<Unseen, string> = {
  blocked: 'Waiting for an answer',
  finished: 'Finished, and the reply is waiting',
  failed: 'Ended in an error',
};

/** One session and one state, which is what a reader is told about at most once. */
const told = (wanted: Wanted) => `${wanted.sessionId}:${wanted.mark}`;

/**
 * Say which session wants the reader, over whatever is on screen (#268).
 *
 * The only surface here that works while the window is behind something else: a flash and a
 * count on the icon both need the taskbar to be looked at, and neither says which session
 * or what happened.
 *
 * Once per session and state, not once per render and not once per event. A session that
 * stops being wanted and is wanted again later is a new thing to say, so the record is the
 * set of what is currently owed rather than everything ever said - which also keeps it from
 * growing for the life of the app.
 */
export function useNotify(wanted: readonly Wanted[]): void {
  /**
   * What the reader has already been told, as session and state.
   *
   * Starts holding whatever was wanted when the app opened, so a session that was already
   * blocked does not announce itself at startup as though it had just happened.
   */
  const already = useRef<Set<string> | null>(null);

  /**
   * Whether anything may be said at all.
   *
   * State rather than a ref, so the moment permission arrives counts as a change worth
   * looking again on. A ref would leave the first pass running before the answer is in and
   * never running again, which quietly drops anything that happened while it was being
   * asked - and would leave the rule below defended by that timing rather than by itself.
   */
  const [allowed, setAllowed] = useState(false);

  // Asked once, on the way in. A reader who said no is not asked again every time a session
  // finishes, and `sendNotification` on a refusal is a call that quietly does nothing.
  useEffect(() => {
    void (async () => {
      setAllowed((await isPermissionGranted()) || (await requestPermission()) === 'granted');
    })().catch(() => undefined);
  }, []);

  useEffect(() => {
    const now = new Set(wanted.map(told));

    // The first pass only learns what was already true, so nothing is announced for a state
    // the app merely found on opening. Before the permission check rather than after: what
    // was owed on arrival is old news whether or not anything may be said about it yet.
    if (already.current === null) {
      already.current = now;
      return;
    }

    /*
     * Nothing is said, and nothing is written down, until permission is settled.
     *
     * Returning without recording is the point. Asking can put a prompt in front of the
     * reader and wait there for as long as they ignore it, and sessions do not wait with
     * it: anything that starts wanting something meanwhile would otherwise be marked as
     * told, and then never told, because by the time it may be said it looks like old news.
     */
    if (!allowed) return;

    for (const each of wanted) {
      if (already.current.has(told(each))) continue;
      // Failure is swallowed: a notification that does not arrive is worth less than the
      // turn it would interrupt to report.
      try {
        sendNotification({ title: each.title ?? 'Untitled session', body: SAYS[each.mark] });
      } catch {
        // A platform with no notifications, or a refusal that arrived late.
      }
    }

    already.current = now;
  }, [wanted, allowed]);
}
