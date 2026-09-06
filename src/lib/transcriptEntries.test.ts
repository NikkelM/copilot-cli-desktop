import { describe, expect, it } from 'vitest';

import type { TranscriptEvent } from '../../shared/protocol';
import { sameEntry, toEntries, type MessageEntry, type ToolEntry } from './transcriptEntries';

const event = (type: string, data: Record<string, unknown> = {}, id?: string): TranscriptEvent => ({
  type,
  data,
  id,
});

const CWD = 'C:\\work\\repo';

describe('toEntries', () => {
  it('renders user and assistant messages', () => {
    const entries = toEntries(
      [event('user.message', { content: 'hello' }, 'e1'), event('assistant.message', { content: 'hi' }, 'e2')],
      null,
    );
    expect(entries).toEqual([
      { kind: 'message', key: 'e1', variant: 'user', body: 'hello' },
      { kind: 'message', key: 'e2', variant: 'assistant', body: 'hi' },
    ]);
  });

  // These carry only tool requests, and the tool has its own entry. Rendering them showed
  // a wall of JSON in the transcript.
  it('drops assistant messages that have no text', () => {
    const entries = toEntries([event('assistant.message', { content: '', toolRequests: [{}] })], null);
    expect(entries).toEqual([]);
  });

  it('hides events it has no rendering for, including permission requests', () => {
    const entries = toEntries(
      [event('permission.requested', { requestId: 'x' }), event('model.messages_snapshot', {})],
      null,
    );
    expect(entries).toEqual([]);
  });

  it('pairs a tool start with its completion into one entry', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 't1',
          toolName: 'powershell',
          arguments: { command: 'echo hi' },
        }),
        event('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'hi' } }),
      ],
      null,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      name: 'Shell',
      summary: 'echo hi',
      status: 'ok',
      output: 'hi',
      command: 'echo hi',
    });
  });

  it('reports a failed tool with its error message', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: {} }),
        event('tool.execution_complete', {
          toolCallId: 't1',
          success: false,
          error: { message: 'The user rejected this tool call.' },
        }),
      ],
      null,
    );
    expect(entries[0]).toMatchObject({ status: 'failed', output: 'The user rejected this tool call.' });
  });

  // An interrupted turn never emits a completion, so without this the row claims to be
  // running forever, including on every later replay.
  it.each(['abort', 'session.idle', 'session.shutdown'])('cancels pending tools on %s', (stopper) => {
    const entries = toEntries(
      [event('tool.execution_start', { toolCallId: 't1', toolName: 'create', arguments: {} }), event(stopper)],
      null,
    );
    expect((entries[0] as ToolEntry).status).toBe('cancelled');
  });

  it('leaves a tool running while the turn is still going', () => {
    const entries = toEntries([event('tool.execution_start', { toolCallId: 't1', toolName: 'create' })], null);
    expect((entries[0] as ToolEntry).status).toBe('running');
  });

  it('summarises file tools by path, relative to the working directory', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 't1',
          toolName: 'create',
          arguments: { path: 'C:\\work\\repo\\src\\index.ts', file_text: 'ignored' },
        }),
      ],
      CWD,
    );
    expect((entries[0] as ToolEntry).summary).toBe('src/index.ts');
  });

  it('keeps paths outside the working directory absolute', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 't1',
          toolName: 'create',
          arguments: { path: 'C:\\elsewhere\\note.txt' },
        }),
      ],
      CWD,
    );
    expect((entries[0] as ToolEntry).summary).toBe('C:\\elsewhere\\note.txt');
  });

  it('summarises searches by pattern and shells by command', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', { toolCallId: 'a', toolName: 'grep', arguments: { pattern: 'TODO', paths: [] } }),
        event('tool.execution_start', { toolCallId: 'b', toolName: 'powershell', arguments: { command: 'ls' } }),
      ],
      null,
    );
    expect((entries[0] as ToolEntry).summary).toBe('TODO');
    expect((entries[1] as ToolEntry).summary).toBe('ls');
  });

  it('survives a completion whose start was never seen', () => {
    const entries = toEntries(
      [event('tool.execution_complete', { toolCallId: 'orphan', success: true, result: { content: 'done' } })],
      null,
    );
    expect(entries[0]).toMatchObject({ kind: 'tool', status: 'ok', output: 'done' });
  });

  it('interleaves tools and messages in order', () => {
    const entries = toEntries(
      [
        event('user.message', { content: 'do it' }),
        event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'go' } }),
        event('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'ok' } }),
        event('assistant.message', { content: 'done' }),
      ],
      null,
    );
    expect(entries.map((e) => e.kind)).toEqual(['message', 'tool', 'message']);
  });
});

