// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import type { TranscriptEvent } from '../../shared/protocol';
import { Transcript } from './Transcript';

const event = (type: string, data: Record<string, unknown>, id: string): TranscriptEvent => ({ type, data, id });

const shell = (id: string, command: string, callId: string) => [
  event('tool.execution_start', { toolCallId: callId, toolName: 'powershell', arguments: { command } }, id),
  event(
    'tool.execution_complete',
    { toolCallId: callId, success: true, result: { content: `output of ${command}` } },
    `${id}-done`,
  ),
];

function show(events: TranscriptEvent[]) {
  return render(
    <Transcript
      events={events}
      sessionId="s1"
      cwd={null}
      hasOlder={true}
      loadingOlder={false}
      onLoadOlder={() => {}}
      reasoning
    />,
  );
}

describe('Transcript', () => {
  it('collapses tool output until the row is opened', async () => {
    show(shell('e1', 'ls', 't1'));
    expect(screen.queryByText('output of ls')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /ls/ }));
    expect(screen.getByText('output of ls')).toBeTruthy();
  });

  it('does not offer to expand a row with nothing behind it', () => {
    show([event('tool.execution_start', { toolCallId: 't1', toolName: 'grep', arguments: { pattern: 'x' } }, 'e1')]);
    expect(screen.getByRole('button', { name: /Search/ })).toHaveProperty('disabled', true);
  });

  // Reading what is running is exactly when it matters, and output only exists after.
  it('opens a command that is still running', async () => {
    show([
      event(
        'tool.execution_start',
        { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'sleep 30', description: 'Wait a while' } },
        'e1',
      ),
    ]);

    await userEvent.click(screen.getByRole('button', { name: /Wait a while/ }));
    expect(screen.getByText('sleep 30')).toBeTruthy();
  });

  it('shows the whole command however long the header had to clip it', async () => {
    const command = `Get-ChildItem ${'-Filter "*.tsv" '.repeat(30)}`.trim();
    const { container } = show([
      ...shell('e1', 'ls', 't1'),
      event(
        'tool.execution_start',
        { toolCallId: 't2', toolName: 'powershell', arguments: { command, description: 'Find the dump' } },
        'e2',
      ),
      event('tool.execution_complete', { toolCallId: 't2', success: true, result: { content: 'found it' } }, 'e3'),
    ]);

    await userEvent.click(screen.getByRole('button', { name: /Find the dump/ }));

    expect(screen.getByText('found it')).toBeTruthy();
    // The header clips; this is the only place the command can be read in full.
    expect(container.querySelector('.tool-command')?.textContent).toBe(command);
  });

  // The regression behind #80: rows were keyed by index, so prepending a page of history
  // shifted every key and handed each row's expanded state to a different entry.
  it('keeps a row expanded when older history is prepended', async () => {
    const recent = [...shell('e1', 'first', 't1'), ...shell('e2', 'second', 't2')];
    const { rerender } = show(recent);

    await userEvent.click(screen.getByRole('button', { name: /second/ }));
    expect(screen.getByText('output of second')).toBeTruthy();

    const older = [...shell('o1', 'ancient', 't9')];
    rerender(
      <Transcript
        events={[...older, ...recent]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
      reasoning
      />,
    );

    // The same row stays open, and the newly arrived rows stay shut.
    expect(screen.getByText('output of second')).toBeTruthy();
    expect(screen.queryByText('output of first')).toBeNull();
    expect(screen.queryByText('output of ancient')).toBeNull();
  });

  it('shows a question with the answer that was chosen', () => {    show([
      event(
        'tool.execution_start',
        { toolCallId: 'q1', toolName: 'ask_user', arguments: { question: 'Pick one?', choices: ['A', 'B'] } },
        'e1',
      ),
      event('tool.execution_complete', { toolCallId: 'q1', success: true, result: { content: 'User responded: B' } }, 'e2'),
    ]);

    expect(screen.getByText('Asking user')).toBeTruthy();
    expect(screen.getByText('Pick one?')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });
});

