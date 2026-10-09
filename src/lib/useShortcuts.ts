import { useEffect, useMemo, useRef } from 'react';

import { chordsOf, type Overrides, type Shortcut } from './bindings';
import { matchesChord } from './chords';
import { useHotGeneration } from './hotGeneration';

export { BINDINGS, type Binding, type Shortcut } from './bindings';

/** How long a second Escape still counts as part of the first. */
const DOUBLE_ESCAPE_MS = 800;

/**
 * The two the composer answers itself.
 *
 * Both are about what is being written, and both have to reach the box without the window
 * taking the press first. They are rebindable with the rest because a reader cannot tell
 * which part of the app answers a key, and should not have to.
 */
const COMPOSER_OWNED: readonly Shortcut[] = ['cycle-mode', 'attach'];

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
 * Whether a shortcut should fire for this press, beyond the chord matching.
 *
 * Only two have anything more to ask. Everything else fires wherever the keyboard is, which
 * is the point of them: a key that works only outside the message box is a key that works
 * almost nowhere, since the box holds the keyboard whenever a session is open.
 */
function allowed(id: Shortcut, event: KeyboardEvent, writing?: () => string): boolean {
  // Copy first. Taking this from a reader with something selected would lose them the thing
  // they were copying, which is worse than making them press Stop.
  if (id === 'interrupt') return !window.getSelection()?.toString();

  // A question mark as the first character of a message is one nobody types, so it is
  // claimed - and swallowed, rather than left in the box behind the list.
  if (id === 'help') return !typing(event.target) || nothingWritten(event.target, writing);

  return true;
}

/**
 * The keys a terminal reflex expects to work.
 *
 * This app replaces a terminal, and the muscle memory comes with the reader: reaching for
 * the mouse to stop a turn is the moment they notice they have left the terminal behind.
 * Bound on the window rather than on a component, so they work wherever the focus happens
 * to be - including inside the composer for the ones that make sense there.
 *
 * Matched against a table rather than asked as a chain of questions, so a reader can change
 * any of them (#246): a key written into a condition is a key nobody can move.
 *
 * @param writing what has been typed but not sent, since the app knows that better than the
 *   field does: a shortcut that has to sniff the DOM for it is guessing.
 * @param overrides the keys a reader changed, if any.
 */
export function useShortcuts(on: (shortcut: Shortcut) => void, writing?: () => string, overrides: Overrides = {}) {
  // Held in refs so a caller passing a fresh function does not re-register the listener,
  // and so the double-press window survives a render.
  const handler = useRef(on);
  handler.current = on;
  const written = useRef(writing);
  written.current = writing;
  const lastEscape = useRef(0);

  /**
   * What each key answers to, with the composer's own left out.
   *
   * Held in a ref for the same reason as the handlers: a change to a binding has to reach
   * the listener already registered, not wait for it to be registered again.
   */
  const chords = useMemo(() => {
    const all = chordsOf(overrides);
    for (const id of COMPOSER_OWNED) all.delete(id);
    return [...all];
  }, [overrides]);
  const bound = useRef(chords);
  bound.current = chords;

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

      /*
       * Escape is the one key not in the table, because it is not a chord: it is a press
       * repeated, and what the first one does depends on where it came from. That is also
       * why it is the one key a reader cannot move, which the settings window says outright.
       */
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

      for (const [id, chord] of bound.current) {
        if (!matchesChord(chord, event)) continue;
        // Nothing else can match, so a shortcut that declines the press lets it through as
        // the key it is rather than falling on to the next row.
        if (!allowed(id, event, written.current)) return;

        /*
         * Always taken, because the webview has its own ideas about most of these: ctrl+n
         * opens a window, f6 goes to the address bar, ctrl+s offers to save the page, and
         * the zoom keys scale the app a second time on top of this one.
         */
        event.preventDefault();
        handler.current(id);
        return;
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
    // Only the hot counter, which stands still outside development: the handlers and the
    // bindings are read through refs, so nothing else this closure sees can go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hot]);
}
