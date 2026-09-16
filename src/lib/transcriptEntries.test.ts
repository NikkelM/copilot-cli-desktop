import { describe, expect, it } from 'vitest';

import type { TranscriptEvent } from '../../shared/protocol';
import { sameEntry, toEntries, type MessageEntry, type ReasoningEntry, type ToolEntry } from './transcriptEntries';

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

  /**
   * A command that could not run answers something typed into the transcript, so it reads
   * as the reply to it rather than as a banner over the top of everything.
   */
  describe('a command that could not run', () => {
    it('reads as a failure in the transcript', () => {
      const entries = toEntries([event('command.failed', { text: 'Unknown command /exit.' }, 'e1')], null);

      expect(entries).toEqual([{ kind: 'message', key: 'e1', variant: 'failed', body: 'Unknown command /exit.' }]);
    });

    it('says nothing when there is nothing to say', () => {
      expect(toEntries([event('command.failed', {}, 'e1')], null)).toEqual([]);
    });
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

  it('summarises searches by what was looked for and where', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 'a',
          toolName: 'grep',
          arguments: { pattern: 'export function isIncomplete', paths: `${CWD}\\src\\lib\\elicitationForm.ts` },
        }),
        event('tool.execution_start', { toolCallId: 'b', toolName: 'powershell', arguments: { command: 'ls' } }),
      ],
      CWD,
    );
    expect((entries[0] as ToolEntry).summary).toBe('"export function isIncomplete" (src/lib/elicitationForm.ts)');
    expect((entries[1] as ToolEntry).summary).toBe('ls');
  });

  it('quotes a pattern searched with no path given', () => {
    const entries = toEntries(
      [event('tool.execution_start', { toolCallId: 'a', toolName: 'grep', arguments: { pattern: 'TODO', paths: [] } })],
      null,
    );
    expect((entries[0] as ToolEntry).summary).toBe('"TODO"');
  });

  // The tool takes either, and both turn up in real sessions.
  it('takes the search path as a string or as a list', () => {
    const one = toEntries(
      [event('tool.execution_start', { toolCallId: 'a', toolName: 'grep', arguments: { pattern: 'x', paths: 'src' } })],
      null,
    );
    const many = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 'a',
          toolName: 'grep',
          arguments: { pattern: 'x', paths: ['src', 'sidecar'] },
        }),
      ],
      null,
    );
    expect((one[0] as ToolEntry).summary).toBe('"x" (src)');
    expect((many[0] as ToolEntry).summary).toBe('"x" (src, sidecar)');
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
    expect(entries[0]).toMatchObject({ name: 'glob', summary: '"**/*.ts"' });
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

  // The three busiest tools after the shell, and the ones the CLI names rather than
  // showing the tool's own name. Without this a transcript reads "Shell", "Search",
  // "edit", "view", which looks like two different kinds of thing.
  it.each([
    ['view', 'Read'],
    ['create', 'Create'],
    ['edit', 'Edit'],
    ['str_replace', 'Edit'],
  ])('calls the %s tool %s, as the CLI does', (toolName, expected) => {
    const entries = toEntries(
      [event('tool.execution_start', { toolCallId: 't1', toolName, arguments: { path: 'notes.txt' } })],
      null,
    );
    expect(entries[0]).toMatchObject({ name: expected, summary: 'notes.txt' });
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
    search: true,
    patch: 'diff --git a/x b/x',
    path: 'src/a.ts',
    startedAt: '2026-09-05T12:00:00.000Z',
    endedAt: '2026-09-05T12:01:19.000Z',
  };

  // Everything a message row can draw, for the same reason.
  const message: MessageEntry = {
    kind: 'message',
    key: 'm1',
    variant: 'assistant',
    body: 'hello',
    at: '2026-09-05T12:00:00.000Z',
    preformatted: true,
    streaming: true,
    partial: true,
  };

  // And everything a reasoning row can draw.
  const reasoning: ReasoningEntry = {
    kind: 'reasoning',
    key: 'r1',
    body: 'thinking',
    streaming: true,
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
      search: undefined,
      patch: undefined,
      path: 'src/b.tsx',
      startedAt: '2026-09-05T12:00:01.000Z',
      endedAt: undefined,
    };

    for (const [field, value] of Object.entries(changed)) {
      expect(sameEntry(tool, { ...tool, [field]: value } as ToolEntry), `${field} was ignored`).toBe(false);
    }

    // question decides how the entry is built, and is never drawn.
    const undrawn = Object.keys(tool).filter((k) => k !== 'kind' && k !== 'question' && !(k in changed));
    expect(undrawn, 'new fields must be compared, or listed as never drawn').toEqual([]);
  });

  /**
   * The sweep above only sees fields the sample happens to carry, and twice now a field
   * has been added without one. This asks the builder itself what it produces, so a new
   * field fails here as soon as anything sets it.
   *
   * Every kind of entry, not just tools: a field added to a message or a reasoning row is
   * every bit as able to go undrawn, and for a while this only ever built tools.
   */
  it('compares every field toEntries can produce', () => {
    const built = [
      ...toEntries(
        [
          event('tool.execution_start', {
            toolCallId: 't1',
            toolName: 'powershell',
            arguments: { command: 'ls', description: 'List' },
          }),
          event('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'out' } }),
        ],
        null,
      ),
      ...toEntries(
        [event('tool.execution_start', { toolCallId: 't2', toolName: 'grep', arguments: { pattern: 'x' } })],
        null,
      ),
      ...toEntries(
        [
          event('tool.execution_start', {
            toolCallId: 'q1',
            toolName: 'ask_user',
            arguments: { question: 'Which?', choices: ['A'] },
          }),
          event('tool.execution_complete', { toolCallId: 'q1', success: true, result: { content: 'User responded: A' } }),
        ],
        null,
      ),
      // An edit that carries a patch, and one that was refused: the failed and cancelled
      // paths set fields the successful one never reaches.
      ...toEntries(
        [
          event('tool.execution_start', {
            toolCallId: 'e1',
            toolName: 'edit',
            arguments: { path: 'a.ts', old_str: 'one', new_str: 'two' },
          }),
          event('tool.execution_complete', { toolCallId: 'e1', success: false, result: { content: 'no match' } }),
        ],
        null,
      ),
      // A prompt, a reply, and the thinking that came with it.
      ...toEntries(
        [
          event('user.message', { content: 'hi' }),
          event('assistant.reasoning', { reasoningId: 'g1', content: 'weighing it up' }),
          event('assistant.message', { content: 'hello' }),
        ],
        null,
      ),
    ];

    const samples: Record<string, object> = { tool, message, reasoning };
    expect(new Set(built.map((entry) => entry.kind))).toEqual(new Set(Object.keys(samples)));

    for (const entry of built) {
      const accounted = new Set([...Object.keys(samples[entry.kind]!), 'kind']);
      expect(
        Object.keys(entry).filter((field) => !accounted.has(field)),
        `${entry.kind}: add it to the sample above and to sameEntry`,
      ).toEqual([]);
    }
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

describe('the model\u2019s thinking', () => {
  /**
   * Persisted on the assistant message rather than arriving as its own event, which is
   * why a session resumed weeks later still has it.
   */
  it('shows the reasoning kept with a reply', () => {
    const entries = toEntries(
      [
        event(
          'assistant.message',
          { messageId: 'm1', content: 'Using GraphQL variables instead', reasoningText: 'Quote escaping broke it' },
          'e1',
        ),
      ],
      null,
    );

    expect(entries.map((e) => e.kind)).toEqual(['reasoning', 'message']);
    expect(entries[0]).toMatchObject({ kind: 'reasoning', body: 'Quote escaping broke it' });
  });

  it('puts the thinking before the answer it produced', () => {
    const entries = toEntries(
      [event('assistant.message', { messageId: 'm1', content: 'the answer', reasoningText: 'the thinking' }, 'e1')],
      null,
    );
    expect(entries.map((e) => (e as { body: string }).body)).toEqual(['the thinking', 'the answer']);
  });

  it('says nothing when a reply came with none', () => {
    const entries = toEntries([event('assistant.message', { messageId: 'm1', content: 'just the answer' }, 'e1')], null);
    expect(entries.map((e) => e.kind)).toEqual(['message']);
  });

  // A message that only asked for a tool has no reply, but may still have reasoning.
  it('shows thinking that led only to a tool call', () => {
    const entries = toEntries(
      [event('assistant.message', { messageId: 'm1', content: '', reasoningText: 'I should look first' }, 'e1')],
      null,
    );
    expect(entries.map((e) => e.kind)).toEqual(['reasoning']);
  });

  it('keys thinking apart from the reply it belongs to', () => {
    const entries = toEntries(
      [event('assistant.message', { messageId: 'm1', content: 'answer', reasoningText: 'thinking' }, 'e1')],
      null,
    );
    expect(entries[0]!.key).not.toBe(entries[1]!.key);
  });

  it('notices thinking changing, so a row is not left stale', () => {
    const a: ReasoningEntry = { kind: 'reasoning', key: 'm1-why', body: 'first' };
    expect(sameEntry(a, { ...a })).toBe(true);
    expect(sameEntry(a, { ...a, body: 'second' })).toBe(false);
  });
});

describe('thinking as it is written', () => {
  it('shows a chunk as it arrives, open rather than folded away', () => {
    const entries = toEntries(
      [event('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'I should look first' }, 'e1')],
      null,
    );
    expect(entries[0]).toMatchObject({ kind: 'reasoning', body: 'I should look first', streaming: true });
  });

  /**
   * The message repeats at the end of a turn what the deltas already said. Showing both
   * would put the same thinking on screen twice, once open and once closed.
   */
  it('does not repeat thinking that already arrived as it was written', () => {
    const entries = toEntries(
      [
        event('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'the thinking' }, 'e1'),
        event('assistant.message', { messageId: 'm1', content: 'the answer', reasoningText: 'the thinking' }, 'e2'),
      ],
      null,
    );

    expect(entries.map((e) => e.kind)).toEqual(['reasoning', 'message']);
    expect(entries[0]).toMatchObject({ streaming: true });
  });

  // A replayed session never saw the deltas, so the message is the only record of it.
  it('shows thinking from the log folded away', () => {
    const entries = toEntries(
      [event('assistant.message', { messageId: 'm1', content: 'answer', reasoningText: 'the thinking' }, 'e1')],
      null,
    );
    expect(entries[0]).toMatchObject({ kind: 'reasoning', body: 'the thinking' });
    expect((entries[0] as ReasoningEntry).streaming).toBeFalsy();
  });

  it('keeps thinking from different blocks apart', () => {
    const entries = toEntries(
      [
        event('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'first' }, 'e1'),
        event('assistant.reasoning_delta', { reasoningId: 'r2', deltaContent: 'second' }, 'e2'),
      ],
      null,
    );
    expect(entries.map((e) => e.key)).toEqual(['r1', 'r2']);
  });
});

/**
 * The change a file tool made, shown where the tool is. Read from the log rather than
 * computed, so a session opened later shows what happened at the time.
 */
describe('a change made by a tool', () => {
  const patch = [
    'diff --git a/notes.txt b/notes.txt',
    'index 000..111 100644',
    '@@ -1,2 +1,2 @@',
    ' kept',
    '-was',
    '+now',
  ].join('\n');

  const edited = (detailedContent: string) => [
    event('tool.execution_start', { toolCallId: 't1', toolName: 'edit', arguments: { path: 'notes.txt' } }, 'e1'),
    event(
      'tool.execution_complete',
      { toolCallId: 't1', success: true, result: { content: 'File updated', detailedContent } },
      'e2',
    ),
  ];

  it('keeps the change the tool reported', () => {
    const entries = toEntries(edited(patch), null);
    expect((entries[0] as ToolEntry).patch).toBe(patch);
  });

  // Most tools return prose, which is not a change however it is described.
  it('keeps nothing when the detail is not a change', () => {
    const entries = toEntries(edited('Created the file with 63 characters'), null);
    expect((entries[0] as ToolEntry).patch).toBeUndefined();
  });

  it('notices a change differing, so a row is not left showing the old one', () => {
    const a = toEntries(edited(patch), null)[0] as ToolEntry;
    expect(sameEntry(a, { ...a })).toBe(true);
    expect(sameEntry(a, { ...a, patch: `${patch}\n+more` })).toBe(false);
  });
});

/**
 * A turn the reader stopped is not a turn that finished, and a reply that simply ends
 * mid-sentence reads as the app having lost the thread.
 */
describe('a stopped turn', () => {
  it('marks the transcript where the turn was stopped', () => {
    const entries = toEntries(
      [event('user.message', { content: 'go' }), event('abort', { reason: 'user_initiated' })],
      null,
    );

    expect(entries[1]).toMatchObject({ kind: 'message', variant: 'stopped', body: 'Cancelled by user' });
  });

  // Once the reply has ended, a turn the reader stopped and a turn something else stopped
  // look identical, so each says which it was.
  it.each([
    ['remote_command', 'Stopped by a remote command'],
    ['user_abort', 'Stopped by a connected server'],
    ['autopilot_credit_limit', 'Stopped: this run reached its credit limit'],
  ])('says what stopped it when it was not the reader (%s)', (reason, expected) => {
    const entries = toEntries([event('abort', { reason })], null);
    expect(entries[0]).toMatchObject({ body: expected });
  });

  it('falls back to saying it stopped when the reason is one it does not know', () => {
    const entries = toEntries([event('abort', { reason: 'something_new' })], null);
    expect(entries[0]).toMatchObject({ variant: 'stopped', body: 'Stopped' });
  });

  // Both happen at once, and the tool row losing its status was the bug that came first.
  it('cancels a running tool and marks the stop in one pass', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', { toolCallId: 't1', toolName: 'bash', arguments: {} }),
        event('abort', { reason: 'user_initiated' }),
      ],
      null,
    );

    expect((entries[0] as ToolEntry).status).toBe('cancelled');
    expect(entries[1]).toMatchObject({ variant: 'stopped' });
  });

  // Idling is how every turn ends, so marking it would put a rule under every reply.
  it.each(['session.idle', 'session.shutdown'])('says nothing when a turn merely ends (%s)', (type) => {
    expect(toEntries([event(type)], null)).toEqual([]);
  });
});

  /**
   * A reply that was cut off is the one thing the runtime never writes down: streamed text
   * is only recorded when a turn finishes, and a stopped turn never gets that far.
   */
  describe('what a stopped turn had already said', () => {
    it('shows the text against the abort that ended it', () => {
      const entries = toEntries(
        [event('user.message', { content: 'go' }), { ...event('abort', { reason: 'user_initiated' }), id: 'a1' }],
        null,
        new Map([['a1', 'I had started to say']]),
      );

      expect(entries[1]).toMatchObject({ kind: 'message', variant: 'assistant', body: 'I had started to say' });
    });

    // The text came before the stop, and reading them the other way round is nonsense.
    it('puts the text above the stop, not below it', () => {
      const entries = toEntries([{ ...event('abort', {}), id: 'a1' }], null, new Map([['a1', 'partial']]));

      expect(entries.map((entry) => (entry as { variant?: string }).variant)).toEqual(['assistant', 'stopped']);
    });

    it('marks it as cut off rather than passing it off as a reply', () => {
      const entries = toEntries([{ ...event('abort', {}), id: 'a1' }], null, new Map([['a1', 'partial']]));

      expect(entries[0]).toMatchObject({ partial: true });
    });

    it('says nothing extra when the turn was stopped before it spoke', () => {
      const entries = toEntries([{ ...event('abort', {}), id: 'a1' }], null, new Map());

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ variant: 'stopped' });
    });

    // Two stopped turns in one session each have their own remains.
    it('keeps each stop to its own text', () => {
      const entries = toEntries(
        [
          { ...event('abort', { reason: 'user_initiated' }), id: 'a1' },
          { ...event('abort', { reason: 'user_initiated' }), id: 'a2' },
        ],
        null,
        new Map([
          ['a1', 'first'],
          ['a2', 'second'],
        ]),
      );

      expect(entries.map((entry) => (entry as { body?: string }).body)).toEqual([
        'first',
        'Cancelled by user',
        'second',
        'Cancelled by user',
      ]);
    });
  });

/**
 * A command the reader typed with `!`. Verified against the runtime: it announces itself
 * as `tool.user_requested` with `toolName: "local_shell"` and completes as an ordinary
 * `tool.execution_complete` carrying `isUserRequested` (#134).
 */
describe('toEntries, a shell command the reader ran', () => {
  const started = event('tool.user_requested', {
    toolCallId: 'u1',
    toolName: 'local_shell',
    arguments: { command: 'git status', description: 'Execute shell command: git status' },
  });

  it('opens a row of its own rather than an unnamed orphan', () => {
    const entries = toEntries([started], CWD);
    expect(entries[0]).toMatchObject({ kind: 'tool', name: 'Shell', summary: 'git status', status: 'running' });
  });

  it('closes the row it opened, so the command and its output are one thing', () => {
    const entries = toEntries(
      [started, event('tool.execution_complete', { toolCallId: 'u1', isUserRequested: true, success: true, result: { content: 'clean' } })],
      CWD,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'ok', output: 'clean' });
  });

  /** The runtime's description restates the command, which would push it off the line. */
  it('prefers the command to the description the runtime wrote around it', () => {
    const entries = toEntries([started], CWD);
    expect((entries[0] as ToolEntry).summary).not.toContain('Execute shell command');
  });

  it('leaves an agent tool call summarised by its description', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', {
          toolCallId: 't1',
          toolName: 'powershell',
          arguments: { command: 'git status', description: 'Check the working tree' },
        }),
      ],
      CWD,
    );
    expect((entries[0] as ToolEntry).summary).toBe('Check the working tree');
  });

  it('reports a failed command as failed', () => {
    const entries = toEntries(
      [started, event('tool.execution_complete', { toolCallId: 'u1', success: false, error: { message: 'not a repo' } })],
      CWD,
    );
    expect(entries[0]).toMatchObject({ status: 'failed', output: 'not a repo' });
  });
});