describe('ask_user rows', () => {
  const question = 'Which database do you prefer?';

  it('keeps the tool name and shows the question as the subject', () => {
    const entries = toEntries(
      [event('tool.execution_start', { toolCallId: 'q1', toolName: 'ask_user', arguments: { question } })],
      null,
    );
    expect(entries[0]).toMatchObject({ kind: 'tool', name: 'Asking user', summary: question, question: true });
  });

  // The elicitation variant names the field "message" where the legacy one says "question".
  it('reads the question from the elicitation variant too', () => {
    const entries = toEntries(
      [event('tool.execution_start', { toolCallId: 'q1', toolName: 'ask_user', arguments: { message: question } })],
      null,
    );
    expect(entries[0]).toMatchObject({ name: 'Asking user', summary: question, question: true });
  });

  it('carries the answer separately once given', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', { toolCallId: 'q1', toolName: 'ask_user', arguments: { question } }),
        event('tool.execution_complete', {
          toolCallId: 'q1',
          success: true,
          result: { content: 'User responded: PostgreSQL' },
        }),
      ],
      null,
    );
    // Kept out of the summary so it can be styled as the outcome, not as more question.
    expect(entries[0]).toMatchObject({ name: 'Asking user', summary: question, answer: 'PostgreSQL' });
  });

  // Declining reports an empty answer rather than omitting the line.
  it('records no answer when the question went unanswered', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', { toolCallId: 'q1', toolName: 'ask_user', arguments: { question } }),
        event('tool.execution_complete', {
          toolCallId: 'q1',
          success: true,
          result: { content: 'User responded: ' },
        }),
      ],
      null,
    );
    expect((entries[0] as ToolEntry).summary).toBe(question);
    expect((entries[0] as ToolEntry).answer).toBeUndefined();
  });

  it('clamps a long question', () => {
    const long = 'W'.repeat(400);
    const entries = toEntries(
      [event('tool.execution_start', { toolCallId: 'q1', toolName: 'ask_user', arguments: { question: long } })],
      null,
    );
    const summary = (entries[0] as ToolEntry).summary;
    expect(summary.length).toBeLessThan(200);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('keeps the offered choices so the row can show what was on the table', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 'q1',
          toolName: 'ask_user',
          arguments: { question, choices: ['PostgreSQL', 'MySQL', 'SQLite'] },
        }),
        event('tool.execution_complete', {
          toolCallId: 'q1',
          success: true,
          result: { content: 'User responded: MySQL' },
        }),
      ],
      null,
    );
    expect(entries[0]).toMatchObject({
      choices: ['PostgreSQL', 'MySQL', 'SQLite'],
      answer: 'MySQL',
    });
  });

  it('keeps the choices on a question that was never answered', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 'q1',
          toolName: 'ask_user',
          arguments: { question, choices: ['Yes', 'No'] },
        }),
      ],
      null,
    );
    expect((entries[0] as ToolEntry).choices).toEqual(['Yes', 'No']);
  });

  // A typed reply has to survive intact, otherwise it cannot be told apart from the
  // offered options when the row is expanded.
  it('keeps a freeform answer whole rather than clamping it', () => {
    const long = `MariaDB ${'x'.repeat(300)}`;
    const entries = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 'q1',
          toolName: 'ask_user',
          arguments: { question, choices: ['PostgreSQL'] },
        }),
        event('tool.execution_complete', {
          toolCallId: 'q1',
          success: true,
          result: { content: `User responded: ${long}` },
        }),
      ],
      null,
    );
    expect((entries[0] as ToolEntry).answer).toBe(long);
  });

  it('ignores choices on tools that are not questions', () => {
    const entries = toEntries(
      [event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'ls' } })],
      null,
    );
    expect((entries[0] as ToolEntry).choices).toBeUndefined();
  });

  it('leaves a tool with no friendlier name showing its own', () => {
    const entries = toEntries(
      [event('tool.execution_start', { toolCallId: 't1', toolName: 'glob', arguments: { pattern: '**/*.ts' } })],
      null,
    );
    expect(entries[0]).toMatchObject({ name: 'glob', summary: '**/*.ts' });
    expect((entries[0] as ToolEntry).question).toBeUndefined();
  });

  it('prefers the name the CLI puts on the event', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 't1',
          toolName: 'web_fetch',
          toolTitle: 'Fetching web content',
          arguments: { url: 'https://example.com' },
        }),
      ],
      null,
    );
    expect(entries[0]).toMatchObject({ name: 'Fetching web content' });
  });
});

