import { useState } from 'react';

import type { ElicitationFieldValue, PendingElicitation } from '../../shared/protocol';

/**
 * One field of an elicitation schema. Mirrors the SDK's ElicitationSchemaField, which is
 * a union rather than a single shape, so the discriminating keys are all optional here
 * and narrowed when choosing a control.
 */
interface Field {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title: string }[];
  items?: { type?: string; enum?: string[]; anyOf?: { const: string; title: string }[] };
  default?: ElicitationFieldValue;
}

interface Option {
  value: string;
  label: string;
}

/** Collapse the enum, enumNames and oneOf spellings into one list of options. */
function optionsOf(field: Field): Option[] {
  if (field.oneOf) return field.oneOf.map((o) => ({ value: o.const, label: o.title }));

  if (field.enum) {
    return field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  }

  const items = field.items;
  if (items?.anyOf) return items.anyOf.map((o) => ({ value: o.const, label: o.title }));
  if (items?.enum) return items.enum.map((value) => ({ value, label: value }));

  return [];
}

function initialValues(fields: Record<string, Field>): Record<string, ElicitationFieldValue> {
  const values: Record<string, ElicitationFieldValue> = {};

  for (const [name, field] of Object.entries(fields)) {
    if (field.default !== undefined) {
      values[name] = field.default;
    } else if (field.type === 'boolean') {
      values[name] = false;
    } else if (field.type === 'array') {
      values[name] = [];
    } else {
      values[name] = '';
    }
  }

  return values;
}

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
  // The legacy variant carries a question and suggestions rather than a schema, so it is
  // presented as one field. Both variants then render through the same controls.
  const schema =
    pending.kind === 'input'
      ? {
          properties: {
            answer: {
              type: 'string',
              title: 'Answer',
              ...(pending.choices.length > 0 ? { enum: pending.choices } : {}),
            } as Field,
          },
          required: ['answer'],
        }
      : ((pending.schema ?? {}) as { properties?: Record<string, Field>; required?: string[] });

  const fields = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const [values, setValues] = useState(() => initialValues(fields));

  function set(name: string, value: ElicitationFieldValue) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  const missing = [...required].some((name) => {
    const value = values[name];
    return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  });

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
    <section className="elicitation">
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
            <Control field={field} value={values[name]} onChange={(value) => set(name, value)} />
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
}: {
  field: Field;
  value: ElicitationFieldValue | undefined;
  onChange: (value: ElicitationFieldValue) => void;
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