/**
 * jsdom has no layout, so scrollHeight and clientHeight are always zero and the
 * component can never tell where the reader is. They are defined here instead, which
 * makes the arithmetic the component does testable even though nothing is laid out.
 */
describe('following a reply as it is written', () => {
  const VIEWPORT = 300;

  function transcript(events: TranscriptEvent[]) {
    // The streaming row exists from the start, so growing it changes no entry count -
    // which is the whole point. Adding a row instead would pass without following text.
    const withDelta = (text: string): TranscriptEvent[] => [
      ...events,
      { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: text } },
    ];

    const draw = (text: string) => (
      <Transcript
        events={withDelta(text)}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
      reasoning
      />
    );

    const view = render(draw('The'));
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;

    let height = 1000;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => VIEWPORT });

    const grow = async (by: number, text: string) => {
      height += by;
      view.rerender(draw(text));
      // The observer that follows the text runs after the mutation, not during it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const scrollTo = (top: number) => {
      list.scrollTop = top;
      fireEvent.scroll(list);
    };

    return { list, grow, scrollTo, get height() { return height; } };
  }

  const reply = (text: string, id: string): TranscriptEvent => ({
    type: 'assistant.message',
    data: { content: text },
    id,
  });

  it('keeps the newest text in view while the reader is at the bottom', async () => {
    const t = transcript([reply('one', 'e1')]);
    t.scrollTo(1000 - VIEWPORT);

    await t.grow(200, 'a longer reply arriving');

    expect(t.list.scrollTop).toBe(t.height);
  });

  it('leaves the reader alone once they have scrolled away', async () => {
    const t = transcript([reply('one', 'e1')]);
    t.scrollTo(400);

    await t.grow(200, 'a longer reply arriving');

    expect(t.list.scrollTop).toBe(400);
  });

  // Scrolling away at all means the reader is looking at something.
  it('counts a small scroll away as having scrolled away', async () => {
    const t = transcript([reply('one', 'e1')]);
    t.scrollTo(1000 - VIEWPORT - 40);

    await t.grow(200, 'a longer reply arriving');

    expect(t.list.scrollTop).toBe(1000 - VIEWPORT - 40);
  });

  it('picks the reply back up when the reader returns to the bottom', async () => {
    const t = transcript([reply('one', 'e1')]);
    t.scrollTo(400);
    await t.grow(200, 'first growth');
    expect(t.list.scrollTop).toBe(400);

    t.scrollTo(t.height - VIEWPORT);
    await t.grow(200, 'second growth');

    expect(t.list.scrollTop).toBe(t.height);
  });
});

// The CLI reports how a search went; a search that found nothing is the one case with
// no output at all, so saying nothing leaves it indistinguishable from one still running.
describe('how a search went', () => {
  const searched = (id: string, output: string) => [
    event('tool.execution_start', { toolCallId: id, toolName: 'grep', arguments: { pattern: 'needle' } }, `${id}s`),
    event('tool.execution_complete', { toolCallId: id, success: true, result: { content: output } }, `${id}c`),
  ];

  it('counts what a search found', () => {
    show(searched('t1', 'one\ntwo\nthree'));
    expect(screen.getByText('3 matches')).toBeTruthy();
  });

  it('says so when a search found nothing', () => {
    show(searched('t1', ''));
    expect(screen.getByText('no matches')).toBeTruthy();
  });

  it('counts a single match as one', () => {
    show(searched('t1', 'only this'));
    expect(screen.getByText('1 match')).toBeTruthy();
  });

  it('says nothing about matches while the search is still running', () => {
    show([event('tool.execution_start', { toolCallId: 't1', toolName: 'grep', arguments: { pattern: 'x' } }, 'e1')]);
    expect(screen.queryByText('no matches')).toBeNull();
  });

  // A failed search reports an error, and counting its lines would read as matches.
  it('does not count the lines of a failed search', () => {
    show([
      event('tool.execution_start', { toolCallId: 't1', toolName: 'grep', arguments: { pattern: 'x' } }, 'e1'),
      event('tool.execution_complete', { toolCallId: 't1', success: false, error: { message: 'bad regex' } }, 'e2'),
    ]);
    expect(screen.queryByText(/match/)).toBeNull();
  });

  it('still counts lines for anything that is not a search', () => {
    show(shell('e1', 'ls', 't1'));
    expect(screen.getByText('1 line')).toBeTruthy();
  });
});

