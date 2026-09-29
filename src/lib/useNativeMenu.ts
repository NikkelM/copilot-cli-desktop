import { useEffect } from 'react';

/**
 * Whether the browser's own menu is the right answer for what was right-clicked.
 *
 * Two cases, and both are about text. A field being typed in needs cut, copy, paste and
 * select-all, and a hand-rolled replacement for those is worse than the one the platform
 * already draws. Text that has been selected anywhere else needs copy for the same reason.
 *
 * Everything else is this app's own furniture, where the menu offers Back and Refresh -
 * which navigate or reload the window out from under a running session - alongside Save as,
 * Print and Inspect.
 */
function wantsNativeMenu(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;

  // Disabled and read-only fields included on purpose: neither can be typed in, but both
  // can be read, and reading is what copy is for.
  if (element.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return true;

  return (globalThis.getSelection?.()?.toString().trim().length ?? 0) > 0;
}

/**
 * Keep the webview's own context menu to the places it belongs (#226).
 *
 * The menu WebView2 draws is a browser's: Back, Refresh, Save as, Print, Inspect. None of
 * that describes this app, and the first two are actively dangerous - a reload takes the
 * window away from whatever session was running in it.
 *
 * Refused by default and allowed by exception, rather than the other way round. A new panel
 * then cannot forget to turn it off, and the exception lives in the one place the menu is
 * genuinely wanted.
 *
 * On the document rather than on each element, because this is about everywhere that has
 * not asked for something else. A component with a menu of its own prevents the event
 * before this sees it, which is what the session rows already do.
 */
export function useNativeMenu(): void {
  useEffect(() => {
    const decide = (event: MouseEvent) => {
      if (!wantsNativeMenu(event.target)) event.preventDefault();
    };

    document.addEventListener('contextmenu', decide);
    return () => document.removeEventListener('contextmenu', decide);
  }, []);
}