/** Command output arrives with the colours a terminal would have shown, which this app cannot draw. */
describe('toEntries, terminal escapes in tool output', () => {
  it('strips them from what a tool printed', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'git status' } }),
        event('tool.execution_complete', {
          toolCallId: 't1',
          success: true,
          result: { content: '\u001B[32mclean\u001B[0m' },
        }),
      ],
      CWD,
    );
    expect((entries[0] as ToolEntry).output).toBe('clean');
  });

  it('strips them from what a failed tool reported', () => {
    const entries = toEntries(
      [
        event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'nope' } }),
        event('tool.execution_complete', {
          toolCallId: 't1',
          success: false,
          error: { message: "\u001B[31;1mThe term 'nope' is not recognized\u001B[0m" },
        }),
      ],
      CWD,
    );
    expect((entries[0] as ToolEntry).output).toBe("The term 'nope' is not recognized");
  });

  it('strips them from a row header too', () => {
    const entries = toEntries(
      [
        event('tool.user_requested', {
          toolCallId: 'u1',
          toolName: 'local_shell',
          arguments: { command: '\u001B[1mgit status\u001B[0m' },
        }),
      ],
      CWD,
    );
    expect((entries[0] as ToolEntry).summary).toBe('git status');
  });
});

/**
 * A long command sat with an empty row until it finished, which reads as a hang. The
 * runtime reports its output while it runs, so the row can say what it has produced.
 */