describe('a change shown on the tool that made it', () => {
  const patch = ['diff --git a/notes.txt b/notes.txt', '@@ -1,2 +1,2 @@', ' kept', '-was', '+now'].join('\n');

  const edited = () => [
    event('tool.execution_start', { toolCallId: 't1', toolName: 'edit', arguments: { path: 'notes.txt' } }, 'e1'),
    event(
      'tool.execution_complete',
      { toolCallId: 't1', success: true, result: { content: 'File updated', detailedContent: patch } },
      'e2',
    ),
  ];

  it('shows the change rather than the sentence saying it worked', async () => {
    const { container } = show(edited());

    await userEvent.click(screen.getByRole('button', { name: /notes\.txt/ }));

    expect(container.querySelector('tr.added .code')?.textContent).toBe('now');
    expect(container.querySelector('tr.removed .code')?.textContent).toBe('was');
    expect(screen.queryByText('File updated')).toBeNull();
  });

  it('says what the change came to before it is opened', () => {
    show(edited());
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
  });

  // Beside the file rather than at the right edge, where they read as part of its line
  // instead of as a separate column that has to be traced back.
  it('puts the counts next to the file they were made to', () => {
    const { container } = show(edited());
    const subject = container.querySelector('.tool-subject');

    expect(subject?.querySelector('.tool-counts')).toBeTruthy();
    expect(subject?.textContent).toBe('notes.txt+1−1');
  });

  it('numbers the lines on the side they exist', async () => {
    const { container } = show(edited());
    await userEvent.click(screen.getByRole('button', { name: /notes\.txt/ }));

    const removed = container.querySelectorAll('tr.removed .gutter');
    expect(removed[0]?.textContent).toBe('2');
    expect(removed[1]?.textContent).toBe('');
  });

  // A tool that returns prose still shows it; only a change replaces the output.
  it('still shows plain output for a tool that reported no change', async () => {
    show([
      event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'ls' } }, 'e1'),
      event('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'a.txt' } }, 'e2'),
    ]);

    await userEvent.click(screen.getByRole('button', { name: /ls/ }));
    expect(screen.getByText('a.txt')).toBeTruthy();
  });
});

describe('how a change is drawn', () => {
  const patched = (patch: string) => [
    event('tool.execution_start', { toolCallId: 't1', toolName: 'edit', arguments: { path: 'notes.txt' } }, 'e1'),
    event('tool.execution_complete', { toolCallId: 't1', success: true, result: { detailedContent: patch } }, 'e2'),
  ];

  const open = async () => userEvent.click(screen.getByRole('button', { name: /notes\.txt/ }));

  it('marks each line with what happened to it', async () => {
    const { container } = show(
      patched('diff --git a/n b/n\n@@ -1,2 +1,2 @@\n const kept = 1;\n-const x = 1;\n+const x = 2;'),
    );
    await open();

    expect(container.querySelector('tr.added .mark')?.textContent).toBe('+');
    expect(container.querySelector('tr.removed .mark')?.textContent).toBe('−');
    expect(container.querySelector('tr.context .mark')?.textContent).toBe('');
  });

  // The line changed, and within it this part did. One tone says only the former.
  it('marks the part of the line that changed', async () => {
    const { container } = show(
      patched('diff --git a/n b/n\n@@ -1,1 +1,1 @@\n-const total = count(a);\n+const total = count(b);'),
    );
    await open();

    const marked = [...container.querySelectorAll('tr.added mark')].map((n) => n.textContent);
    expect(marked).toEqual(['b']);
    expect(container.querySelector('tr.added .code')?.textContent).toBe('const total = count(b);');
  });

  it('steps over ground it has nothing to say about', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ` line ${i}`).join('\n');
    const { container } = show(patched(`diff --git a/n b/n\n@@ -1,32 +1,32 @@\n-was\n${many}\n+now`));
    await open();

    expect(container.querySelector('tr.skip')?.textContent).toContain('unchanged lines');
  });
});

