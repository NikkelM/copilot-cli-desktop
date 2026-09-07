import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

import { Attachments } from './Attachments';
import type { Attachment } from '../../shared/protocol';

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
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The picker lives with the chips; the button that opens it lives with the buttons. */
  const attacher = useRef<(() => void) | null>(null);
  const focusBack = useCallback(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (focusOn) inputRef.current?.focus();
  }, [focusOn]);

  function submit() {
    const prompt = value.trim();
    // A second send while the first is still waking would look like the fix for a button
    // that appears to have done nothing.
    if (!prompt || disabled || resuming) return;
    onSend(prompt);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer">
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          busy ? 'Agent is working. Enter queues this behind it.' : 'Send a message. Enter to send, Shift+Enter for a newline.'
        }
        rows={3}
        disabled={disabled}
      />
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
        <button type="button" onClick={submit} disabled={disabled || resuming || !value.trim()}>
          {resuming ? 'Waking…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