describe('toEntries, a tool reporting output while it runs', () => {
  const started = event('tool.execution_start', {
    toolCallId: 't1',
    toolName: 'powershell',
    arguments: { command: 'npm test' },
  });

  const chunk = (partialOutput: string) => event('tool.execution_partial_result', { toolCallId: 't1', partialOutput });

  it('shows what the tool has produced so far', () => {
    const entries = toEntries([started, chunk('line 1\nline 2')], CWD);
    expect(entries[0]).toMatchObject({ status: 'running', output: 'line 1\nline 2' });
  });

  /** The payload is everything so far, so the newest one is the whole answer. */
  it('replaces the earlier output rather than repeating it', () => {
    const entries = toEntries([started, chunk('line 1'), chunk('line 1\nline 2')], CWD);
    expect((entries[0] as ToolEntry).output).toBe('line 1\nline 2');
  });

  it('lets the finished result stand rather than leaving the last chunk in place', () => {
    const entries = toEntries(
      [
        started,
        chunk('line 1'),
        event('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'line 1\nline 2\ndone' } }),
      ],
      CWD,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'ok', output: 'line 1\nline 2\ndone' });
  });

  // Ephemeral events can outlive the row they described, for instance when history is
  // replayed underneath them.
  it('ignores output for a tool that is not running', () => {
    expect(toEntries([chunk('orphaned')], CWD)).toHaveLength(0);
  });
});

