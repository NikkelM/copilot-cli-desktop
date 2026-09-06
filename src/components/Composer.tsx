import { useEffect, useRef, type KeyboardEvent } from 'react';

interface ComposerProps {
  disabled: boolean;
  busy: boolean;
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
export function Composer({ disabled, busy, focusOn, value, onChange, onSend, onAbort }: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusOn) inputRef.current?.focus();
  }, [focusOn]);

  function submit() {
    const prompt = value.trim();
    if (!prompt || disabled) return;
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
        placeholder={busy ? 'Agent is working. Enter queues this behind it.' : 'Send a message. Enter to send, Shift+Enter for a newline.'}
        rows={3}
        disabled={disabled}
      />
      <div className="composer-actions">
        {busy && (
          <button type="button" className="secondary" onClick={onAbort}>
            Stop
          </button>
        )}
        <button type="button" onClick={submit} disabled={disabled || !value.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
