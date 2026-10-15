import { useEffect, useRef } from 'react';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';

/**
 * Flash the taskbar when a session stops to ask something (#266).
 *
 * The one state that stops progress rather than reporting it. `useTaskbar` paints a bar
 * while a session works and deliberately leaves this out: waiting on a decision is more
 * urgent than progress, not a kind of it, and a permission request expires after five
 * minutes, so missing one costs a turn rather than a delay.
 *
 * `Critical` rather than `Informational`, because Windows flashes the window as well as the
 * taskbar button and keeps flashing until the app is in focus - which is how long the
 * session stays stopped. The API ignores the call outright when the app is already focused,
 * so there is nobody to tell and nothing to suppress here.
 *
 * That last part is why the count handed in is every session stopped on a question rather
 * than only the ones the reader is away from. Excluding the open session was tried and was
 * wrong: it is the one most likely to be asking, and from another window it is as invisible
 * as any other. Being able to see a session means being at the app, which the API already
 * checks better than this can.
 *
 * Only when the number rises, since a flash already running needs no restarting and the
 * count falling means one was answered rather than another arriving.
 */
export function useAttention(waiting: number): void {
  const before = useRef(0);

  useEffect(() => {
    const rose = waiting > before.current;
    // Only on the way down to nothing, so starting with nothing waiting says nothing at all.
    const settled = waiting === 0 && before.current > 0;
    before.current = waiting;

    // Unset explicitly rather than trusting the window manager, which the Tauri API warns
    // may leave the request standing even after the window takes input.
    const ask = rose ? UserAttentionType.Critical : settled ? null : undefined;
    if (ask === undefined) return;

    // Failure here is cosmetic - a platform with no taskbar, or a window already gone - and
    // an error banner over it would be worse than the missing flash.
    void getCurrentWindow()
      .requestUserAttention(ask)
      .catch(() => undefined);
  }, [waiting]);
}