describe('a skill loading into the conversation', () => {
  const invoked = (data: Record<string, unknown>) => toEntries([event('skill.invoked', data, 'e1')], CWD);

  it('names the skill by the command that would invoke it', () => {
    const [entry] = invoked({ name: 'pdf-tools', commandName: 'pdf', description: 'Work with PDFs', trigger: 'user-invoked' });

    expect(entry).toMatchObject({ kind: 'tool', name: '/pdf', summary: 'Work with PDFs', status: 'ok' });
  });

  it('falls back to the skill\u2019s own name when it has no command', () => {
    const [entry] = invoked({ name: 'pdf-tools', description: 'Work with PDFs', trigger: 'agent-invoked' });

    expect(entry).toMatchObject({ name: 'pdf-tools' });
  });

  it('keeps the skill\u2019s content to read behind the row', () => {
    const [entry] = invoked({ name: 'pdf', content: '# PDF\n\nUse pdftk.' });

    expect((entry as ToolEntry).output).toBe('# PDF\n\nUse pdftk.');
  });

  it('trims content too long to be worth holding whole', () => {
    const [entry] = invoked({ name: 'pdf', content: 'x'.repeat(5000) });

    expect((entry as ToolEntry).output).toHaveLength(4001);
    expect((entry as ToolEntry).output?.endsWith('\u2026')).toBe(true);
  });

  it('records why the skill loaded', () => {
    expect((invoked({ name: 'a', trigger: 'user-invoked' })[0] as ToolEntry).skill).toBe('user');
    expect((invoked({ name: 'a', trigger: 'agent-invoked' })[0] as ToolEntry).skill).toBe('agent');
    expect((invoked({ name: 'a', trigger: 'context-load' })[0] as ToolEntry).skill).toBe('context');
  });

  it('treats an unfamiliar trigger as the reader\u2019s own doing', () => {
    expect((invoked({ name: 'a', trigger: 'something-new' })[0] as ToolEntry).skill).toBe('user');
    expect((invoked({ name: 'a' })[0] as ToolEntry).skill).toBe('user');
  });

  it('ignores an invocation that names no skill', () => {
    expect(invoked({ trigger: 'user-invoked' })).toEqual([]);
  });

  it('leaves a skill with no content unexpandable', () => {
    expect((invoked({ name: 'a' })[0] as ToolEntry).output).toBeNull();
  });
});
/**
 * A delegated task is drawn on the row that delegated it. The subagent's own work never
 * reaches here - it is filtered out of the transcript before it is read - so this row is
 * the whole account the parent conversation gets of it (#11).
 */