// React keys rows by this, and ToolRow holds its expanded state locally. If a key moves
// to a different entry the expansion moves with it, which is what loading older history
// used to do to every row on screen.
describe('entry identity', () => {
  const recent = [
    event('user.message', { content: 'latest' }, 'r1'),
    event('tool.execution_start', { toolCallId: 't9', toolName: 'powershell', arguments: { command: 'ls' } }, 'r2'),
  ];
  const older = [
    event('user.message', { content: 'ancient' }, 'o1'),
    event('assistant.message', { content: 'older reply' }, 'o2'),
  ];

  it('keeps keys unchanged when older history is prepended', () => {
    const before = toEntries(recent, null).map((e) => e.key);
    const after = toEntries([...older, ...recent], null).map((e) => e.key);

    expect(before).toEqual(['r1', 'r2']);
    expect(after.slice(-before.length)).toEqual(before);
  });

  it('gives every entry a distinct key', () => {
    const keys = toEntries([...older, ...recent], null).map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keys a tool by its start event, so completing it does not move the row', () => {
    const start = event(
      'tool.execution_start',
      { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'ls' } },
      's1',
    );
    const done = event('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'ok' } }, 's2');

    expect(toEntries([start], null)[0].key).toBe('s1');
    expect(toEntries([start, done], null)[0].key).toBe('s1');
  });

  // Only the app's own optimistic prompt lacks an id, and it always sits at the end.
  it('still produces a key for an event without an id', () => {
    const entries = toEntries([event('user.message', { content: 'optimistic' })], null);
    expect(entries[0].key).toBeTruthy();
  });
});

describe('sameEntry', () => {
  // Everything a tool row can draw, so the sweep below covers every field.
  const tool: ToolEntry = {
    kind: 'tool',
    key: 'k1',
    name: 'Asking user',
    summary: 'Pick one?',
    output: 'User responded: B',
    status: 'ok',
    question: true,
    answer: 'B',
    choices: ['A', 'B'],
    command: 'echo hi',
  };

  it('treats a rebuilt but identical entry as unchanged', () => {
    expect(sameEntry(tool, { ...tool, choices: ['A', 'B'] })).toBe(true);
  });

  /**
   * Rows are skipped on re-render when this returns true, so a field the row draws but
   * this does not compare would leave that row showing something stale. Adding a field
   * to ToolEntry means adding it above, and this fails until it is compared.
   */
  it('notices any drawn field changing', () => {
    const changed: Record<string, unknown> = {
      key: 'k2',
      name: 'powershell',
      summary: 'something else',
      output: 'different',
      status: 'failed',
      answer: 'A',
      choices: ['A'],
      command: 'echo bye',
    };

    for (const [field, value] of Object.entries(changed)) {
      expect(sameEntry(tool, { ...tool, [field]: value } as ToolEntry), `${field} was ignored`).toBe(false);
    }

    // question decides how the entry is built, and is never drawn.
    const undrawn = Object.keys(tool).filter((k) => k !== 'kind' && k !== 'question' && !(k in changed));
    expect(undrawn, 'new fields must be compared, or listed as never drawn').toEqual([]);
  });

  it('separates a message from a tool that shares its key', () => {
    const message: MessageEntry = { kind: 'message', key: 'k1', variant: 'user', body: 'hi' };
    expect(sameEntry(message, tool)).toBe(false);
    expect(sameEntry(message, { ...message, body: 'bye' })).toBe(false);
    expect(sameEntry(message, { ...message })).toBe(true);
  });
});

describe('a reply arriving live', () => {
  it('shows the partial text as it is written', () => {
    const entries = toEntries(
      [event('assistant.message_delta', { messageId: 'm1', deltaContent: 'The sea keeps' }, 'e1')],
      null,
    );
    expect(entries[0]).toMatchObject({ kind: 'message', variant: 'assistant', body: 'The sea keeps' });
  });

  // Same key, so the finished reply lands on the row its deltas were drawing rather than
  // replacing it and losing anything the row was doing.
  it('keys the partial and the finished reply as one row', () => {
    const partial = toEntries([event('assistant.message_delta', { messageId: 'm1', deltaContent: 'part' }, 'e1')], null);
    const done = toEntries([event('assistant.message', { messageId: 'm1', content: 'part and rest' }, 'e2')], null);

    expect(partial[0]!.key).toBe('m1');
    expect(done[0]!.key).toBe('m1');
  });

  it('falls back to the event when a message carries no id', () => {
    const entries = toEntries([event('assistant.message', { content: 'replayed' }, 'e1')], null);
    expect(entries[0]!.key).toBe('e1');
  });
});