/**
 * A count says what is in the row, not that the row is folded, so it stays when opened.
 * Hiding it meant the one moment you might want to check it against what you were reading
 * was the moment it vanished.
 */
describe('the file type a row wears', () => {
  const fileTool = (tool: string, path: string, success: boolean) => [
    event('tool.execution_start', { toolCallId: 'f1', toolName: tool, arguments: { path } }, 'a'),
    event('tool.execution_complete', { toolCallId: 'f1', success, result: { content: 'done' } }, 'b'),
  ];

  it('marks a settled file row with its type instead of a tick', () => {
    const { container } = show(fileTool('edit', 'src/App.tsx', true));
    const badge = container.querySelector('.tool-badge');

    expect(badge?.textContent).toBe('TX');
    expect(badge?.getAttribute('data-tone')).toBe('blue');
  });

  // The badge sits in the glyph's own column rather than beside it, so a row with one and
  // a row without still line up. It is not also a `.tool-status`: those are coloured by
  // outcome, and a badge answering to them would be painted green by the rule that let it
  // appear at all.
  it('puts the badge where the glyph would have been, without answering to the status', () => {
    const { container } = show(fileTool('view', 'main.rs', true));

    expect(container.querySelector('.tool-status')).toBeNull();
    expect(container.querySelector('.tool-badge')?.textContent).toBe('RS');
  });

  it('keeps the tick for a file whose type it does not know', () => {
    const { container } = show(fileTool('create', 'notes.txt', true));

    expect(container.querySelector('.tool-badge')).toBeNull();
    expect(container.querySelector('.tool-status')?.textContent).toBe('✓');
  });

  it('keeps the tick for a tool that names no file', () => {
    const { container } = show(shell('s', 'ls', 'c1'));

    expect(container.querySelector('.tool-badge')).toBeNull();
    expect(container.querySelector('.tool-status')?.textContent).toBe('✓');
  });

  // A failure has something to report, and reporting it beats naming the file's language.
  it('gives way to a failure', () => {
    const { container } = show(fileTool('edit', 'src/App.tsx', false));

    expect(container.querySelector('.tool-badge')).toBeNull();
    expect(container.querySelector('.tool-status')?.textContent).toBe('✕');
  });

  it('gives way to a call that is still running', () => {
    const { container } = show([
      event('tool.execution_start', { toolCallId: 'f1', toolName: 'edit', arguments: { path: 'a.ts' } }, 'a'),
    ]);

    expect(container.querySelector('.tool-badge')).toBeNull();
    expect(container.querySelector('.tool-status')?.textContent).toBe('·');
  });
});

describe('what a row says about itself', () => {
  it('keeps the line count when the row is opened', async () => {
    show(shell('e1', 'ls', 't1'));
    expect(screen.getByText('1 line')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /ls/ }));
    expect(screen.getByText('1 line')).toBeTruthy();
  });

  it('keeps the change counts when the diff is opened', async () => {
    show([
      event('tool.execution_start', { toolCallId: 't1', toolName: 'edit', arguments: { path: 'n.txt' } }, 'e1'),
      event(
        'tool.execution_complete',
        { toolCallId: 't1', success: true, result: { detailedContent: 'diff --git a/n b/n\n@@ -1 +1 @@\n-was\n+now' } },
        'e2',
      ),
    ]);

    await userEvent.click(screen.getByRole('button', { name: /n\.txt/ }));
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
  });

  it('keeps the option count when a question is opened', async () => {
    show([
      event(
        'tool.execution_start',
        { toolCallId: 'q1', toolName: 'ask_user', arguments: { question: 'Which?', choices: ['A', 'B'] } },
        'e1',
      ),
    ]);

    await userEvent.click(screen.getByRole('button', { name: /Which\?/ }));
    expect(screen.getByText('2 options')).toBeTruthy();
  });
});

