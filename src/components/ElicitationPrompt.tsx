import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import type { ElicitationFieldValue, PendingElicitation } from '../../shared/protocol';
import {
  formOf,
  initialValues,
  isIncomplete,
  optionsOf,
  type Field,
} from '../lib/elicitationForm';

interface ElicitationPromptProps {
  pending: PendingElicitation;
  onResolve: (action: 'accept' | 'decline' | 'cancel', content?: Record<string, ElicitationFieldValue>) => void;
}

/**
 * A question from the agent, the equivalent of the CLI's ask_user.
 *
 * The agent is blocked until this is answered, so it stays until the user acts. Declining
 * is a real answer, not a dismissal: the agent is told and carries on with its own
 * judgement.
 */
export function ElicitationPrompt({ pending, onResolve }: ElicitationPromptProps) {
  const { fields, required } = formOf(pending);

  const [values, setValues] = useState(() => initialValues(fields));
  const containerRef = useRef<HTMLElement>(null);
  const freeformRef = useRef<HTMLInputElement>(null);

  // Take focus so the prompt is answerable from the keyboard the moment it appears,
  // without having to click into it first.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  function set(name: string, value: ElicitationFieldValue) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  const missing = isIncomplete(required, values);

  /**
   * Keyboard handling for the single-choice case, which is what ask_user produces.
   *
   * The choices and the freeform box form one list, so moving past either end lands in
   * the box rather than wrapping straight back round. `w` and `s` mirror the arrows,
   * and any other character jumps into the box carrying that character, so an unlisted
   * answer needs no extra keystroke.
   */
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const [name] = Object.keys(fields);
    if (!name) return;

    const options = optionsOf(fields[name] as Field);
    const inTextBox =
      event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!missing) onResolve('accept', values);
      return;
    }

    if (options.length === 0) return;

    // The freeform box sits after the last choice, so its index is options.length.
    const current = options.findIndex((option) => option.value === values[name]);
    const active = current === -1 ? options.length : current;

    const moveTo = (index: number) => {
      event.preventDefault();
      if (index === options.length) {
        // Entering the box clears the choice, since the answer becomes what is typed.
        set(name, '');
        freeformRef.current?.focus();
      } else {
        set(name, options[index]?.value ?? '');
        containerRef.current?.focus();
      }
    };

    const down = event.key === 'ArrowDown' || (!inTextBox && event.key === 's');
    const up = event.key === 'ArrowUp' || (!inTextBox && event.key === 'w');

    // Wrapping across the box in both directions keeps the list circular without ever
    // skipping the one entry that cannot be reached any other way.
    if (down) return moveTo((active + 1) % (options.length + 1));
    if (up) return moveTo((active - 1 + options.length + 1) % (options.length + 1));

    // Inside the box every other key belongs to the field.
    if (inTextBox) return;

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      set(name, event.key);
      freeformRef.current?.focus();
    }
  }

  // A url-mode request points at a link instead of asking for values.
  if (pending.mode === 'url' && pending.url) {
    return (
      <section className="elicitation">
        <header className="elicitation-header">
          <span className="elicitation-badge">question</span>
          <span>{pending.message}</span>
        </header>
        <a className="elicitation-url" href={pending.url} target="_blank" rel="noreferrer">
          {pending.url}
        </a>
        <Actions onResolve={onResolve} values={values} disabled={false} />
      </section>
    );
  }

  return (
    <section className="elicitation" ref={containerRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="elicitation-header">
        <span className="elicitation-badge">question</span>
        <span>{pending.message}</span>
      </header>

      <div className="elicitation-fields">
        {Object.entries(fields).map(([name, field]) => (
          <label key={name} className="elicitation-field">
            <span className="elicitation-label">
              {field.title ?? name}
              {required.has(name) && <span className="elicitation-required"> *</span>}
            </span>
            {field.description && <span className="elicitation-help">{field.description}</span>}
            <Control
              field={field}
              value={values[name]}
              onChange={(value) => set(name, value)}
              freeformRef={freeformRef}
            />
          </label>
        ))}
      </div>

      <Actions onResolve={onResolve} values={values} disabled={missing} />
    </section>
  );
}

function Actions({
  onResolve,
  values,
  disabled,
}: {
  onResolve: ElicitationPromptProps['onResolve'];
  values: Record<string, ElicitationFieldValue>;
  disabled: boolean;
}) {
  return (
    <div className="elicitation-actions">
      <button type="button" className="secondary" onClick={() => onResolve('cancel')}>
        Cancel
      </button>
      <button type="button" className="secondary" onClick={() => onResolve('decline')}>
        Decline
      </button>
      <button type="button" onClick={() => onResolve('accept', values)} disabled={disabled}>
        Submit
      </button>
    </div>
  );
}

function Control({
  field,
  value,
  onChange,
  freeformRef,
}: {
  field: Field;
  value: ElicitationFieldValue | undefined;
  onChange: (value: ElicitationFieldValue) => void;
  freeformRef?: RefObject<HTMLInputElement | null>;
}) {
  const options = optionsOf(field);

  if (field.type === 'boolean') {
    return (
      <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
    );
  }

  if (field.type === 'array') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="elicitation-choices">
        {options.map((option) => (
          <label key={option.value} className="elicitation-choice">
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, option.value]
                    : selected.filter((v) => v !== option.value),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </div>
    );
  }

  if (options.length > 0) {
    // The schema offers suggestions, but a freeform answer is always allowed, so this is
    // a list plus a text box rather than a closed dropdown.
    return (
      <>
        <div className="elicitation-choices">
          {options.map((option) => (
            <label key={option.value} className="elicitation-choice">
              <input
                type="radio"
                checked={value === option.value}
                onChange={() => onChange(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
        <input
          ref={freeformRef}
          type="text"
          className="elicitation-input"
          placeholder="or type your own"
          value={typeof value === 'string' && !options.some((o) => o.value === value) ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      </>
    );
  }

  if (field.type === 'number' || field.type === 'integer') {
    return (
      <input
        type="number"
        className="elicitation-input"
        value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    );
  }

  return (
    <input
      type="text"
      className="elicitation-input"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