describe('a task handed to a subagent', () => {
  const started = (over: Record<string, unknown> = {}) => ({
    type: 'subagent.started',
    id: 'e2',
    agentId: 'agent-1',
    data: { toolCallId: 'call-1', agentName: 'explore', agentDisplayName: 'Explore Agent', ...over },
  });

  const call = { type: 'tool.execution_start', id: 'e1', data: { toolName: 'task', toolCallId: 'call-1' } };

  const delegated = (events: TranscriptEvent[]) =>
    toEntries(events as TranscriptEvent[], null).find((entry) => entry.kind === 'tool')?.delegated;

  it('names who took it', () => {
    expect(delegated([call, started()])).toEqual({ agent: 'Explore Agent' });
  });

  /** The display name is what the reader chose; the bare name is the fallback. */
  it('falls back to the agent name when there is no display name', () => {
    expect(delegated([call, started({ agentDisplayName: undefined })])?.agent).toBe('explore');
  });

  it('reports what it cost once it finishes', () => {
    const complete = {
      type: 'subagent.completed',
      id: 'e3',
      agentId: 'agent-1',
      data: { toolCallId: 'call-1', totalToolCalls: 47, totalTokens: 919206, durationMs: 139654 },
    };

    expect(delegated([call, started(), complete])).toEqual({
      agent: 'Explore Agent',
      outcome: 'completed',
      toolCalls: 47,
      tokens: 919206,
      durationMs: 139654,
    });
  });

  /** Sixteen of one real session's ninety-three subagents failed, so this is not an edge. */
  it('says when it failed', () => {
    const failed = { type: 'subagent.failed', id: 'e3', agentId: 'agent-1', data: { toolCallId: 'call-1' } };

    expect(delegated([call, started(), failed])?.outcome).toBe('failed');
  });

  /**
   * A session that stopped mid-run leaves a subagent that reached neither outcome - two of
   * one real log's fifty-five. Absent says that; a default would claim it finished.
   */
  it('claims no outcome for one still running', () => {
    expect(delegated([call, started()])?.outcome).toBeUndefined();
  });

  /**
   * The agent's own id has changed form across CLI versions - older sessions reuse the id
   * of the task tool call, newer ones mint a uuid, and one real log carries both. The tool
   * call named in the payload is the one thing every version agrees on.
   */
  it('ties back to the row through the tool call, whatever the agent id looks like', () => {
    const olderStyle = { ...started(), agentId: 'call-1' };
    expect(delegated([call, olderStyle])?.agent).toBe('Explore Agent');

    const newerStyle = { ...started(), agentId: '4bd05937-uuid' };
    expect(delegated([call, newerStyle])?.agent).toBe('Explore Agent');
  });

  it('leaves an ordinary tool call alone', () => {
    const shell = { type: 'tool.execution_start', id: 'e1', data: { toolName: 'powershell', toolCallId: 'call-2' } };

    expect(delegated([shell])).toBeUndefined();
  });

  // An outcome for a task this page never saw start has no row to be written on.
  it('ignores a completion whose delegation is not on this page', () => {
    const orphan = { type: 'subagent.completed', id: 'e3', agentId: 'agent-1', data: { toolCallId: 'gone' } };

    expect(() => toEntries([orphan] as TranscriptEvent[], null)).not.toThrow();
    expect(delegated([orphan])).toBeUndefined();
  });

  /** The row is rebuilt on every render, so a finished task must not go on saying it runs. */
  it('is compared field by field, so finishing redraws the row', () => {
    const before = toEntries([call, started()] as TranscriptEvent[], null);
    const after = toEntries(
      [call, started(), { type: 'subagent.completed', id: 'e3', agentId: 'agent-1', data: { toolCallId: 'call-1' } }] as TranscriptEvent[],
      null,
    );

    expect(sameEntry(before[0]!, after[0]!)).toBe(false);
  });
});