/**
 * A failure is the one outcome worth reading without opening anything: the row otherwise
 * says only that something went wrong, and every one of them looks alike.
 */
describe('why a tool failed', () => {
  const failed = (message: string) => [
    event('tool.execution_start', { toolCallId: 't1', toolName: 'edit', arguments: { path: 'gone.txt' } }, 'e1'),
    event('tool.execution_complete', { toolCallId: 't1', success: false, error: { message } }, 'e2'),
  ];

  it('says what went wrong on the row itself', () => {
    show(failed('ENOENT: no such file or directory'));
    expect(screen.getByText('ENOENT: no such file or directory')).toBeTruthy();
  });

  it('shows only the first line, and keeps the rest behind the expander', async () => {
    const { container } = show(failed('Failed to apply the edit\n  at one\n  at two'));

    expect(container.querySelector('.tool-error')?.textContent).toBe('Failed to apply the edit');
    // The whole thing is still reachable, and the header carries it for a hover.
    expect(container.querySelector('.tool-error')?.getAttribute('title')).toContain('at two');

    await userEvent.click(screen.getByRole('button', { name: /gone\.txt/ }));
    expect(screen.getByText(/at two/)).toBeTruthy();
  });

  it('says nothing extra on a row that succeeded', () => {
    const { container } = show(shell('e1', 'ls', 't1'));
    expect(container.querySelector('.tool-error')).toBeNull();
  });
});

/**
 * Tool calls are scaffolding around the conversation rather than part of it. At the spacing
 * a message gets, half a dozen file edits fill the view.
 */
describe('how much room a run of tool calls takes', () => {
  it('sets tool rows tighter than messages', () => {
    const { container } = show([...shell('e1', 'ls', 't1'), event('user.message', { content: 'hello' }, 'e2')]);

    const entries = [...container.querySelectorAll('.entry')];
    expect(entries[0]?.className).toContain('tool-entry');
    expect(entries[1]?.className).not.toContain('tool-entry');
  });
});

/**
 * Whether a reply came seconds or hours after the message above it, which the transcript
 * otherwise gives no way to tell.
 */
describe('when a message was said', () => {
  const said = (at: string) => ({
    type: 'user.message',
    data: { content: 'hello' },
    id: 'u1',
    timestamp: at,
  });

  /**
   * A clock rather than "2h ago": the transcript is already in order, so what a reader
   * wants from a line is when it happened, not how far back it was.
   */
  it('shows the time a message was said', () => {
    const at = new Date(Date.now() - 7_200_000);
    show([said(at.toISOString())]);

    const expected = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(screen.getByText(expected)).toBeTruthy();
  });

  // The clock says nothing about the day, and a session can run over several.
  it('keeps the full moment for anyone who wants it', () => {
    const at = new Date(Date.now() - 7_200_000);
    show([said(at.toISOString())]);

    const shown = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(screen.getByText(shown).getAttribute('title')).toContain(at.getFullYear().toString());
  });

  it('says nothing when the event carried no time', () => {
    const { container } = show([{ type: 'user.message', data: { content: 'hello' }, id: 'u1' }]);

    expect(container.querySelector('time')).toBeNull();
  });
});

/**
 * A slow command should feel like progress rather than a hang, which is the whole reason
 * the CLI shows a duration against the action.
 */
