import { useState, type KeyboardEvent } from 'react';

interface ComposerProps {
  disabled: boolean;
  busy: boolean;
  onSend: (prompt: string) => void;
  onAbort: () => void;
}

/**
 * Sending is the only action that costs memory: it resumes the session in the shared
 * CLI server. Everything above this component is a pure disk read.
 */
export function Composer({ disabled, busy, onSend, onAbort }: ComposerProps) {
  const [value, setValue] = useState('');

  function submit() {
    const prompt = value.trim();
    if (!prompt || disabled) return;
    onSend(prompt);
    setValue('');
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
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={busy ? 'Agent is working. Enter queues a follow-up.' : 'Send a message. Enter to send, Shift+Enter for a newline.'}
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
