import { useEffect } from 'react';
import { getCurrentWindow, ProgressBarStatus } from '@tauri-apps/api/window';

/**
 * Paint the taskbar button while a session is working, as the CLI does.
 *
 * A session left to work looked exactly like one sitting idle, so the only way to know it
 * had finished was to keep looking at it. A moving bar under the icon says "still going"
 * at a glance, from any other window.
 *
 * Indeterminate, which is the honest status for work of unknown length and the one the CLI
 * asks for: its bundle sends `ESC ] 9;4;3;0 BEL`, the OSC 9;4 progress sequence in state 3,
 * which a terminal turns into the same Win32 call this makes (#272).
 *
 * This was a full Normal bar at first, on a measurement that Windows 11 drew nothing at all
 * for indeterminate. That was wrong - the CLI animates one on the same machine. What it was
 * really hitting is below.
 *
 * No `progress` alongside it, which is not a detail. `tao` sets the state and then, only if
 * a progress value was given, calls `SetProgressValue` - and a value sets the state back to
 * a normal filled bar, which is exactly the solid bar this was trying to stop drawing. A
 * marquee has no value to show, so there is none to send.
 *
 * Any session, not the open one: with several loaded the useful reading is whether the app
 * owes the reader nothing yet, and a bar that cleared on switching sessions would say the
 * opposite. Waiting on a decision is deliberately not included - it is more urgent than
 * progress, not a kind of it, and wants an alert rather than a bar (#85).
 */
export function useTaskbar(working: boolean, wanted = true): void {
  useEffect(() => {
    // The CLI has a switch for this and paints the same button, so a reader who turned it
    // off there meant both rather than only the one they happened to turn it off in.
    const paint = working && wanted;
    // Failure here is cosmetic - a platform without a taskbar, or a window already gone -
    // and an error banner over it would be worse than the missing bar.
    void getCurrentWindow()
      .setProgressBar({ status: paint ? ProgressBarStatus.Indeterminate : ProgressBarStatus.None })
      .catch(() => undefined);
  }, [working, wanted]);
}
