import { describe, expect, it } from 'vitest';

import type { PendingElicitation } from '../../shared/protocol';
import { formOf, initialValues, isIncomplete, optionsOf } from './elicitationForm';

const pending = (over: Partial<PendingElicitation> = {}): PendingElicitation => ({
  sessionId: 's',
  requestId: 'input-1',
  kind: 'input',
  message: 'Which database do you prefer?',
  schema: null,
  choices: [],
  mode: null,
  url: null,
  ...over,
});

describe('formOf', () => {
  it('turns a legacy question and its choices into one field', () => {
    const form = formOf(pending({ choices: ['PostgreSQL', 'MySQL', 'SQLite'] }));

    expect(Object.keys(form.fields)).toEqual(['answer']);
    expect(optionsOf(form.fields.answer!).map((o) => o.value)).toEqual([
      'PostgreSQL',
      'MySQL',
      'SQLite',
    ]);
    expect(form.required.has('answer')).toBe(true);
  });

  it('still offers a field when a legacy question has no choices', () => {
    const form = formOf(pending());
    expect(optionsOf(form.fields.answer!)).toEqual([]);
    expect(form.fields.answer?.type).toBe('string');
  });

  it('reads fields from the schema for the elicitation variant', () => {
    const form = formOf(
      pending({
        kind: 'form',
        requestId: 'elicit-1',
        schema: {
          properties: { database: { type: 'string', enum: ['a', 'b'] } },
          required: ['database'],
        },
      }),
    );

    expect(Object.keys(form.fields)).toEqual(['database']);
    expect(form.required.has('database')).toBe(true);
  });
});

describe('initialValues', () => {
  // The whole point of preselecting: Enter should confirm without any pointing, and an
  // empty value would also leave Submit disabled.
  it('preselects the first choice so the answer is never empty', () => {
    const { fields } = formOf(pending({ choices: ['PostgreSQL', 'MySQL'] }));
    expect(initialValues(fields)).toEqual({ answer: 'PostgreSQL' });
  });

  it('prefers the schema default over the first choice', () => {
    const values = initialValues({
      pick: { type: 'string', enum: ['a', 'b', 'c'], default: 'c' },
    });
    expect(values).toEqual({ pick: 'c' });
  });

  it('starts free text empty', () => {
    const { fields } = formOf(pending());
    expect(initialValues(fields)).toEqual({ answer: '' });
  });

  it('starts booleans false and multi-select empty', () => {
    const values = initialValues({
      flag: { type: 'boolean' },
      many: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    });
    expect(values).toEqual({ flag: false, many: [] });
  });

  it('handles labelled options from oneOf', () => {
    const options = optionsOf({ type: 'string', oneOf: [{ const: 'pg', title: 'PostgreSQL' }] });
    expect(options).toEqual([{ value: 'pg', label: 'PostgreSQL' }]);
  });

  it('pairs enumNames with enum values', () => {
    const options = optionsOf({ type: 'string', enum: ['pg', 'my'], enumNames: ['PostgreSQL', 'MySQL'] });
    expect(options.map((o) => o.label)).toEqual(['PostgreSQL', 'MySQL']);
  });
});

describe('isIncomplete', () => {
  it('is satisfied by the preselected choice', () => {
    const { fields, required } = formOf(pending({ choices: ['PostgreSQL'] }));
    expect(isIncomplete(required, initialValues(fields))).toBe(false);
  });

  it('blocks submission while a required answer is empty', () => {
    const { required } = formOf(pending());
    expect(isIncomplete(required, { answer: '' })).toBe(true);
  });

  it('blocks submission while a required multi-select has nothing chosen', () => {
    expect(isIncomplete(new Set(['many']), { many: [] })).toBe(true);
  });

  it('ignores fields that are not required', () => {
    expect(isIncomplete(new Set(), { anything: '' })).toBe(false);
  });
});