describe('how long a tool call took', () => {
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('shows the length of a call that finished', () => {
    show([
      { ...event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'ls' } }, 'e1'), timestamp: at(80_000) },
      { ...event('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'out' } }, 'e2'), timestamp: at(1000) },
    ]);

    expect(screen.getByText('1m 19s')).toBeTruthy();
  });

  it('shows how long a call has been running', () => {
    show([
      { ...event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'ls' } }, 'e1'), timestamp: at(45_000) },
    ]);

    expect(screen.getByText('45s')).toBeTruthy();
  });

  // Without an end, an interrupted call would count for as long as the transcript is open.
  it('stops counting a call that was interrupted', () => {
    show([
      { ...event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'ls' } }, 'e1'), timestamp: at(120_000) },
      { ...event('abort', { reason: 'user_initiated' }, 'e2'), timestamp: at(60_000) },
    ]);

    expect(screen.getByText('1m 0s')).toBeTruthy();
  });

  it('says nothing about a call that was over in no time', () => {
    show([
      { ...event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'ls' } }, 'e1'), timestamp: at(1200) },
      { ...event('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'out' } }, 'e2'), timestamp: at(1000) },
    ]);

    expect(screen.queryByText(/\ds/)).toBeNull();
  });
});

/** ctrl+t, which the CLI offers because thinking is usually longer than the answer (#72). */
describe('showing or hiding the model thinking', () => {
  const thought = [
    event('assistant.reasoning', { reasoningId: 'r1', content: 'weighing two approaches' }, 'e1'),
    event('assistant.message', { messageId: 'm1', content: 'the second one' }, 'e2'),
  ];

  const withReasoning = (reasoning: boolean) =>
    render(
      <Transcript
        events={thought}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        reasoning={reasoning}
      />,
    );

  it('shows it when it is on', () => {
    withReasoning(true);
    expect(screen.getByText('Thinking')).toBeTruthy();
  });

  it('leaves it out entirely when it is off', () => {
    withReasoning(false);
    expect(screen.queryByText('Thinking')).toBeNull();
  });

  // Turning off the thinking must not take the answer it produced with it.
  it('keeps the reply either way', () => {
    withReasoning(false);
    expect(screen.getByText('the second one')).toBeTruthy();
  });
});

describe('a skill in the transcript', () => {
  const skill = (data: Record<string, unknown>) => show([event('skill.invoked', data, 'e1')]);

  it('marks the row as a skill rather than a finished tool', () => {
    const { container } = skill({ name: 'pdf', commandName: 'pdf', description: 'Work with PDFs' });

    expect(container.querySelector('.tool-status')?.textContent).toBe('\u25C8');
  });

  it('says when the agent reached for the skill itself', () => {
    skill({ name: 'pdf', trigger: 'agent-invoked' });

    expect(screen.getByText('skill the agent reached for')).toBeTruthy();
  });

  it('says when the skill arrived with the agent', () => {
    skill({ name: 'pdf', trigger: 'context-load' });

    expect(screen.getByText('skill loaded with the agent')).toBeTruthy();
  });

  // Telling the reader they invoked something, on the row they invoked it from, is noise.
  it('stays quiet about a skill the reader invoked', () => {
    const { container } = skill({ name: 'pdf', trigger: 'user-invoked' });

    expect(container.querySelector('.tool-note')).toBeNull();
  });

  it('holds the skill\u2019s instructions behind the row', async () => {
    skill({ name: 'pdf', description: 'Work with PDFs', content: 'Use pdftk for everything.' });
    expect(screen.queryByText('Use pdftk for everything.')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /pdf/ }));
    expect(screen.getByText('Use pdftk for everything.')).toBeTruthy();
  });

  // A skill names no file, so its row keeps the marker rather than taking a file's badge,
  // even when the skill is named after one.
  it('never wears a file badge', () => {
    const { container } = skill({ name: 'build.ts', content: 'x' });

    expect(container.querySelector('.tool-badge')).toBeNull();
  });
});

