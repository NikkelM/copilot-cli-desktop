import { useEffect } from 'react';
import { getCurrentWindow, ProgressBarStatus } from '@tauri-apps/api/window';

/**
 * Paint the taskbar button while a session is working, as the CLI does.
 *
 * A session left to work looked exactly like one sitting idle, so the only way to know it
 * had finished was to keep looking at it. A filled bar under the icon says "still going"
 * at a glance, from any other window.
 *
 * The honest status for work of unknown length is Indeterminate, but Windows 11 draws
 * nothing at all for it - verified by watching the button while unfocused, where the only
 * mark was the ordinary inactive dot. A full Normal bar is the loudest state that does
 * render, and since it is only ever on or off there is no progress to misread.
 *
 * Any session, not the open one: with several loaded the useful reading is whether the app
 * owes the reader nothing yet, and a bar that cleared on switching sessions would say the
 * opposite. Waiting on a decision is deliberately not included - it is more urgent than
 * progress, not a kind of it, and wants an alert rather than a bar (#85).
 */
export function useTaskbar(working: boolean): void {
  useEffect(() => {
    // Failure here is cosmetic - a platform without a taskbar, or a window already gone -
    // and an error banner over it would be worse than the missing bar.
    void getCurrentWindow()
      .setProgressBar(
        working
          ? { status: ProgressBarStatus.Normal, progress: 100 }
          : { status: ProgressBarStatus.None },
      )
      .catch(() => undefined);
  }, [working]);
}
