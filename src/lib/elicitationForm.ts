import type { ElicitationFieldValue, PendingElicitation } from '../../shared/protocol';

/**
 * One field of an elicitation schema. Mirrors the SDK's ElicitationSchemaField, which is
 * a union rather than a single shape, so the discriminating keys are all optional here
 * and narrowed when choosing a control.
 */
export interface Field {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title: string }[];
  items?: { type?: string; enum?: string[]; anyOf?: { const: string; title: string }[] };
  default?: ElicitationFieldValue;
}

export interface Option {
  value: string;
  label: string;
}

/** Collapse the enum, enumNames and oneOf spellings into one list of options. */
export function optionsOf(field: Field): Option[] {
  if (field.oneOf) return field.oneOf.map((o) => ({ value: o.const, label: o.title }));

  if (field.enum) {
    return field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  }

  const items = field.items;
  if (items?.anyOf) return items.anyOf.map((o) => ({ value: o.const, label: o.title }));
  if (items?.enum) return items.enum.map((value) => ({ value, label: value }));

  return [];
}

export interface Form {
  fields: Record<string, Field>;
  required: Set<string>;
}

/**
 * The form to show for a question.
 *
 * The legacy variant carries a question and suggested choices rather than a schema, so it
 * is presented as a single field. Both variants then render through the same controls.
 */
export function formOf(pending: PendingElicitation): Form {
  if (pending.kind === 'input') {
    const field: Field = {
      type: 'string',
      title: 'Answer',
      ...(pending.choices.length > 0 ? { enum: pending.choices } : {}),
    };
    return { fields: { answer: field }, required: new Set(['answer']) };
  }

  const schema = (pending.schema ?? {}) as {
    properties?: Record<string, Field>;
    required?: string[];
  };
  return { fields: schema.properties ?? {}, required: new Set(schema.required ?? []) };
}

/**
 * Starting values for a form.
 *
 * A single-choice field starts on its first option so Enter confirms the obvious answer
 * without any pointing, the way the CLI behaves. The schema's default wins when it gives
 * one, since that is the recommendation.
 */
export function initialValues(fields: Record<string, Field>): Record<string, ElicitationFieldValue> {
  const values: Record<string, ElicitationFieldValue> = {};

  for (const [name, field] of Object.entries(fields)) {
    const options = optionsOf(field);

    if (field.default !== undefined) {
      values[name] = field.default;
    } else if (field.type === 'boolean') {
      values[name] = false;
    } else if (field.type === 'array') {
      values[name] = [];
    } else if (options.length > 0) {
      values[name] = options[0]?.value ?? '';
    } else {
      values[name] = '';
    }
  }

  return values;
}

/** Whether a required field is still unanswered, which is what blocks submission. */
export function isIncomplete(
  required: ReadonlySet<string>,
  values: Record<string, ElicitationFieldValue>,
): boolean {
  return [...required].some((name) => {
    const value = values[name];
    return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  });
}