/**
 * A subagent's own timeline, built from its own events.
 *
 * Without being told whose it is, every one of them is read as somebody else's work and set
 * aside, and the view comes out empty - which is exactly what a subagent's transcript
 * looked like when it was first opened (#178).
 */
describe('building a subagent timeline on its own', () => {
  const own = [
    { type: 'user.message', id: 'e1', agentId: 'a1', data: { content: 'go and look' } },
    { type: 'assistant.message', id: 'e2', agentId: 'a1', data: { content: 'looking now' } },
    { type: 'tool.execution_start', id: 'e3', agentId: 'a1', data: { toolName: 'grep', toolCallId: 'c9' } },
  ] as TranscriptEvent[];

  it('draws the agent own work when told whose it is', () => {
    const entries = toEntries(own, null, undefined, 'a1');

    expect(entries.map((e) => e.kind)).toEqual(['message', 'message', 'tool']);
  });

  /**
   * Not told whose it is, the work is still somebody else's and is set aside - but set
   * aside is no longer the same as thrown away. It comes back under a row of its own.
   */
  it('gathers it under a row of its own when it is not told', () => {
    const entries = toEntries(own, null);

    expect(entries).toHaveLength(1);
    const row = entries[0]!;
    expect(row.kind).toBe('tool');
    expect(row.kind === 'tool' && row.children?.map((e) => e.kind)).toEqual(['message', 'message', 'tool']);
  });

  /** A subagent that delegates in turn still nests, rather than flattening into its parent. */
  it('still sets aside the work of an agent further down', () => {
    const nested = [
      ...own,
      { type: 'tool.execution_start', id: 'e4', agentId: 'a1', data: { toolName: 'task', toolCallId: 'c2' } },
      { type: 'subagent.started', id: 'e5', agentId: 'a2', data: { toolCallId: 'c2', agentName: 'explore' } },
      { type: 'assistant.message', id: 'e6', agentId: 'a2', data: { content: 'the deeper agent' } },
    ] as TranscriptEvent[];

    const entries = toEntries(nested, null, undefined, 'a1');
    const deeper = entries.find((e) => e.kind === 'tool' && e.delegated);

    expect(deeper?.kind === 'tool' && deeper.children?.length).toBe(1);
    expect(entries.some((e) => e.kind === 'message' && e.body === 'the deeper agent')).toBe(false);
  });
});

