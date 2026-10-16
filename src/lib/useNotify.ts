import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

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
 * What the notification carries home, so a click knows which session it was about (#273).
 *
 * The runtime hands `extra` back verbatim on the click, which is why there is no table of
 * sent notifications here. Measured rather than assumed: a tap reported
 * `extra: {"sessionId":"a13395b7-…"}`, the same value that went out with it. The numeric
 * `id` the plugin also reports would have meant keeping a map from it to the session, and
 * bounding that map, for no gain.
 */
const SESSION = 'sessionId';

/** The action a click on the notification itself reports, as against one of its buttons. */
const TAP = 'tap';

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
 *
 * Clicking one opens the session it was about (#273). The listener lives here rather than
 * in the caller because the key under `extra` is written and read in this file, and a
 * contract with one end somewhere else is one that drifts.
 */
export function useNotify(wanted: readonly Wanted[], onOpen: (sessionId: string) => void | Promise<void>): void {
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

  /**
   * Held in a ref so the listener below is registered once and never again.
   *
   * Opening a session depends on the app's own state, so this callback changes identity on
   * every render that touches it. Re-subscribing on each of those would tear a plugin
   * listener down and build it again constantly, and a click landing in the gap is a click
   * nobody hears.
   */
  const open = useRef(onOpen);
  open.current = onOpen;

  /**
   * Take a click on a notification back to the session it was about (#273).
   *
   * The unregister is held behind a flag rather than awaited, because the cleanup can run
   * before the listener has finished registering - React mounts every effect twice in
   * development and does exactly that - and a cleanup that found nothing to drop would
   * leave a listener behind for the life of the app.
   */
  useEffect(() => {
    let live = true;
    let drop: (() => void) | undefined;

    void onAction((event) => {
      // Only the notification itself. Nothing here registers buttons, so any other action
      // is a kind this build does not know about and should not guess at.
      if (!live || event.actionId !== TAP) return;
      const sessionId = event.notification?.extra?.[SESSION];
      if (typeof sessionId !== 'string' || !sessionId.trim()) return;
      void (async () => {
        await open.current(sessionId);
        const window = getCurrentWindow();
        await window.unminimize();
        await window.show();
        await window.setFocus();
      })().catch((error: unknown) => console.error('Could not open the notification session', error));
    })
      .then((listener) => {
        if (live) drop = () => void listener.unregister();
        else void listener.unregister();
      })
      .catch((error: unknown) => console.error('Could not listen for notification clicks', error));

    return () => {
      live = false;
      drop?.();
    };
  }, []);

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
        sendNotification({
          title: each.title ?? 'Untitled session',
          body: SAYS[each.mark],
          // Handed back verbatim on a click, which is what makes the session findable.
          extra: { [SESSION]: each.sessionId },
        });
      } catch {
        // A platform with no notifications, or a refusal that arrived late.
      }
    }

    already.current = now;
  }, [wanted, allowed]);
}
