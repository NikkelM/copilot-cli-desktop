import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Attachments } from './Attachments';
import { Menu, type MenuItem } from './Menu';
import { commandText, completionOf, findCommand, matchCommands, typedCommand } from '../lib/slash';
import type { Attachment, SlashCommand } from '../../shared/protocol';

interface ComposerProps {
  disabled: boolean;
  busy: boolean;
  /**
   * Waking a cold session, which is the one action that genuinely costs something.
   *
   * Between 1.4 and 5.6 seconds depending on how much history there is to read, and
   * deliberate: browsing a session spawns nothing, so the cost lands on the first message.
   */
  resuming: boolean;
  /** Files to send with this message, held outside for the same reason the text is. */
  attached: Attachment[];
  onAttach: (attached: Attachment[]) => void;
  onError: (message: string) => void;
  /**
   * Takes focus whenever this changes to something other than null, so a session opens
   * ready to type in. Null while the agent is waiting on a prompt of its own, which has
   * a better claim on the keyboard.
   */
  focusOn: string | null;
  /**
   * The text being written. Held outside, because an unsent message belongs to the
   * session it was meant for rather than to the box it was typed in.
   */
  value: string;
  onChange: (value: string) => void;
  onSend: (prompt: string) => void;
  onAbort: () => void;
  /** The slash commands there are, for the menu a leading slash opens. */
  commands: SlashCommand[];
  /** Called once a slash is typed, so the list can be fetched if it is not known yet. */
  onCommandsNeeded: () => void;
}

/**
 * Sending is the only action that costs memory: it resumes the session in the shared
 * CLI server. Everything above this component is a pure disk read.
 */
export function Composer({
  disabled,
  busy,
  resuming,
  attached,
  onAttach,
  onError,
  focusOn,
  value,
  onChange,
  onSend,
  onAbort,
  commands,
  onCommandsNeeded,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The picker lives with the chips; the button that opens it lives with the buttons. */
  const attacher = useRef<(() => void) | null>(null);
  const focusBack = useCallback(() => inputRef.current?.focus(), []);
  /** Which row the command menu's cursor is on, reset whenever the list changes under it. */
  const [selected, setSelected] = useState(0);
  /**
   * Escape closes the menu without closing what is being written.
   *
   * Remembered against the text it was closed for, so carrying on typing the same command
   * leaves it closed while starting a different one opens it again.
   */
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (focusOn) inputRef.current?.focus();
  }, [focusOn]);

  const typed = typedCommand(value);
  const named = typed ? findCommand(commands, typed.name) : undefined;

  /**
   * What the menu is offering, if anything.
   *
   * Before the space, the commands themselves. After it, the values the argument accepts,
   * for the commands whose argument is a choice rather than free text - the only case where
   * this app knows enough for the offer to be worth making.
   */
  const items = useMemo((): MenuItem[] => {
    if (!typed || dismissed === value) return [];

    if (typed.input === null) {
      return matchCommands(commands, typed.name).map((each) => ({
        id: each.name,
        label: each.hint ? `/${each.name} <${each.hint}>` : `/${each.name}`,
        description: each.description,
      }));
    }

    const wanted = typed.input.toLowerCase();
    return (named?.choices ?? [])
      .filter((choice) => choice.name.toLowerCase().startsWith(wanted))
      .map((choice) => ({ id: choice.name, label: choice.name, description: choice.description }));
  }, [typed?.name, typed?.input, value, dismissed, commands, named]);

  // A list that changes under the cursor leaves it on a row that has moved or gone.
  useEffect(() => setSelected(0), [items.length, typed?.name]);

  // Asked for on the first slash rather than at startup: the list costs a Copilot process,
  // and most sessions are read without a command ever being typed.
  const wanted = typed !== null;
  useEffect(() => {
    if (wanted) onCommandsNeeded();
  }, [wanted, onCommandsNeeded]);

  /** The rest of the selected command's name, drawn ahead of the cursor. */
  const ghost =
    typed?.input === null && items[selected]
      ? completionOf(typed.name, findCommand(commands, items[selected]!.id))
      : '';

  function submit(text = value) {
    const prompt = text.trim();
    // A second send while the first is still waking would look like the fix for a button
    // that appears to have done nothing.
    if (!prompt || disabled || resuming) return;
    onSend(prompt);
  }

  /**
   * Take a row from the menu.
   *
   * Tab finishes the word and leaves the cursor where it was, which is what completion
   * means everywhere else. Enter finishes it and acts, so a command needing no argument
   * runs on one keypress as it does in the CLI, while one that does is left ready to type
   * into rather than sent half-written.
   */
  function choose(item: MenuItem, key: 'Tab' | 'Enter') {
    if (!typed) return;

    // A value for the argument: the name stays, and only what follows it is filled in.
    if (typed.input !== null) {
      const text = `/${typed.name} ${item.id}`;
      onChange(text);
      if (key === 'Enter') submit(text);
      else inputRef.current?.focus();
      return;
    }

    const picked = findCommand(commands, item.id);
    if (!picked) return;

    const text = commandText(picked);
    onChange(text);
    if (key === 'Enter' && !picked.hint) submit(text);
    else inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The menu claims Enter and Tab from a listener that runs first, so a key it has
    // already acted on must not be acted on again here: completing a command would
    // otherwise also send the half-written name that was completed.
    if (event.defaultPrevented) return;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer">
      {items.length > 0 && (
        <Menu
          items={items}
          selected={selected}
          onSelect={setSelected}
          onChoose={choose}
          onDismiss={() => setDismissed(value)}
          label="Slash commands"
        />
      )}

      {/* The ghost is drawn behind the box rather than in it, because a textarea cannot
          hold text it does not own. Laid out as a single line, which is safe: a command is
          one line by definition, so there is no wrapping to mirror. */}
      <div className="composer-input">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            busy
              ? 'Agent is working. Enter queues this behind it.'
              : 'Send a message. Enter to send, Shift+Enter for a newline, / for commands.'
          }
          rows={3}
          disabled={disabled}
        />
        {ghost && (
          <div className="ghost" aria-hidden="true">
            <span>{value}</span>
            <span className="ghost-rest">{ghost}</span>
          </div>
        )}
      </div>

      {/* Chips sit above the row of buttons rather than beside them, so a message with
          several files attached grows upwards instead of pushing Send off the line. */}
      <Attachments
        attached={attached}
        onChange={onAttach}
        onPicker={(pick) => (attacher.current = pick)}
        onFocusBack={focusBack}
        onError={onError}
      />

      <div className="composer-actions">
        <button type="button" className="attach" onClick={() => attacher.current?.()} title="Attach files">
          Attach
        </button>

        {/* Said here rather than at the top of the pane, because this is where the reader
            is looking after pressing Send, and in terms that make the wait make sense:
            this session costs nothing until it is woken, which is the whole idea. */}
        {resuming && <span className="waking">Waking this session up</span>}
        {busy && (
          <button type="button" className="secondary" onClick={onAbort}>
            Stop
          </button>
        )}
        <button type="button" onClick={() => submit()} disabled={disabled || resuming || !value.trim()}>
          {resuming ? 'Waking…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
