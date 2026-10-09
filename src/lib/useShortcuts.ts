import { useEffect, useRef } from 'react';

import { useHotGeneration } from './hotGeneration';

/** How long a second Escape still counts as part of the first. */
const DOUBLE_ESCAPE_MS = 800;

export type Shortcut =
  | 'interrupt'
  | 'escape-twice'
  | 'help'
  | 'reasoning'
  | 'stash'
  | 'larger'
  | 'smaller'
  | 'reset-size'
  | 'sidebar'
  | 'new-session'
  | 'find-session'
  | 'go-sessions'
  | 'go-composer'
  | 'wiki'
  | 'import'
  | 'next-region'
  | 'previous-region';

/**
 * Where ctrl and shift and a letter go.
 *
 * Gathered rather than written as a chain of questions, because there are now enough of them
 * that the chain was longer than the rest of the handler. The letter is read folded to lower
 * case, since shift is what makes it upper.
 */
const GOES_TO: Record<string, Shortcut> = {
  p: 'find-session',
  s: 'go-sessions',
  m: 'go-composer',
  k: 'wiki',
  o: 'import',
};

export interface Binding {
  /**
   * Set when this hook is what implements the key.
   *
   * Absent for the ones the composer or the menu owns. The reader does not care which part
   * of the app answers a key, so the list covers all of them - but only this hook's can be
   * held to reporting a `Shortcut`.
   */
  id?: Shortcut;
  /** As a reader would press it, for the list they can call up. */
  keys: string;
  what: string;
}

/**
 * Every key worth telling someone about, in one list.
 *
 * The list the reader sees is built from this rather than written beside it, so a key cannot
 * be described here without working. Unlike the CLI there is no status line to put a hint
 * in, which makes the list the only way to find them.
 *
 * Two things are deliberately absent. Ordinary text editing, because a text box already has
 * what this platform uses - the CLI documents ctrl+a and ctrl+e only for want of a terminal
 * that provides them. And plain navigation - Tab, a single Escape - which is what a list on
 * screen already invites; a reference that spends its rows on them buries the keys nothing
 * else would reveal.
 *
 * The arrows are listed even so, because stepping through history is not what an arrow does
 * anywhere else, and ctrl+u and ctrl+k because readline gives them and a textarea does not.
 *
 * Worded and ordered as the CLI words and orders its own, down to the lower case, so the two
 * read as one tool.
 */
