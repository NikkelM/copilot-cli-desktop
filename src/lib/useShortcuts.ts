import { useEffect, useRef } from 'react';

/** How long a second Escape still counts as part of the first. */
const DOUBLE_ESCAPE_MS = 800;

export type Shortcut = 'interrupt' | 'escape-twice' | 'help';

export interface Binding {
  id: Shortcut;
  /** As a reader would press it, for the list they can call up. */
  keys: string;
  what: string;
}

/**
 * Every shortcut there is, in one list.
 *
 * The list the reader sees is built from this rather than written beside it, so a shortcut
 * cannot exist without being documented, or be documented without existing. Unlike the CLI
 * there is no status line to put a hint in, which makes the list the only way to find them.
 */
export const BINDINGS: readonly Binding[] = [
  { id: 'escape-twice', keys: 'Esc Esc', what: 'Stop the turn, or clear what is written' },
  { id: 'interrupt', keys: 'Ctrl+C', what: 'Stop the turn' },
  { id: 'help', keys: 'F1 or ?', what: 'Show these shortcuts' },
];

/** Whether a key press belongs to whatever is being typed into. */
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;

  return (
    element.isContentEditable ||
    // The attribute as well as the property: text inside an editable region is being typed
    // into even though the element receiving the key is not itself the editable one.
    Boolean(element.closest?.('[contenteditable=""], [contenteditable="true"]')) ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT'
  );
}

/**
 * The keys a terminal reflex expects to work.
 *
 * This app replaces a terminal, and the muscle memory comes with the reader: reaching for
 * the mouse to stop a turn is the moment they notice they have left the terminal behind.
 * Bound on the window rather than on a component, so they work wherever the focus happens
 * to be - including inside the composer for the ones that make sense there.
 */
export function useShortcuts(on: (shortcut: Shortcut) => void) {
  // Held in refs so a caller passing a fresh function does not re-register the listener,
  // and so the double-press window survives a render.
  const handler = useRef(on);
  handler.current = on;
  const lastEscape = useRef(0);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A prompt or a menu that is open owns Escape: dismissing it is what the reader
      // means, not stopping the turn behind it.
      if (event.defaultPrevented) return;

      if (event.key === 'Escape') {
        const now = Date.now();
        const again = now - lastEscape.current < DOUBLE_ESCAPE_MS;
        lastEscape.current = again ? 0 : now;

        // One Escape is how a menu closes and how a field is left, so only the second does
        // anything: the same layering the CLI uses.
        if (again) handler.current('escape-twice');
        return;
      }

      if (event.key === 'c' && event.ctrlKey && !event.shiftKey && !event.altKey) {
        // Ctrl+C is copy first. Taking it from a reader with something selected would lose
        // them the thing they were copying, which is worse than making them press Stop.
        if (!window.getSelection()?.toString()) {
          event.preventDefault();
          handler.current('interrupt');
        }
        return;
      }

      // The composer holds the keyboard whenever a session is open, so a plain question
      // mark is usually just a question mark. F1 works wherever the focus is and on any
      // layout - Ctrl+/ would be Ctrl+Shift+7 on a German keyboard - and the bare key is
      // there for when nothing is being typed into.
      if (event.key === 'F1' || (event.key === '?' && !typing(event.target))) {
        event.preventDefault();
        handler.current('help');
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
