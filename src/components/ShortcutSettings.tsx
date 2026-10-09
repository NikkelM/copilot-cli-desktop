import { useRef, useState } from 'react';

import {
  REBINDABLE,
  bind,
  readOverrides,
  refused,
  resolveBindings,
  writeOverrides,
  type Refusal,
  type Shortcut,
} from '../lib/bindings';
import { chordOf } from '../lib/chords';

/** What a key says when it is waiting to be told what it should be. */
const LISTENING = 'Press keys';

/** What the keys column says for a shortcut somebody turned off. */
const CLEARED = 'not set';

/** What to say about a chord that cannot be given to this key. */
function reason(refusal: Refusal): string {
  if (refusal.why === 'unmodified') {
    return 'That one would be typed into the message box. Hold ctrl or alt, or use a function key.';
  }

  return `${refusal.by.keys} is already ${refusal.by.what}.`;
}

/**
 * The keys, and a way to move them (#246).
 *
 * Every key the app implements is here, which is every key in the list `?` shows except the
 * ones the CLI's own readline provides - there is nothing of this app's to move in those -
 * and Escape, which is a press repeated rather than a press with modifiers and so cannot be
 * written down as a chord at all.
 *
 * A key that is already taken is refused rather than stolen. Quietly taking it would leave
 * the reader with a shortcut that stopped working and nothing on screen to say where it had
 * gone, and the thing they moved is the thing they were thinking about - not the one three
 * rows up that silently lost its key.
 *
 * Held as one string of JSON so this is a single setting like any other, which is what lets
 * the window's save-or-discard cover it without knowing anything about keys.
 */
export function ShortcutSettings({
  value,
  onChange,
  shows,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Whether a row answers what was typed into the search, by the words it is described by. */
  shows: (label: string) => boolean;
}) {
  const overrides = readOverrides(value);
  const resolved = resolveBindings(overrides);
  const keysOf = (id: Shortcut) => resolved.find((binding) => binding.id === id)?.keys ?? '';

  /** Which key is listening, if any. One at a time: two would both answer the same press. */
  const [listening, setListening] = useState<Shortcut | null>(null);
  const [problem, setProblem] = useState<{ id: Shortcut; text: string } | null>(null);
  /** Where to put the keyboard back after a change, since a disabled button cannot hold it. */
  const rows = useRef<HTMLDivElement>(null);

  const put = (next: ReturnType<typeof readOverrides>) => onChange(writeOverrides(next));

  const take = (id: Shortcut, event: React.KeyboardEvent) => {
    // The way out of a capture, and the way on from one. Both have to reach the browser or
    // a reader who opened this by mistake would have no key left that does anything.
    if (event.key === 'Escape' || event.key === 'Tab') {
      setListening(null);
      return;
    }

    // Taken before anything else looks at it: every shortcut in the app is listening on the
    // window, and this is the one moment a press means a key rather than what it does.
    event.preventDefault();
    event.stopPropagation();

    const chord = chordOf(event.nativeEvent);
    // Still only modifiers held, so there is nothing to record yet. Waiting rather than
    // refusing, because this is what the middle of pressing ctrl+shift+b looks like.
    if (!chord) return;

    const result = bind(id, chord, overrides);
    if (refused(result)) {
      setProblem({ id, text: reason(result) });
      return;
    }

    setProblem(null);
    setListening(null);
    put(result);
  };

  /**
   * Put the keyboard back on the row after a button under it goes away.
   *
   * Clear and Reset both disable themselves once they have been used, and a disabled element
   * drops the focus on the spot. A frame later, because the button is still there until
   * React has drawn the change.
   */
  const backTo = (id: Shortcut) =>
    requestAnimationFrame(() => rows.current?.querySelector<HTMLElement>(`[data-keys="${id}"]`)?.focus());

  const changed = Object.keys(overrides).length > 0;

  return (
    <div ref={rows}>
      <p className="settings-note">
        Choose a row and press the keys you want. Escape leaves a row as it was, and is itself the one key that cannot
        be moved: it is a press repeated rather than a press with modifiers.
      </p>

      {REBINDABLE.filter((binding) => shows(binding.what)).map((binding) => {
        const id = binding.id!;
        const keys = keysOf(id);
        const waiting = listening === id;
        const moved = overrides[id] !== undefined;

        return (
          <div className="shortcut-row" key={id}>
            <span className="shortcut-what" id={`shortcut-${id}`}>
              {binding.what}
            </span>

            <button
              type="button"
              className={`shortcut-keys${waiting ? ' listening' : ''}${keys ? '' : ' cleared'}`}
              data-keys={id}
              // Named by what it does rather than by what it says, since what it says is the
              // chord - which on its own tells a screen reader nothing about the row.
              aria-labelledby={`shortcut-${id}`}
              aria-describedby={problem?.id === id ? `shortcut-problem-${id}` : undefined}
              onClick={() => {
                setProblem(null);
                setListening(waiting ? null : id);
              }}
              onKeyDown={(event) => {
                if (waiting) {
                  take(id, event);
                  return;
                }
                // Enter and Space start listening rather than opening it as a button would,
                // so the whole of this works without a pointer.
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                setProblem(null);
                setListening(id);
              }}
              onBlur={() => setListening((current) => (current === id ? null : current))}
            >
              {waiting ? LISTENING : keys || CLEARED}
            </button>

            <button
              type="button"
              className="shortcut-act"
              disabled={keys === ''}
              onClick={() => {
                setProblem(null);
                put({ ...overrides, [id]: '' });
                backTo(id);
              }}
            >
              Clear
            </button>

            <button
              type="button"
              className="shortcut-act"
              disabled={!moved}
              onClick={() => {
                setProblem(null);
                const { [id]: _gone, ...rest } = overrides;
                put(rest);
                backTo(id);
              }}
            >
              Reset
            </button>

            {problem?.id === id && (
              <p className="shortcut-problem" id={`shortcut-problem-${id}`} role="alert">
                {problem.text}
              </p>
            )}
          </div>
        );
      })}

      <button
        type="button"
        className="settings-reset-all"
        disabled={!changed}
        onClick={() => {
          setProblem(null);
          setListening(null);
          put({});
        }}
      >
        Put every key back
      </button>
    </div>
  );
}