/**
 * A page is a window on a conversation, so a delegation that began before it leaves its
 * `task` call outside and its work with nothing to hang inside.
 *
 * That work used to be dropped, silently. Across 204 real sessions, 65 opening pages carry
 * subagent work and every one of them lost some: the worst read 150 events and drew three
 * rows.
 */
describe('subagent work whose delegating row is off the page', () => {
  const page = [
    { type: 'assistant.message', id: 'e1', agentId: 'a1', data: { content: 'still looking' } },
    { type: 'tool.execution_start', id: 'e2', agentId: 'a1', data: { toolName: 'grep', toolCallId: 'c5' } },
    { type: 'assistant.message', id: 'e3', data: { content: 'the session speaks' } },
  ] as TranscriptEvent[];

  it('keeps the work rather than dropping it', () => {
    const entries = toEntries(page, null);
    const row = entries.find((e) => e.kind === 'tool');

    expect(row?.kind === 'tool' && row.children?.length).toBe(2);
  });

  // It began before anything this page can show, so it reads as having started first.
  it('puts it above the work the page can account for', () => {
    const entries = toEntries(page, null);

    expect(entries[0]?.kind).toBe('tool');
    expect(entries[1]?.kind === 'message' && entries[1].body).toBe('the session speaks');
  });

  /** Named when the announcement is in the page even though the row it named is not. */
  it('says whose work it is when the page heard it start', () => {
    const announced = [
      { type: 'subagent.started', id: 'e0', agentId: 'a1', data: { toolCallId: 'gone', agentName: 'explore' } },
      ...page,
    ] as TranscriptEvent[];

    const row = toEntries(announced, null).find((e) => e.kind === 'tool');
    expect(row?.kind === 'tool' && row.delegated?.agent).toBe('explore');
  });

  /**
   * Scrolling up brings the real row into range, and everything here is rebuilt from the
   * events held - so the stand-in has to give way rather than sit beside it.
   */
  it('gives way once the delegating row is reached', () => {
    const whole = [
      { type: 'tool.execution_start', id: 'e0', data: { toolName: 'task', toolCallId: 'c1' } },
      { type: 'subagent.started', id: 'e0b', agentId: 'a1', data: { toolCallId: 'c1', agentName: 'explore' } },
      ...page,
    ] as TranscriptEvent[];

    const entries = toEntries(whole, null);
    const rows = entries.filter((e) => e.kind === 'tool');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === 'tool' && rows[0].children?.length).toBe(2);
  });
});