// Same reason the block above defines scroll metrics by hand: jsdom lays nothing out, so
// without them the component can never tell where the reader is.
describe('giving back history once the reader is following again', () => {
  const VIEWPORT = 300;
  const HEIGHT = 1000;
  const BOTTOM = HEIGHT - VIEWPORT;
  const DWELL = 10_000;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function mounted(over: Partial<ComponentProps<typeof Transcript>> = {}) {
    const onDropOlder = vi.fn();
    const props: ComponentProps<typeof Transcript> = {
      events: [event('assistant.message', { content: 'hello' }, 'e1')],
      sessionId: 's1',
      cwd: null,
      hasOlder: true,
      loadingOlder: false,
      onLoadOlder: () => {},
      extraPages: true,
      onDropOlder,
      reasoning: true,
      ...over,
    };

    const view = render(<Transcript {...props} />);
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => HEIGHT });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => VIEWPORT });

    const scrollTo = (top: number) => {
      list.scrollTop = top;
      fireEvent.scroll(list);
    };
    const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

    return { onDropOlder, scrollTo, wait, view, props };
  }

  it('gives it back once the view has followed the bottom for long enough', () => {
    const t = mounted();

    t.scrollTo(BOTTOM);
    t.wait(DWELL);

    expect(t.onDropOlder).toHaveBeenCalledTimes(1);
  });

  // Touching the bottom on the way past is not the same as having finished with what is above.
  it('does not give it back to a view merely passing the bottom', () => {
    const t = mounted();

    t.scrollTo(BOTTOM);
    t.wait(DWELL / 2);
    t.scrollTo(400);
    t.wait(DWELL);

    expect(t.onDropOlder).not.toHaveBeenCalled();
  });

  it('waits rather than acting the moment the bottom is reached', () => {
    const t = mounted();

    t.scrollTo(BOTTOM);
    t.wait(DWELL - 1);

    expect(t.onDropOlder).not.toHaveBeenCalled();
  });

  // A streamed reply scrolls the view itself, which fires a scroll for every chunk. Were
  // each to restart the wait, a reply longer than the dwell would never reach the end of it.
  it('keeps counting through a reply that is scrolling the view itself', () => {
    const t = mounted();

    t.scrollTo(BOTTOM);
    t.wait(DWELL / 2);
    t.scrollTo(BOTTOM);
    t.wait(DWELL / 2);

    expect(t.onDropOlder).toHaveBeenCalledTimes(1);

    // Each of those scrolls leaving a wait of its own behind would come due later.
    t.wait(DWELL * 2);
    expect(t.onDropOlder).toHaveBeenCalledTimes(1);
  });

  it('leaves it alone while a page is still being fetched', () => {
    const t = mounted({ loadingOlder: true });

    t.scrollTo(BOTTOM);
    t.wait(DWELL);

    expect(t.onDropOlder).not.toHaveBeenCalled();
  });

  it('does nothing for a session that never reached back', () => {
    const t = mounted({ extraPages: false });

    t.scrollTo(BOTTOM);
    t.wait(DWELL);

    expect(t.onDropOlder).not.toHaveBeenCalled();
  });

  // The pages belong to the session that loaded them, and it is no longer on screen.
  it('stops counting when the reader moves to another session', () => {
    const t = mounted();

    t.scrollTo(BOTTOM);
    t.wait(DWELL / 2);
    t.view.rerender(<Transcript {...t.props} sessionId="s2" />);
    t.wait(DWELL);

    expect(t.onDropOlder).not.toHaveBeenCalled();
  });

  it('gives it back only once for one stay at the bottom', () => {
    const t = mounted();

    t.scrollTo(BOTTOM);
    t.wait(DWELL * 3);

    expect(t.onDropOlder).toHaveBeenCalledTimes(1);
  });

  // The rows go from above the view, so without this the reader is left looking at
  // whatever the removal left under their scroll position instead of the newest reply.
  it('keeps the reader at the bottom when the rows go', () => {
    const older = [
      event('assistant.message', { content: 'older one' }, 'e0'),
      event('assistant.message', { content: 'older two' }, 'e1'),
      event('assistant.message', { content: 'newest' }, 'e2'),
    ];
    const t = mounted({ events: older });
    t.scrollTo(BOTTOM);

    act(() => t.view.rerender(<Transcript {...t.props} events={older.slice(-1)} />));

    const list = t.view.container.querySelector('ol.transcript') as HTMLOListElement;
    expect(list.scrollTop).toBe(list.scrollHeight);
  });
});