export const BINDINGS: readonly Binding[] = [
  { keys: '/help', what: 'show full help' },
  { id: 'help', keys: '?', what: 'show quick help' },
  { keys: '/', what: 'commands' },
  { id: 'interrupt', keys: 'ctrl+c', what: 'cancel' },
  { id: 'escape-twice', keys: 'esc esc', what: 'clear input or interrupt' },
  { id: 'reasoning', keys: 'ctrl+t', what: 'show or hide reasoning' },
  { id: 'stash', keys: 'ctrl+s', what: 'stash or pop the prompt' },
  { id: 'larger', keys: 'ctrl+plus', what: 'draw everything larger' },
  { id: 'smaller', keys: 'ctrl+minus', what: 'draw everything smaller' },
  { id: 'reset-size', keys: 'ctrl+0', what: 'back to the default size' },
  { id: 'sidebar', keys: 'ctrl+b', what: 'show or hide the sidebar' },
  { id: 'new-session', keys: 'ctrl+n', what: 'start a new session' },
  { id: 'find-session', keys: 'ctrl+shift+p', what: 'find a session' },
  { id: 'go-sessions', keys: 'ctrl+shift+s', what: 'go to the session list' },
  { id: 'go-composer', keys: 'ctrl+shift+m', what: 'go to the message box' },
  { id: 'wiki', keys: 'ctrl+shift+k', what: 'browse your knowledge base' },
  { id: 'import', keys: 'ctrl+shift+o', what: 'import a session' },
  { id: 'next-region', keys: 'f6', what: 'next part of the window' },
  { id: 'previous-region', keys: 'shift+f6', what: 'previous part of the window' },
  { keys: 'ctrl+wheel', what: 'draw everything larger or smaller' },
  /*
   * The CLI asks for this with shift+tab, which here would mean giving up the one key that
   * walks backwards out of the composer. The CLI has a prompt to leave; this has a window to
   * walk, and taking the key back is worth more than matching it.
   */
  { keys: 'alt+m', what: 'switch modes' },
  { keys: 'ctrl+shift+a', what: 'attach files' },
  { keys: 'shift+enter', what: 'insert newline' },
  { keys: 'up/down', what: 'previous or next prompt' },
  { keys: 'ctrl+r', what: 'reverse search history' },
  { keys: 'alt+left', what: 'back a page in the wiki' },
  { keys: 'ctrl+u', what: 'delete to start of line' },
  { keys: 'ctrl+k', what: 'delete to end of line' },
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
 * Whether nothing has been written yet, so a key pressed now is the first character.
 *
 * The composer holds the keyboard whenever a session is open, so a shortcut that refuses to
 * fire while a field has focus would be unreachable almost all of the time. A question mark
 * as the first character is a question nobody asks, which is what makes it safe to claim -
 * the same reasoning the CLI applies to its own leading keys.
 *
 * The caller is asked before the field itself, because the caller holds the text and the
 * field is only where it is being shown.
 */
function nothingWritten(target: EventTarget | null, writing?: () => string): boolean {
  if (writing) return writing().length === 0;

  const field = target as HTMLInputElement | HTMLTextAreaElement | null;
  // A menu has a value but nothing is being typed into it, so it is never "the first
  // character" of anything.
  if (field?.tagName !== 'INPUT' && field?.tagName !== 'TEXTAREA') return false;

  return field.value.length === 0;
}

/**
 * The keys a terminal reflex expects to work.
 *
 * This app replaces a terminal, and the muscle memory comes with the reader: reaching for
 * the mouse to stop a turn is the moment they notice they have left the terminal behind.
 * Bound on the window rather than on a component, so they work wherever the focus happens
 * to be - including inside the composer for the ones that make sense there.
 *
 * @param writing what has been typed but not sent, since the app knows that better than the
 *   field does: a shortcut that has to sniff the DOM for it is guessing.
 */
export function useShortcuts(on: (shortcut: Shortcut) => void, writing?: () => string) {
  // Held in refs so a caller passing a fresh function does not re-register the listener,
  // and so the double-press window survives a render.
  const handler = useRef(on);
  handler.current = on;
  const written = useRef(writing);
  written.current = writing;
  const lastEscape = useRef(0);
  /**
   * Re-registers the listeners after every hot update, and never in a built app.
   *
   * Without it an edit to a key is replaced in the module, re-rendered, and left out of the
   * effect - so the listener still answering the keyboard is the one from before the edit.
   * A wheel listener added this way appeared to do nothing at all until the app was
   * restarted, which is the same false trail #181 recorded for Tauri events.
   */
  const hot = useHotGeneration();

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
        if (again) {
          handler.current('escape-twice');
          return;
        }

        // A first Escape from anywhere else is the way back to what was being written, which
        // is where a reader who has finished looking around wants to be. Inside the box it
        // means the double press, so there it is left to the second. A menu or a prompt that
        // wanted this press has already taken it, above.
        const held = event.target as HTMLElement | null;
        if (!held?.closest?.('[data-region="composer"]')) handler.current('go-composer');
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

      // Fired even while typing, since it changes what is on screen rather than what is
      // being written, and a terminal answers it wherever the cursor is.
      if (event.key === 't' && event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        handler.current('reasoning');
        return;
      }

      // Fired while typing like ctrl+t, and for the same reason: it changes how the app is
      // drawn rather than what is being written. Both the main row and the numeric keypad
      // are answered, and `=` is taken as plus because that is the unshifted key every
      // browser and editor accepts for this - requiring shift would be the odd one out.
      if (event.ctrlKey && !event.altKey) {
        const zoom =
          event.key === '+' || event.key === '=' || event.code === 'NumpadAdd'
            ? 'larger'
            : event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract'
              ? 'smaller'
              : event.key === '0' || event.code === 'Numpad0'
                ? 'reset-size'
                : null;

        if (zoom) {
          // The webview's own zoom would otherwise fire as well, which scales the app a
          // second time on top of this one and cannot be put back by ctrl+0 alone.
          event.preventDefault();
          handler.current(zoom);
          return;
        }
      }

      // Fired while typing for the same reason the others are: it changes how the app is
      // drawn rather than what is being written. Ctrl+B is what editors use for this.
      if (event.key === 'b' && event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        handler.current('sidebar');
        return;
      }

      // Moving about the window. Claimed whatever has the keyboard, because the whole point
      // of them is to be reachable from inside the box that currently holds it - and
      // prevented, since ctrl+n is the webview's own "new window" and f6 is the address bar.
      if (event.key === 'F6') {
        event.preventDefault();
        handler.current(event.shiftKey ? 'previous-region' : 'next-region');
        return;
      }

      if (event.ctrlKey && !event.altKey) {
        // Shift makes the letter upper case, which is why these are read folded rather than
        // listed twice - and why none of them can be confused with the composer's own
        // readline keys, where `k` and `u` are the unshifted ones.
        const letter = event.key.toLowerCase();
        const going = event.shiftKey ? GOES_TO[letter] : letter === 'n' ? 'new-session' : undefined;

        if (going) {
          event.preventDefault();
          handler.current(going);
          return;
        }
      }

      // Only useful while typing, so it has to fire there. Prevented in any case: the
      // webview would otherwise offer to save the page, which is not a thing this app has.
      if (event.key === 's' && event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        handler.current('stash');
        return;
      }

      // The composer holds the keyboard whenever a session is open, so refusing to fire
      // while a field has focus would put this out of reach almost all of the time. A
      // question mark as the first character of a message is one nobody types, so it is
      // claimed - and swallowed, rather than left in the box behind the list.
      if (event.key === '?' && (!typing(event.target) || nothingWritten(event.target, written.current))) {
        event.preventDefault();
        handler.current('help');
      }
    }

    /**
     * Ctrl and the wheel, which is the other half of the same gesture.
     *
     * A trackpad pinch arrives here too, as a wheel event with ctrl held, so both are
     * answered by one listener. Registered as non-passive because the whole point is to
     * take the event: left alone the webview zooms itself, which scales the app a second
     * time on top of this one.
     */
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      handler.current(event.deltaY < 0 ? 'larger' : 'smaller');
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onWheel);
    };
    // Only the hot counter, which stands still outside development: the handlers are read
    // through refs, so nothing else this closure sees can go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hot]);
}