/**
 * A subagent that delegates in turn, seen from the session rather than from inside it.
 *
 * A lifecycle event names the child, so routing it by its own agentId filed it under the
 * agent it was announcing - and the inner agent's work reached no timeline at all. Real
 * sessions do this: 24 delegations from inside another agent across 190 logs here.
 */
describe('a delegation made from inside a subagent', () => {
  const events = [
    { type: 'tool.execution_start', id: 'e1', data: { toolName: 'task', toolCallId: 'c1' } },
    { type: 'subagent.started', id: 'e2', agentId: 'a1', data: { toolCallId: 'c1', agentName: 'outer' } },
    { type: 'assistant.message', id: 'e3', agentId: 'a1', data: { content: 'delegating further' } },
    { type: 'tool.execution_start', id: 'e4', agentId: 'a1', data: { toolName: 'task', toolCallId: 'c2' } },
    { type: 'subagent.started', id: 'e5', agentId: 'a2', data: { toolCallId: 'c2', agentName: 'inner' } },
    { type: 'assistant.message', id: 'e6', agentId: 'a2', data: { content: 'the deeper agent' } },
  ] as TranscriptEvent[];

  it('nests the inner agent inside the outer one', () => {
    const entries = toEntries(events, null);
    const outer = entries.find((e) => e.kind === 'tool');
    const inner = outer?.kind === 'tool' && outer.children?.find((e) => e.kind === 'tool' && e.delegated);

    expect(outer?.kind === 'tool' && outer.delegated?.agent).toBe('outer');
    expect(inner && inner.kind === 'tool' && inner.delegated?.agent).toBe('inner');
    expect(inner && inner.kind === 'tool' && inner.children?.length).toBe(1);
  });

  // One row at the top, not the inner agent's work loose beside its parent's.
  it('leaves nothing of it in the session timeline', () => {
    const entries = toEntries(events, null);

    expect(entries.filter((e) => e.kind === 'tool')).toHaveLength(1);
    expect(entries.some((e) => e.kind === 'message' && e.body === 'the deeper agent')).toBe(false);
  });
});
