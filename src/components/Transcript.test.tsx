// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import type { TranscriptEvent } from '../../shared/protocol';
import { ASSUMED_DISPLAY } from '../lib/useCliDisplay';
import { Transcript } from './Transcript';
import { resetStores } from '../lib/store';

const event = (type: string, data: Record<string, unknown>, id: string): TranscriptEvent => ({ type, data, id });

const shell = (id: string, command: string, callId: string) => [
  event('tool.execution_start', { toolCallId: callId, toolName: 'powershell', arguments: { command } }, id),
  event(
    'tool.execution_complete',
    { toolCallId: callId, success: true, result: { content: `output of ${command}` } },
    `${id}-done`,
  ),
];

/**
 * The whole sentence the find bar is saying, box and all.
 *
 * The number it is on is a field now, so it has no text of its own to read - and a reader
 * sees one sentence rather than a control wedged into a label.
 */
function findCount(): string {
  const box = screen.queryByRole('textbox', { name: /^Match/ }) as HTMLInputElement | null;
  const rest = screen.getByRole('status').textContent ?? '';
  return box ? box.value + rest : rest;
}

function show(events: TranscriptEvent[]) {
  return render(
    <Transcript
      events={events}
      sessionId="s1"
      cwd={null}
      hasOlder={true}
      loadingOlder={false}
      onLoadOlder={() => {}}
      display={ASSUMED_DISPLAY}
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
      display={ASSUMED_DISPLAY}
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
      display={ASSUMED_DISPLAY}
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
      fireEvent.wheel(list);
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

  const tree = (reasoning: boolean) => (
    <Transcript
      events={thought}
      sessionId="s1"
      cwd={null}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
      display={{ ...ASSUMED_DISPLAY, showReasoning: reasoning }}
    />
  );

  const withReasoning = (reasoning: boolean) => render(tree(reasoning));

  it('shows it when it is on', () => {
    withReasoning(true);
    expect(screen.getByText('Thinking')).toBeTruthy();
  });

  /**
   * Folded rather than dropped, which is what the CLI does: its own timeline keeps the
   * `Thought for 12s` line whatever the setting says. Dropped, there was nothing left to
   * say a turn had reasoned at all, and the transcript read as though history were missing.
   */
  it('folds it away rather than dropping it when it is off', () => {
    const { container } = withReasoning(false);

    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(container.querySelector('.reasoning-body')).toBeNull();
  });

  /** The key still has to do something to the transcript the reader is looking at. */
  it('unfolds what is already drawn when it is turned on', () => {
    const { container, rerender } = withReasoning(false);

    rerender(tree(true));

    expect(container.querySelector('.reasoning-body')).toBeTruthy();
  });

  it('folds what is already drawn when it is turned off', () => {
    const { container, rerender } = withReasoning(true);

    rerender(tree(false));

    expect(container.querySelector('.reasoning-body')).toBeNull();
  });

  /**
   * Read back from a log rather than watched arriving, which is the common case. Folded
   * whatever the setting says: thinking is longer than the answer it produced, and a
   * transcript that opens with every turn's reasoning spread out is one nobody can scan.
   */
  it('leaves thinking read back from a log folded', () => {
    const { container } = render(
      <Transcript
        events={[
          event('assistant.message', { messageId: 'm1', content: 'the second one', reasoningText: 'weighing two approaches' }, 'e1'),
        ]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );

    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(container.querySelector('.reasoning-body')).toBeNull();
  });

  /**
   * The caret is one shape turned rather than two glyphs, so the direction it points is a
   * state the stylesheet reads. Nothing else here would notice it having stopped turning.
   */
  it('turns the caret with the row', async () => {
    const user = userEvent.setup();
    const { container } = withReasoning(true);
    const caret = () => container.querySelector('.caret')?.getAttribute('data-open');

    // Thinking arriving opens itself, so this row starts open and the caret must agree.
    expect(caret()).toBe('true');
    await user.click(screen.getByText('Thinking'));
    expect(caret()).toBe('false');
    await user.click(screen.getByText('Thinking'));
    expect(caret()).toBe('true');
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

    expect(screen.getByText('skill invoked by the agent')).toBeTruthy();
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

/**
 * History cut to fit the window, drawn so it reads as loss (#7).
 *
 * The row succeeded, so by status it is a success - and a green tick beside "337 messages
 * dropped" says the opposite of what happened. It also must not be confusable with a
 * compaction, which leaves a summary behind, or with an interrupted tool, which did not
 * lose anything at all.
 */
describe('truncation in the transcript', () => {
  const cut = (over: Record<string, unknown> = {}) =>
    show([
      event(
        'session.truncation',
        {
          tokenLimit: 200000,
          postTruncationTokensInMessages: 188898,
          tokensRemovedDuringTruncation: 377798,
          messagesRemovedDuringTruncation: 337,
          ...over,
        },
        'e1',
      ),
    ]);

  it('says what went, on the row', () => {
    cut();

    expect(screen.getByText('Truncated')).toBeTruthy();
    expect(screen.getByText('337 messages, 377,798 tokens')).toBeTruthy();
  });

  /** The difference from a compaction, which is the whole of what the row has to say. */
  it('says that nothing stands in for what went', () => {
    cut();

    expect(screen.getByText('no summary kept')).toBeTruthy();
  });

  it('wears a marker of its own rather than a finished tool\u2019s tick', () => {
    const { container } = cut();

    const glyph = container.querySelector('.tool-status')?.textContent;
    expect(glyph).not.toBe('\u2713');
    // Nor a compaction's, nor an interrupted tool's: three different things happened.
    expect(glyph).not.toBe('\u233E');
    expect(glyph).not.toBe('\u2298');
  });

  /** Green says a success and this is a loss, so the row is marked for the stylesheet. */
  it('is marked as having lost something', () => {
    const { container } = cut();

    expect(container.querySelector('.tool.lossy')).toBeTruthy();
  });

  /** There is no summary, so opening it would show an empty panel. */
  it('does not open, because there is nothing behind it', () => {
    const { container } = cut();

    const head = container.querySelector('.tool-head') as HTMLButtonElement;
    expect(head.disabled).toBe(true);
  });

  it('leaves an ordinary tool unmarked', () => {
    const { container } = show([
      event('tool.execution_start', { toolCallId: 't1', toolName: 'bash' }, 'e1'),
      event('tool.execution_complete', { toolCallId: 't1', result: 'done' }, 'e2'),
    ]);

    expect(container.querySelector('.tool.lossy')).toBeNull();
    expect(container.querySelector('.tool-note')).toBeNull();
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
      display: ASSUMED_DISPLAY,
      ...over,
    };

    const view = render(<Transcript {...props} />);
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => HEIGHT });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => VIEWPORT });

    const scrollTo = (top: number) => {
      fireEvent.wheel(list);
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
/**
 * A subagent's transcript, opened from the sidebar. Its events are its own, so the view has
 * to be told whose they are or every one of them is set aside as somebody else's and the
 * pane comes out empty (#178).
 */
describe('Transcript showing a subagent', () => {
  const own = [
    { type: 'user.message', id: 'e1', agentId: 'a1', data: { content: 'go and look' } },
    { type: 'assistant.message', id: 'e2', agentId: 'a1', data: { content: 'looking now' } },
  ] as TranscriptEvent[];

  const shownFor = (ofAgent?: string) =>
    render(
      <Transcript
        events={own}
        sessionId="a1"
        cwd={null}
        ofAgent={ofAgent}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );

  it('shows the work when told whose it is', () => {
    shownFor('a1');

    expect(screen.getByText('go and look')).toBeTruthy();
    expect(screen.getByText('looking now')).toBeTruthy();
  });

  /**
   * Not told whose it is, the work is another agent's and belongs behind a row rather than
   * in the timeline. The row is collapsed, so none of it is drawn until it is asked for.
   */
  it('folds it behind a row without that, rather than reading as the session own', () => {
    const view = shownFor(undefined);

    expect(screen.queryByText('looking now')).toBeNull();
    expect(view.container.querySelector('.tool')).toBeTruthy();
  });
});

/**
 * A page can draw far fewer rows than the events behind it: a delegation whose call is
 * further back than the page reaches collapses into a single row however much work it did.
 * A list shorter than its own box never scrolls, and reaching back is driven by scrolling,
 * so without this there is no way to ask for what is above.
 */
describe('a page too short to scroll', () => {
  const short = [{ type: 'assistant.message', id: 'e1', data: { content: 'hi' } }] as TranscriptEvent[];

  const mountShort = (onLoadOlder: () => void, heights: { scroll: number; client: number }) => {
    const view = render(
      <Transcript
        events={short}
        sessionId="s1"
        cwd={null}
        hasOlder
        loadingOlder={false}
        onLoadOlder={onLoadOlder}
        display={ASSUMED_DISPLAY}
      />,
    );
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => heights.scroll });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => heights.client });
    return { view, list };
  };

  it('asks for more when the rows do not fill the view', () => {
    const onLoadOlder = vi.fn();
    const heights = { scroll: 0, client: 600 };
    const { view } = mountShort(onLoadOlder, heights);

    heights.scroll = 40;
    act(() => view.rerender(
      <Transcript events={short} sessionId="s1" cwd={null} hasOlder loadingOlder={false} onLoadOlder={onLoadOlder} display={ASSUMED_DISPLAY} />,
    ));

    expect(onLoadOlder).toHaveBeenCalled();
  });

  it('leaves a page that already fills the view alone', () => {
    const onLoadOlder = vi.fn();
    const heights = { scroll: 0, client: 600 };
    const { view } = mountShort(onLoadOlder, heights);

    heights.scroll = 2000;
    act(() => view.rerender(
      <Transcript events={short} sessionId="s1" cwd={null} hasOlder loadingOlder={false} onLoadOlder={onLoadOlder} display={ASSUMED_DISPLAY} />,
    ));

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  /** A session made almost entirely of delegated work would otherwise load all of itself. */
  it('gives up rather than fetching the whole session', () => {
    const onLoadOlder = vi.fn();
    const heights = { scroll: 0, client: 600 };
    const { view } = mountShort(onLoadOlder, heights);
    heights.scroll = 40;

    for (let round = 0; round < 12; round++) {
      act(() => view.rerender(
        <Transcript events={short} sessionId="s1" cwd={null} hasOlder loadingOlder={false} onLoadOlder={onLoadOlder} display={ASSUMED_DISPLAY} />,
      ));
    }

    // Asking again for a page that brought nothing back would be asking the same question
    // on every render for as long as the session stayed open.
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  /**
   * The case the old cap got wrong. It counted tries, and a try is worth anything from one
   * row to a hundred - so four of them filled a screen of ordinary conversation and bought
   * almost nothing in a session that is mostly delegated work, where one delegation collapses
   * a whole page of events into a single row. That session opened on one row and a button.
   */
  it('keeps filling while the pages it asks for bring something back', () => {
    const onLoadOlder = vi.fn();
    const heights = { scroll: 0, client: 600 };
    const { view } = mountShort(onLoadOlder, heights);
    heights.scroll = 40;

    // Each page arrives and collapses into the row already drawn, as a delegation does.
    let events = short;
    for (let round = 0; round < 8; round++) {
      events = [...events, { type: 'assistant.message', id: `more-${round}`, data: { content: 'x' } } as TranscriptEvent];
      act(() => view.rerender(
        <Transcript events={events} sessionId="s1" cwd={null} hasOlder loadingOlder={false} onLoadOlder={onLoadOlder} display={ASSUMED_DISPLAY} />,
      ));
    }

    expect(onLoadOlder.mock.calls.length).toBeGreaterThan(4);
  });

  /**
   * And the bound that replaced the try count. Pages that keep arriving would otherwise be
   * asked for until the session ran out, which is what the old cap was there to prevent.
   */
  it('stops once it has pulled in enough on its own', () => {
    const onLoadOlder = vi.fn();
    const heights = { scroll: 0, client: 600 };
    const { view } = mountShort(onLoadOlder, heights);
    heights.scroll = 40;

    // A page at a time, as the sidecar hands them over, and every one of them collapses.
    let events = short;
    for (let page = 0; page < 10; page++) {
      events = [
        ...events,
        ...Array.from(
          { length: 150 },
          (_, index) => ({ type: 'assistant.message', id: `p${page}-${index}`, data: { content: 'x' } }) as TranscriptEvent,
        ),
      ];
      act(() => view.rerender(
        <Transcript events={events} sessionId="s1" cwd={null} hasOlder loadingOlder={false} onLoadOlder={onLoadOlder} display={ASSUMED_DISPLAY} />,
      ));
    }

    // Six pages' worth, so the seventh render is the one that stops asking.
    expect(onLoadOlder.mock.calls.length).toBeLessThanOrEqual(7);
  });
});

/**
 * The bug this exists for: the window grew for as long as the reader stayed in the session,
 * and only leaving and coming back brought it down (#184). Reaching back is not the only way
 * to end up drawing too much, so settling cannot be conditional on having reached back.
 */
describe('coming back to a workable window while the reader follows along', () => {
  const VIEWPORT = 300;
  const HEIGHT = 1000;
  const BOTTOM = HEIGHT - VIEWPORT;
  const DWELL = 10_000;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Replies long enough that a few hundred of them are far past any budget. */
  const said = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      event('assistant.message', { content: 'x'.repeat(1024) }, `e${index}`),
    );

  function mounted(events: TranscriptEvent[], over: Partial<ComponentProps<typeof Transcript>> = {}) {
    const props: ComponentProps<typeof Transcript> = {
      events,
      sessionId: 's1',
      cwd: null,
      hasOlder: false,
      loadingOlder: false,
      extraPages: false,
      display: ASSUMED_DISPLAY,
      ...over,
    };

    const view = render(<Transcript {...props} />);
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => HEIGHT });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => VIEWPORT });

    return {
      view,
      props,
      // li.entry rather than every li: the list always carries a history-edge marker.
      rows: () => view.container.querySelectorAll('ol.transcript > li.entry').length,
      grow: (to: number) => view.rerender(<Transcript {...props} events={said(to)} />),
      scrollTo: (top: number) => {
        fireEvent.wheel(list);
        list.scrollTop = top;
        fireEvent.scroll(list);
      },
      wait: (ms: number) => act(() => void vi.advanceTimersByTime(ms)),
    };
  }

  it('draws everything a long session accumulated, until it settles', () => {
    const t = mounted(said(4));
    t.grow(400);

    expect(t.rows()).toBe(400);
  });

  it('comes back down once the view has followed the bottom for long enough', () => {
    const t = mounted(said(4));
    t.grow(400);

    t.scrollTo(BOTTOM);
    t.wait(DWELL);

    expect(t.rows()).toBeLessThan(400);
  });

  // The whole point: this session never scrolled up, so it has no pages to give back.
  it('does so for a session that never reached back', () => {
    const t = mounted(said(4), { extraPages: false });
    t.grow(400);

    t.scrollTo(BOTTOM);
    t.wait(DWELL);

    expect(t.rows()).toBeLessThan(400);
  });

  it('waits rather than trimming the moment the bottom is reached', () => {
    const t = mounted(said(4));
    t.grow(400);

    t.scrollTo(BOTTOM);
    t.wait(DWELL - 1);

    expect(t.rows()).toBe(400);
  });

  // Trimming from the top while someone is reading up there would move the text under them.
  it('leaves the window alone while the reader is reading above it', () => {
    const t = mounted(said(4));
    t.grow(400);

    t.scrollTo(0);
    t.wait(DWELL * 2);

    expect(t.rows()).toBe(400);
  });

  /**
   * The budget counts text; a tool row holds far more of it than it draws, since its output
   * is collapsed. So a page can be many times over budget and barely taller than its box,
   * and trimming it to the budget left it too short to scroll - whereupon the auto-fill that
   * keeps such a page reachable widened it straight back, and the page visibly vanished and
   * returned (#232).
   *
   * jsdom lays nothing out, so the rows are given a height here. That is the whole subject:
   * without one, there is no way to know how few rows the view can afford to lose.
   */
  describe('trimming a page whose rows are taller than its budget suggests', () => {
    /**
     * Each drawn row a hundredth of the viewport, so it takes a hundred of them to fill it -
     * comfortably more than the budget keeps, which is what makes the floor the thing being
     * measured rather than a number the budget would have reached anyway.
     */
    const measured = (view: ReturnType<typeof render>) => {
      for (const row of view.container.querySelectorAll('ol.transcript > li.entry')) {
        Object.defineProperty(row, 'offsetHeight', { configurable: true, get: () => VIEWPORT / 100 });
      }
    };

    const settled = (withHeights: boolean) => {
      const t = mounted(said(4));
      t.grow(400);
      if (withHeights) measured(t.view);

      t.scrollTo(BOTTOM);
      t.wait(DWELL);
      return t.rows();
    };

    it('keeps enough to fill the view, which the budget alone does not', () => {
      const budgetAlone = settled(false);

      expect(settled(true), 'a hundred rows of a hundredth each is what the box holds').toBeGreaterThan(
        budgetAlone,
      );
    });

    // Still a trim: what the view does not need is still given back.
    it('gives back everything above what the view needs', () => {
      expect(settled(true)).toBeLessThan(400);
    });
  });

  it('keeps the newest entries, which are the ones being followed', () => {
    const t = mounted(said(4));
    t.grow(400);

    t.scrollTo(BOTTOM);
    t.wait(DWELL);

    expect(t.view.container.querySelector('ol.transcript > li.entry:last-child')?.textContent).toContain('x');
    expect(t.rows()).toBeGreaterThan(0);
  });

  it('goes on following the reply after it has trimmed', () => {
    const t = mounted(said(4));
    t.grow(400);
    t.scrollTo(BOTTOM);
    t.wait(DWELL);
    const settled = t.rows();

    t.grow(410);

    expect(t.rows()).toBe(settled + 10);
  });

  it('trims again as the session goes on growing', () => {
    const t = mounted(said(4));
    t.grow(400);
    t.scrollTo(BOTTOM);
    t.wait(DWELL);
    const settled = t.rows();

    t.grow(900);
    t.scrollTo(BOTTOM);
    t.wait(DWELL);

    expect(t.rows()).toBeLessThanOrEqual(settled + 1);
  });

  // A session that opens and is left alone has already been budgeted; settling must not
  // then reach for four times as much because the reader paused at the bottom.
  it('does not widen the window of a session that merely sat there', () => {
    const t = mounted(said(400));
    const opened = t.rows();

    t.scrollTo(BOTTOM);
    t.wait(DWELL);

    expect(t.rows()).toBe(opened);
  });
});


/**
 * Three of the CLI's settings describe a transcript rather than a terminal, and this app
 * draws all three. They are read from the CLI's own file, so turning one off here turns it
 * off in the terminal too (#202).
 */
describe("what the CLI's settings say to draw", () => {
  const drawn = (over: Partial<{ showReasoning: boolean; showTimestamps: boolean; showToolDurations: boolean }>) =>
    render(
      <Transcript
        events={[
          { ...event('user.message', { content: 'hello' }, 'e0'), timestamp: '2026-01-02T03:04:05.000Z' },
          event('assistant.reasoning', { reasoningId: 'r1', content: 'weighing two approaches' }, 'e1'),
          // Six seconds apart, so the call is over the floor the CLI puts on a duration and
          // the setting is what decides whether it is drawn.
          ...shell('e2', 'ls', 't1').map((e, at) => ({
            ...e,
            timestamp: at === 0 ? '2026-01-02T03:04:06.000Z' : '2026-01-02T03:04:12.000Z',
          })),
        ]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={{ ...ASSUMED_DISPLAY, ...over }}
      />,
    );

  it('folds the thinking away when the CLI says not to show it', () => {
    const { container } = drawn({ showReasoning: false });

    expect(container.querySelector('.reasoning')).toBeTruthy();
    expect(container.querySelector('.reasoning-body')).toBeNull();
  });

  it('shows it when the CLI says to', () => {
    const { container } = drawn({});

    expect(container.querySelector('.reasoning-body')).toBeTruthy();
  });

  it('leaves the clock off a message when the CLI says not to show it', () => {
    const { container } = drawn({ showTimestamps: false });

    expect(container.querySelector('.message-meta time')).toBeNull();
  });

  it('shows the clock when the CLI says to', () => {
    const { container } = drawn({});

    expect(container.querySelector('.message-meta time')).toBeTruthy();
  });

  it('leaves off how long a tool took when the CLI says not to show it', () => {
    const { container } = drawn({ showToolDurations: false });

    expect(container.querySelector('.elapsed')).toBeNull();
  });

  it('shows how long a tool took when the CLI says to', () => {
    const { container } = drawn({});

    expect(container.querySelector('.elapsed')?.textContent).toBe('6s');
  });

  /**
   * The CLI puts a floor of five seconds under a tool call's duration, and this app matches
   * it: a transcript where most rows carry a number is one where the number stops meaning
   * the call was slow (#264).
   */
  it('says nothing about a call the CLI would leave silent', () => {
    const { container } = render(
      <Transcript
        events={shell('e2', 'ls', 't1').map((e, at) => ({
          ...e,
          timestamp: at === 0 ? '2026-01-02T03:04:06.000Z' : '2026-01-02T03:04:09.000Z',
        }))}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );

    expect(container.querySelector('.elapsed')).toBeNull();
  });

  /** Each answers its own question: turning one off must not take the others with it. */
  it('keeps the others when one is turned off', () => {
    const { container } = drawn({ showReasoning: false });

    expect(container.querySelector('.message-meta time')).toBeTruthy();
  });
});

/**
 * A jump to a search result leaves the transcript showing the middle of a conversation, which
 * is the one time its last row is not its end - and the one thing a reader cannot tell by
 * looking (#30).
 */
describe('coming back from a search result', () => {
  const at = (props: Partial<ComponentProps<typeof Transcript>> = {}) =>
    render(
      <Transcript
        events={[]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        {...props}
      />,
    );

  it('says nothing about the end when it is showing the end', () => {
    at();
    expect(screen.queryByRole('button', { name: /end of the session/i })).toBeNull();
  });

  it('offers the way back when it is not', () => {
    at({ onLatest: () => {} });
    expect(screen.getByRole('button', { name: /end of the session/i })).toBeTruthy();
  });

  it('takes it when it is pressed', async () => {
    const onLatest = vi.fn();
    at({ onLatest });

    await userEvent.click(screen.getByRole('button', { name: /end of the session/i }));

    expect(onLatest).toHaveBeenCalledOnce();
  });
});

/**
 * A page of conversation is a lot to arrive in front of when the reason for arriving is a
 * few words somewhere in it, so the row holding them is pointed at and then let go (#30).
 */
describe('pointing at what a search was looking for', () => {
  const said = (content: string, id: string) =>
    ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

  const at = (props: Partial<ComponentProps<typeof Transcript>> = {}) =>
    render(
      <Transcript
        events={[said('nothing of interest', 'a'), said('the eviction rule was wrong', 'b'), said('later still', 'c')]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        {...props}
      />,
    );

  it('marks nothing when nothing was being looked for', () => {
    at();
    expect(document.querySelector('.entry.found')).toBeNull();
  });

  it('marks the row holding the words', async () => {
    at({ highlight: { words: 'eviction', at: 1 } });

    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
    expect(document.querySelector('.entry.found')?.textContent).toContain('eviction rule');
  });

  it('finds them whatever their case', async () => {
    at({ highlight: { words: 'EVICTION', at: 1 } });
    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
  });

  // The page ends at the match, so an earlier mention is an older one of the same thing.
  it('marks the last row holding them rather than the first', async () => {
    at({
      events: [said('eviction, first mention', 'a'), said('eviction, the one meant', 'b')],
      highlight: { words: 'eviction', at: 1 },
    });

    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
    expect(document.querySelector('.entry.found')?.textContent).toContain('the one meant');
  });

  it('marks nothing when the words are not on the page', async () => {
    at({ highlight: { words: 'nowhere in this page', at: 1 } });

    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('.entry.found')).toBeNull();
  });

  /**
   * It stays until the reader moves the transcript themselves. A mark that faded on a timer
   * was one they had to catch within two seconds, on a page that was often still arriving
   * when those two seconds were up - and it was missed every time it was looked for.
   */
  it('stays until the reader takes over', async () => {
    at({ highlight: { words: 'eviction', at: 1 } });
    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.querySelector('.entry.found'), 'still there a moment later').toBeTruthy();

    fireEvent.wheel(document.querySelector('.transcript') as HTMLElement);

    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeNull());
  });
});

/**
 * The page is still filling in when a jump lands: the budgeted renderer adds rows in
 * batches, and each batch used to throw the view to the bottom a frame after it had arrived
 * in the right place. Following the end and being sent somewhere are different requests.
 */
describe('holding a jump against the rest of the page arriving', () => {
  const said = (content: string, id: string) =>
    ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

  const page = (count: number, at: number) =>
    Array.from({ length: count }, (_, index) =>
      said(index === at ? 'the eviction rule was wrong' : `filler ${index}`, `e${index}`),
    );

  it('does not follow the end while pointing at something', async () => {
    const { rerender } = render(
      <Transcript
        events={page(12, 4)}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        highlight={{ words: 'eviction', at: 1 }}
      />,
    );
    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());

    const list = document.querySelector('.transcript') as HTMLElement;
    // jsdom lays nothing out, so a list is zero high and going to the bottom cannot be told
    // apart from staying put. Giving it a height makes the difference measurable.
    Object.defineProperty(list, 'scrollHeight', { value: 5000, configurable: true });
    list.scrollTop = 0;

    // Rows arriving after the jump, which is what the budgeted renderer does.
    rerender(
      <Transcript
        events={[...page(12, 4), said('much later', 'z')]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        highlight={{ words: 'eviction', at: 1 }}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));

    expect(list.scrollTop, 'the page should not have been thrown to the bottom').toBe(0);
  });

  // Without a search sending it there, a session still opens at its end.
  it('follows the end when nothing is being pointed at', async () => {
    render(
      <Transcript
        events={page(12, 4)}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('.entry.found')).toBeNull();
  });
});

/**
 * What a match is looked for in, which is what the index holds: each turn''s question and
 * its reply. Tool output is not in the index, so pointing at it here would point at
 * something the search could not have found.
 */
describe('what counts as having said it', () => {
  const ran = (output: string, id: string) =>
    ({
      type: 'tool.execution_complete',
      data: { toolCallId: id, success: true, result: { content: output } },
      id,
    }) as unknown as TranscriptEvent;

  const started = (id: string) =>
    ({
      type: 'tool.execution_start',
      data: { toolCallId: id, toolName: 'shell', description: 'List branches' },
      id: `${id}-start`,
    }) as unknown as TranscriptEvent;

  const said = (content: string, id: string) =>
    ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

  const asked = (content: string, id: string) =>
    ({ type: 'user.message', data: { content }, id }) as unknown as TranscriptEvent;

  const at = (props: Partial<ComponentProps<typeof Transcript>> = {}) =>
    render(
      <Transcript
        events={[]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        {...props}
      />,
    );

  it('points at a reply that said it', async () => {
    at({ events: [said('nothing here', 'a'), said('the eviction rule', 'b')], highlight: { words: 'eviction', at: 1 } });

    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
    expect(document.querySelector('.entry.found')?.textContent).toContain('eviction rule');
  });

  it('points at a question that asked it', async () => {
    at({ events: [said('nothing here', 'a'), asked('what about eviction?', 'b')], highlight: { words: 'eviction', at: 1 } });

    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
    expect(document.querySelector('.entry.found')?.textContent).toContain('what about eviction');
  });

  // The index is built from questions and replies, so a match can never be in tool output.
  it('does not point at tool output, which the search cannot see either', async () => {
    at({
      events: [said('nothing here', 'a'), started('t1'), ran('  feature/npc-assist-traits', 't1')],
      highlight: { words: 'assist', at: 1 },
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(document.querySelector('.entry.found')).toBeNull();
  });

  it('marks nothing at all when the page is empty', async () => {
    at({ events: [], highlight: { words: 'eviction', at: 1 } });

    await new Promise((r) => setTimeout(r, 40));
    expect(document.querySelector('.entry.found')).toBeNull();
  });
});

/**
 * The page a search result opens is 150 events, but only about 16 KB from its end is drawn
 * before anybody asks for more. Measured on real sessions, five matches in ten sat above
 * that window - one of them 39 KB behind it - so the row was not in the document at all and
 * the page settled at its end with nothing marked (#30).
 */
describe('reaching a match that the drawn window stopped short of', () => {
  const said = (content: string, id: string) =>
    ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

  /** The match first, then enough text after it to push it out of the budget. */
  const buried = [
    said('the eviction rule was wrong', 'match'),
    ...Array.from({ length: 12 }, (_, index) => said('x'.repeat(4 * 1024), `bulk${index}`)),
  ];

  it('draws far enough back to reach it, and marks it', async () => {
    render(
      <Transcript
        events={buried}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        highlight={{ words: 'eviction', at: 1 }}
      />,
    );

    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
    expect(document.querySelector('.entry.found')?.textContent).toContain('eviction rule');
  });

  // Without a search asking for it, the budget still decides what a page opens with.
  it('leaves the window alone when nothing was searched for', async () => {
    render(
      <Transcript
        events={buried}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );

    await new Promise((r) => setTimeout(r, 40));
    expect(document.body.textContent).not.toContain('eviction rule');
  });

  /**
   * The rows on the page are the end of the entry list, not all of it, so where a match sits
   * among the entries is not where it sits among the rows. Without that difference accounted
   * for, a match inside the window still points at the wrong row - or at no row at all.
   */
  it('points at the right row when the page is only part of the list', async () => {
    render(
      <Transcript
        events={[
          ...Array.from({ length: 12 }, (_, index) => said('y'.repeat(4 * 1024), `above${index}`)),
          said('the eviction rule was wrong', 'match'),
          said('a short word after', 'tail'),
        ]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        highlight={{ words: 'eviction', at: 1 }}
      />,
    );

    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
    expect(document.querySelector('.entry.found')?.textContent).toContain('eviction rule');
  });
});

/**
 * Reaching back to a match draws rows above it, and every one of them pushes it further down
 * as its markdown lays out - so a page that arrived in the right place slid out of it a
 * moment later. That is the second half of what being sent somewhere weird looked like.
 */
describe('keeping hold of the row while the page settles around it', () => {
  const said = (content: string, id: string) =>
    ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

  const events = [said('the eviction rule was wrong', 'match'), said('and on we went', 'tail')];

  const show = (props: Partial<ComponentProps<typeof Transcript>> = {}) =>
    render(
      <Transcript
        events={events}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        highlight={{ words: 'eviction', at: 1 }}
        {...props}
      />,
    );

  /** How many times the marked row has been asked to put itself back in view. */
  const centrings = () => {
    const row = document.querySelector('.entry.found');
    return row ? Number((row as HTMLElement).dataset.centred ?? 0) : 0;
  };

  beforeEach(() => {
    // Counted per element, since the marked row is the only one this asks about.
    Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      this.dataset.centred = String(Number(this.dataset.centred ?? 0) + 1);
    };
  });

  it('puts itself back in view when the page moves underneath it', async () => {
    const { rerender } = show();
    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
    const before = centrings();

    // Something arriving above the match, which is what widening the window does.
    rerender(
      <Transcript
        events={[said('an older exchange', 'above'), ...events]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        highlight={{ words: 'eviction', at: 1 }}
      />,
    );

    await vi.waitFor(() => expect(centrings()).toBeGreaterThan(before));
  });

  // The reader taking over ends it at once, and a wheel is not something scrolling raises.
  it('lets go the moment the reader takes over', async () => {
    const { rerender } = show();
    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());

    fireEvent.wheel(document.querySelector('.transcript') as HTMLElement);
    const after = centrings();

    // The same page movement that would otherwise pull the row back into view.
    rerender(
      <Transcript
        events={[said('an older exchange', 'above'), ...events]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        highlight={{ words: 'eviction', at: 1 }}
      />,
    );
    await new Promise((r) => setTimeout(r, 60));

    expect(centrings()).toBe(after);
  });
});

/**
 * Reaching back has two shapes: a page fetched from disk, which changes how many entries
 * there are, and the drawn window widening, which changes only how many are shown. Both add
 * height above the reader, and only the first was being corrected for - so scrolling up
 * moved the text under whoever was reading it.
 */
describe('holding the reader still when the window widens', () => {
  const said = (content: string, id: string) =>
    ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

  it('gives back the height that showing more entries added', async () => {
    render(
      <Transcript
        events={Array.from({ length: 16 }, (_, index) => said('x'.repeat(2 * 1024), `e${index}`))}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );
    await new Promise((r) => setTimeout(r, 40));

    const list = document.querySelector('.transcript') as HTMLElement;
    const rows = () => document.querySelectorAll('.transcript > li.entry').length;
    const before = rows();

    // jsdom lays nothing out, so height is stated as what it really tracks: the rows drawn.
    const ROW = 250;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => rows() * ROW });
    list.scrollTop = 0;

    // At the top, under their own hand, which is what asks for more of what is already held.
    fireEvent.wheel(list);
    fireEvent.scroll(list);
    await new Promise((r) => setTimeout(r, 40));

    expect(rows(), 'more should have been drawn').toBeGreaterThan(before);
    expect(list.scrollTop, 'and the reader given back the height it added').toBe((rows() - before) * ROW);
  });
});

/**
 * Coming back to a session is a new arrival. The guard that keeps a mark from reapplying as
 * the page settles outlived the visit it belonged to, so a second look at the same result
 * was refused as already answered - it opened, pointed at nothing, and sat at the end.
 */
describe('coming back to a result a second time', () => {
  const said = (content: string, id: string) =>
    ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

  /** Distinct ids per session, so a row is never reused and a mark cannot be left on it. */
  const page = (of: string, body: string) => [said(body, `${of}-a`), said('and on we went', `${of}-b`)];

  const draw = (id: string, events: TranscriptEvent[]) => (
    <Transcript
      events={events}
      sessionId={id}
      cwd={null}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
      display={ASSUMED_DISPLAY}
      highlight={{ words: 'eviction', at: 1 }}
      onLatest={() => {}}
    />
  );

  it('points at it again after going somewhere else and back', async () => {
    const { rerender } = render(draw('one', page('one', 'the eviction rule was wrong')));
    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());

    // Somewhere else, then back. The page is read again, so it is a new arrival.
    rerender(draw('two', page('two', 'a different conversation about eviction')));
    await vi.waitFor(() =>
      expect(document.querySelector('.entry.found')?.textContent).toContain('different conversation'),
    );

    rerender(draw('one', page('back', 'the eviction rule was wrong')));

    await vi.waitFor(() => {
      const found = document.querySelector('.entry.found');
      expect(found?.textContent).toContain('eviction rule was wrong');
    });
  });
});

/**
 * Landing on a search result lands at the top of the page, and being at the top is what asks
 * for the page before it. Arriving therefore fetched older history nobody wanted, prepended
 * it above the match, and left the reader on a different day with nothing marked.
 */
describe('not mistaking where it put the reader for where they went', () => {
  const said = (content: string, id: string) =>
    ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

  const show = (props: Partial<ComponentProps<typeof Transcript>> = {}) =>
    render(
      <Transcript
        events={[said('the eviction rule was wrong', 'a'), said('and on we went', 'b')]}
        sessionId="s1"
        cwd={null}
        hasOlder={true}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        {...props}
      />,
    );

  const atTop = (list: HTMLElement) => {
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 4000 });
    list.scrollTop = 0;
    fireEvent.scroll(list);
  };

  /** Scrolls this component caused are ignored for a moment, so let that pass first. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 200));

  it('does not reach further back just because a result landed at the top', async () => {
    const onLoadOlder = vi.fn();
    show({ highlight: { words: 'eviction', at: 1 }, onLoadOlder });
    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
    await settled();

    atTop(document.querySelector('.transcript') as HTMLElement);

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('reaches back once the reader scrolls there themselves', async () => {
    const onLoadOlder = vi.fn();
    show({ highlight: { words: 'eviction', at: 1 }, onLoadOlder });
    await vi.waitFor(() => expect(document.querySelector('.entry.found')).toBeTruthy());
    await settled();
    const list = document.querySelector('.transcript') as HTMLElement;

    fireEvent.wheel(list);
    atTop(list);

    expect(onLoadOlder).toHaveBeenCalled();
  });

  // Without a search sending them anywhere, the top means what it always meant.
  it('reaches back from the top as it always did when nothing was searched for', () => {
    const onLoadOlder = vi.fn();
    show({ onLoadOlder });

    const list = document.querySelector('.transcript') as HTMLElement;
    // Under their own hand, which is what makes it them arriving rather than this component.
    fireEvent.wheel(list);
    atTop(list);

    expect(onLoadOlder).toHaveBeenCalled();
  });
});

/**
 * What a turn changed, gathered where the turn ends (#40). The edits are scattered through a
 * turn, often with a long reply between them, so no single row says what it came to.
 */
describe('summarising what a turn changed', () => {
  const asked = (content: string, id: string) =>
    ({ type: 'user.message', data: { content }, id }) as unknown as TranscriptEvent;

  const said = (content: string, id: string) =>
    ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

  const patch = (added: number) =>
    ['diff --git a/x b/x', '@@ -1,1 +1,1 @@', ...Array.from({ length: added }, (_, i) => `+line ${i}`)].join('\n');

  const edit = (path: string, id: string, added: number) => [
    {
      type: 'tool.execution_start',
      data: { toolCallId: id, toolName: 'str_replace_editor', arguments: { path } },
      id: `${id}-start`,
    } as unknown as TranscriptEvent,
    {
      type: 'tool.execution_complete',
      data: { toolCallId: id, success: true, result: { content: 'edited', detailedContent: patch(added) } },
      id,
    } as unknown as TranscriptEvent,
  ];

  const show = (events: TranscriptEvent[], props: Partial<ComponentProps<typeof Transcript>> = {}) =>
    render(
      <Transcript
        events={events}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
        {...props}
      />,
    );

  it('says what a turn came to, at the end of the turn', async () => {
    show([
      asked('change two things', 'q'),
      ...edit('one.ts', 't1', 3),
      ...edit('two.ts', 't2', 2),
      said('done', 'a'),
    ]);

    await vi.waitFor(() => expect(screen.getByText('2 files changed')).toBeTruthy());
  });

  it('says nothing at all when the reader has turned it off', async () => {
    show(
      [asked('change two things', 'q'), ...edit('one.ts', 't1', 3), ...edit('two.ts', 't2', 2), said('done', 'a')],
      { turnSummary: 'off' },
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(document.querySelector('.turn-summary')).toBeNull();
  });

  it('leaves a single edit to its own row when only several are wanted', async () => {
    show([asked('change one thing', 'q'), ...edit('one.ts', 't1', 3), said('done', 'a')], {
      turnSummary: 'multiple',
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(document.querySelector('.turn-summary')).toBeNull();
  });

  // Its own row names the file, but not that the turn is over and this is all of it.
  it('says what a single edit came to when any change is wanted', async () => {
    show([asked('change one thing', 'q'), ...edit('one.ts', 't1', 3), said('done', 'a')], {
      turnSummary: 'always',
    });

    await vi.waitFor(() => expect(screen.getByText('1 file changed')).toBeTruthy());
  });

  /**
   * Viewing a file answers with a diff of nothing but context, so a row that only looked at
   * a file must not be dressed as one that changed it.
   */
  it('does not draw a diff for a call that changed nothing', async () => {
    const empty = ['diff --git a/x b/x', '@@ -1,2 +1,2 @@', ' kept one', ' kept two'].join('\n');

    render(
      <Transcript
        events={[
          asked('look at it', 'q'),
          {
            type: 'tool.execution_start',
            data: { toolCallId: 'v', toolName: 'view', arguments: { path: 'one.ts' } },
            id: 'v-start',
          } as unknown as TranscriptEvent,
          {
            type: 'tool.execution_complete',
            data: { toolCallId: 'v', success: true, result: { content: 'one\ntwo', detailedContent: empty } },
            id: 'v',
          } as unknown as TranscriptEvent,
        ]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );

    await vi.waitFor(() => expect(screen.getByText(/one\.ts/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /one\.ts/ }));

    expect(document.querySelector('.tool-diff')).toBeNull();
    // The count the phantom patch was taking: a row that changed nothing says what it read.
    expect(screen.getByText('2 lines')).toBeTruthy();
  });

  /**
   * A summary is placed by where its turn ends among all the entries, while the rows drawn
   * are only the tail of them - so the two are read through the window's offset, not against
   * each other.
   */
  it('puts a summary on the right row when the window starts partway down', async () => {
    // Long enough that the byte budget stops short of the top, so the window begins below it.
    const bulk = Array.from({ length: 12 }, (_, i) => said('x'.repeat(4000), `bulk-${i}`));

    show([
      asked('something earlier', 'q0'),
      ...bulk,
      asked('change two things', 'q'),
      ...edit('one.ts', 't1', 3),
      ...edit('two.ts', 't2', 2),
      said('done', 'a'),
    ]);

    await vi.waitFor(() => expect(screen.getByText('2 files changed')).toBeTruthy());

    const list = document.querySelector('li.entry')?.parentElement;
    const rows = [...(list?.children ?? [])];
    const summary = document.querySelector('.turn-summary');
    const reply = [...document.querySelectorAll('li.entry')].find((row) => row.textContent?.includes('done'));

    expect(rows.indexOf(summary!)).toBe(rows.indexOf(reply!) + 1);
  });
});

/**
 * What a prompt carried, under the prompt that carried it (#111).
 *
 * The chips sat above the composer until Send and then vanished, so scrolling back said
 * nothing about what the agent had been looking at.
 */
describe('the files a prompt carried', () => {
  const carrying = (files: Record<string, unknown>[]) =>
    show([event('user.message', { content: 'have a look at this', attachments: files }, 'm1')]);

  it('names the file under the prompt', () => {
    carrying([{ type: 'file', path: 'C:\\shots\\screen.png', displayName: 'screen.png' }]);

    expect(screen.getByRole('button', { name: /screen\.png/ })).toBeTruthy();
  });

  /** The path is what tells two screenshots with the same name apart. */
  it('offers the path it came from', () => {
    carrying([{ type: 'file', path: 'C:\\shots\\screen.png', displayName: 'screen.png' }]);

    expect(screen.getByTitle('Show C:\\shots\\screen.png in its folder')).toBeTruthy();
  });

  it('names every file, not only the first', () => {
    carrying([
      { type: 'file', path: 'C:\\one\\a.png', displayName: 'a.png' },
      { type: 'file', path: 'C:\\two\\b.png', displayName: 'b.png' },
    ]);

    expect(screen.getByRole('button', { name: /a\.png/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /b\.png/ })).toBeTruthy();
  });

  /**
   * What a message carried is a record by the time it is in the conversation, so the cross
   * that removes one before sending has nothing to offer here.
   */
  it('offers no way to take one back', () => {
    carrying([{ type: 'file', path: 'C:\\shots\\screen.png', displayName: 'screen.png' }]);

    expect(screen.queryByRole('button', { name: 'Remove screen.png' })).toBeNull();
  });

  it('draws nothing for a prompt that carried nothing', () => {
    show([event('user.message', { content: 'just words' }, 'm1')]);

    expect(document.querySelector('.attachment')).toBeNull();
  });
});

/**
 * A session changing model, in the transcript (#212).
 *
 * A reply written by one model sits directly above a reply written by another, and nothing
 * else in the transcript says so. The row has to be distinguishable from the other things
 * that happen to a session rather than in it: a compaction and a truncation both wear their
 * own marker, and a model change is neither.
 */
describe('a model change in the transcript', () => {
  const moved = (over: Record<string, unknown> = {}) =>
    show([
      event(
        'session.model_change',
        { previousModel: 'claude-opus-4.8', newModel: 'claude-sonnet-5', ...over },
        'e1',
      ),
    ]);

  it('says what the session moved to, on the row', () => {
    moved();

    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('claude-opus-4.8 \u2192 claude-sonnet-5')).toBeTruthy();
  });

  it('wears a marker of its own rather than a finished tool\u2019s tick', () => {
    const { container } = moved();

    const glyph = container.querySelector('.tool-status')?.textContent;
    expect(glyph).not.toBe('\u2713');
    // Nor a compaction's, nor a truncation's: three different things happened.
    expect(glyph).not.toBe('\u233E');
    expect(glyph).not.toBe('\u232B');
  });

  /** Nothing was lost, unlike the two rows it sits nearest in meaning. */
  it('is not marked as having lost anything', () => {
    const { container } = moved();

    expect(container.querySelector('.tool.lossy')).toBeNull();
  });

  it('does not open, because the whole of it is on the row', () => {
    const { container } = moved();

    expect((container.querySelector('.tool-head') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says how hard it was told to think, where that moved too', () => {
    moved({ previousReasoningEffort: 'high', reasoningEffort: 'max' });

    expect(screen.getByText('high \u2192 max')).toBeTruthy();
  });

  it('says nothing about effort that stayed where it was', () => {
    const { container } = moved({ previousReasoningEffort: 'max', reasoningEffort: 'max' });

    expect(container.textContent).not.toContain('max \u2192 max');
  });

  it('draws nothing at all for a session merely saying what it runs on', () => {
    const { container } = show([event('session.model_change', { newModel: 'claude-opus-5' }, 'e1')]);

    expect(container.querySelector('.tool')).toBeNull();
  });
});

/**
 * A turn summary a reader opened has to stay open as the turn goes on (#140 follow-up).
 *
 * The summary is drawn under the last row of its turn, so every row the turn adds moves it
 * to a different place in the list and React builds it again. Kept inside the summary, the
 * fact that it was open went with it, and it closed itself whenever the agent did anything.
 */
describe('a turn summary while the turn is still going', () => {
  const patch = (line: string) =>
    ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,0 +1,1 @@', `+${line}`].join('\n');

  const edit = (id: string, callId: string, line: string): TranscriptEvent[] => [
    event('tool.execution_start', { toolCallId: callId, toolName: 'edit', arguments: { path: 'a.ts' } }, `${id}s`),
    event(
      'tool.execution_complete',
      { toolCallId: callId, success: true, result: { content: 'done', detailedContent: patch(line) } },
      `${id}c`,
    ),
  ];

  const working = [event('user.message', { content: 'do it' }, 'u1'), ...edit('e1', 't1', 'the first')];

  const summary = () => screen.getByRole('button', { name: /files? changed/ });

  it('draws a summary for the turn in progress', () => {
    show(working);

    expect(summary()).toBeTruthy();
  });

  it('stays open when the turn adds a row', async () => {
    const { rerender } = show(working);
    await userEvent.click(summary());
    expect(document.querySelector('.turn-changes.open')).toBeTruthy();

    rerender(
      <Transcript
        events={[...working, event('assistant.message', { content: 'still going' }, 'm1')]}
        sessionId="s1"
        cwd={null}
        hasOlder={true}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );

    expect(document.querySelector('.turn-changes.open')).toBeTruthy();
  });

  it('stays open when the turn changes another file', async () => {
    const { rerender } = show(working);
    await userEvent.click(summary());

    rerender(
      <Transcript
        events={[...working, ...edit('e2', 't2', 'the second')]}
        sessionId="s1"
        cwd={null}
        hasOlder={true}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );

    expect(document.querySelector('.turn-changes.open')).toBeTruthy();
  });

  it('takes the new work into the summary rather than freezing it', async () => {
    const { rerender } = show(working);
    await userEvent.click(summary());

    rerender(
      <Transcript
        events={[...working, ...edit('e2', 't2', 'the second')]}
        sessionId="s1"
        cwd={null}
        hasOlder={true}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );

    // Scoped to the summary's own line: the file row under it counts the same lines again.
    expect(summary().querySelector('.added')?.textContent).toBe('+2');
  });

  it('is closed to begin with, as it always was', () => {
    show(working);

    expect(document.querySelector('.turn-changes.open')).toBeNull();
  });
});

/**
 * A panel opening under the transcript - what the session changed, its todos - takes its
 * height from the same grid, so the list gets shorter without anything in it changing. The
 * bottom of the conversation then sits below the fold, and the reader who was following the
 * work is left halfway up it.
 *
 * jsdom has no ResizeObserver, so one is supplied here that can be told to fire.
 */
describe('following the work when the box changes size', () => {
  const VIEWPORT = 300;
  const HEIGHT = 1000;
  let resize: (() => void) | null = null;
  const before = globalThis.ResizeObserver;

  beforeEach(() => {
    resize = null;
    globalThis.ResizeObserver = class {
      constructor(run: () => void) {
        resize = run;
      }
      observe() {}
      disconnect() {
        resize = null;
      }
      unobserve() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = before;
  });

  function transcript() {
    const view = render(
      <Transcript
        events={[{ type: 'assistant.message', data: { content: 'working on it' }, id: 'e1' }]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />,
    );
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;

    let viewport = VIEWPORT;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => HEIGHT });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => viewport });

    return {
      list,
      // What opening a panel does to the transcript: the same contents, a shorter window.
      shrink: (to: number) => {
        viewport = to;
        resize?.();
      },
    };
  }

  it('stays at the bottom when a panel takes half the height', () => {
    const t = transcript();
    t.list.scrollTop = HEIGHT - VIEWPORT;
    fireEvent.scroll(t.list);

    t.shrink(150);

    expect(t.list.scrollTop, 'the newest work should still be in view').toBe(HEIGHT);
  });

  it('leaves a reader where they were when they are not at the bottom', () => {
    const t = transcript();
    fireEvent.wheel(t.list);
    t.list.scrollTop = 100;
    fireEvent.scroll(t.list);

    t.shrink(150);

    expect(t.list.scrollTop, 'what they were reading should not be taken away').toBe(100);
  });

  it('draws and follows a reply where there is no observer at all', async () => {
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;

    const t = transcript();
    t.list.scrollTop = HEIGHT - VIEWPORT;
    fireEvent.scroll(t.list);
    t.list.append(document.createElement('li'));
    await new Promise((done) => setTimeout(done, 0));

    expect(t.list.scrollTop, 'the text observer should still be following').toBe(HEIGHT);
  });
});

/**
 * A panel open under the transcript can leave less than a screen of conversation, and then
 * the bottom of the list is also within a few pixels of its top. Reaching back from there
 * marked a restore that only the next render clears - and when what was asked for did not
 * grow the list, nothing ever cleared it, so the transcript stopped following the work.
 */
describe('following the work from a box too short to scroll in', () => {
  const HEIGHT = 1000;
  // Short enough that the bottom is also the top, which is what a panel does to the box.
  const VIEWPORT = 990;

  function transcript(over: { more?: boolean; onLoadOlder?: () => void } = {}) {
    const draw = (text: string) => (
      <Transcript
        events={[
          { type: 'assistant.message', data: { content: 'working on it' }, id: 'e1' },
          { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: text } },
        ]}
        sessionId="s1"
        cwd={null}
        hasOlder={over.more ?? true}
        loadingOlder={false}
        onLoadOlder={over.onLoadOlder ?? (() => {})}
        display={ASSUMED_DISPLAY}
      />
    );

    const view = render(draw('The'));
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;

    let height = HEIGHT;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => VIEWPORT });

    return {
      list,
      // The reader sitting at the bottom of a box that barely scrolls.
      atBottom: () => {
        list.scrollTop = HEIGHT - VIEWPORT;
        fireEvent.scroll(list);
      },
      grow: async (by: number, text: string) => {
        height += by;
        view.rerender(draw(text));
        await new Promise((done) => setTimeout(done, 0));
      },
      get height() { return height; },
    };
  }

  it('keeps following a reply that arrives after the reader sits at the bottom', async () => {
    const t = transcript();
    t.atBottom();

    await t.grow(300, 'a longer reply arriving');

    expect(t.list.scrollTop, 'the newest text should be in view').toBe(t.height);
  });

  /** Being at the bottom is not somebody asking for what came before it. */
  it('does not reach back for older messages from the bottom', () => {
    let asked = 0;
    const t = transcript({ onLoadOlder: () => { asked += 1; } });

    t.atBottom();

    expect(asked, 'the bottom should not have been read as the top').toBe(0);
  });

  it('still follows when there is nothing older to ask for', async () => {
    const t = transcript({ more: false });
    t.atBottom();

    await t.grow(300, 'a longer reply arriving');

    expect(t.list.scrollTop).toBe(t.height);
  });
});

/**
 * Reaching back marks a restore that the next render pays off. Asking something that cannot
 * answer - a transcript given no way to fetch an older page - wrote a debt nothing settled,
 * and the mark outlived the scroll that made it: the reader could come back to the bottom
 * and the transcript would no longer follow the work.
 */
describe('reaching back for a page that never comes', () => {
  const VIEWPORT = 300;

  it('still follows the work once the reader returns to the bottom', async () => {
    const draw = (text: string) => (
      <Transcript
        events={[
          { type: 'assistant.message', data: { content: 'working on it' }, id: 'e1' },
          { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: text } },
        ]}
        sessionId="s1"
        cwd={null}
        hasOlder
        loadingOlder={false}
        display={ASSUMED_DISPLAY}
      />
    );

    const view = render(draw('The'));
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;
    let height = 1000;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => VIEWPORT });

    const scrollTo = (top: number) => {
      list.scrollTop = top;
      fireEvent.scroll(list);
    };

    scrollTo(0);
    scrollTo(1000 - VIEWPORT);

    height += 300;
    view.rerender(draw('a longer reply arriving'));
    await new Promise((done) => setTimeout(done, 0));

    expect(list.scrollTop, 'the newest text should be in view').toBe(height);
  });
});

/**
 * A scroll event is delivered after the fact. By the time one arrives, more may have been
 * written and the bottom moved again - and the four pixels of slack the bottom has is less
 * than a single line. So the transcript scrolling itself to the bottom raised an event that,
 * once it arrived, read as the reader having scrolled away from the work.
 *
 * Unlike the other suites here, scrollTop clamps the way a browser clamps it. That is the
 * whole bug: without clamping, scrollTop keeps the height it was given and the distance back
 * from the bottom is never positive, so this could not happen.
 */
describe('following work that keeps arriving while the scroll catches up', () => {
  const VIEWPORT = 300;

  function transcript() {
    const draw = (text: string) => (
      <Transcript
        events={[
          { type: 'assistant.message', data: { content: 'working on it' }, id: 'e1' },
          { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: text } },
        ]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />
    );

    const view = render(draw('The'));
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;

    let height = 1000;
    let top = 0;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (to: number) => { top = Math.max(0, Math.min(to, height - VIEWPORT)); },
    });

    return {
      list,
      bottom: () => height - VIEWPORT,
      // An edit landing: the row is drawn and the expanded change under it grows.
      write: async (by: number, text: string) => {
        height += by;
        view.rerender(draw(text));
        await new Promise((done) => setTimeout(done, 0));
      },
      // More arriving before the browser gets round to reporting the scroll above.
      grew: (by: number) => { height += by; },
      reports: () => fireEvent.scroll(list),
    };
  }

  it('keeps following when the scroll is reported after more has arrived', async () => {
    const t = transcript();
    t.list.scrollTop = t.bottom();
    t.reports();

    await t.write(300, 'an edit lands');
    // The expanded change grows by a line before the scroll above is reported.
    t.grew(50);
    t.reports();

    await t.write(100, 'another edit lands');

    expect(t.list.scrollTop, 'the newest work should still be in view').toBe(t.bottom());
  });

  /** The reader moving is still the reader moving, whatever this component did before it. */
  it('lets go when the reader scrolls away', async () => {
    const t = transcript();
    t.list.scrollTop = t.bottom();
    t.reports();

    await t.write(300, 'an edit lands');
    fireEvent.wheel(t.list);
    t.list.scrollTop = 0;
    t.reports();

    await t.write(100, 'another edit lands');

    expect(t.list.scrollTop, 'they should be left where they were reading').toBe(0);
  });
});

/**
 * One programmatic scroll does not always report once - the compositor can raise several
 * events as it settles - and each of them arrives after whatever was written in the meantime.
 * A claim on only the first left the rest to be read as the reader leaving, which is how
 * following a turn died while a changes panel grew beneath it.
 */
describe('following work through a scroll that reports more than once', () => {
  const VIEWPORT = 300;

  function transcript() {
    const draw = (text: string) => (
      <Transcript
        events={[
          { type: 'assistant.message', data: { content: 'working on it' }, id: 'e1' },
          { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: text } },
        ]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />
    );

    const view = render(draw('The'));
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;

    let height = 1000;
    let viewport = VIEWPORT;
    let top = 0;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => viewport });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (to: number) => { top = Math.max(0, Math.min(to, height - viewport)); },
    });

    return {
      list,
      bottom: () => height - viewport,
      write: async (by: number, text: string) => {
        height += by;
        view.rerender(draw(text));
        await new Promise((done) => setTimeout(done, 0));
      },
      // A panel growing under the transcript takes the height out of its box.
      panelTakes: (px: number) => { viewport -= px; },
      // More written between the scroll and the browser getting round to reporting it.
      grew: (by: number) => { height += by; },
      reports: () => fireEvent.scroll(list),
    };
  }

  it('keeps following when one scroll is reported twice', async () => {
    const t = transcript();
    t.list.scrollTop = t.bottom();
    t.reports();

    await t.write(300, 'an edit lands');
    // More arrives before the browser reports the scroll above, so the first report already
    // shows a gap - and then the same scroll is reported a second time.
    t.grew(200);
    t.reports();
    t.reports();

    await t.write(100, 'another edit lands');

    expect(t.list.scrollTop, 'the newest work should still be in view').toBe(t.bottom());
  });

  it('keeps following when a panel takes height as the work arrives', async () => {
    const t = transcript();
    t.list.scrollTop = t.bottom();
    t.reports();

    await t.write(300, 'an edit lands');
    // The changes panel grows by the same edit, so the transcript gets a shorter box.
    t.panelTakes(120);
    t.reports();

    await t.write(100, 'another edit lands');

    expect(t.list.scrollTop, 'a shorter box should not hide the work').toBe(t.bottom());
  });
});

/**
 * The browser moves the scroll as well as the reader. It clamps the position whenever the
 * list is trimmed from the top or the box grows, landing somewhere this component never wrote
 * - and if a turn writes anything before that lands, the gap it leaves behind was read as the
 * reader walking away. From then on nothing followed the work, and rows arrived under the
 * changes panel instead of pushing the view up.
 *
 * Only a wheel, a drag or a key is something a reader produces, so that is what gives the
 * bottom up. scrollTop clamps the way a browser clamps it, which is the whole subject.
 */
describe('following work through a scroll the browser moved', () => {
  const VIEWPORT = 300;

  function transcript() {
    const draw = (text: string) => (
      <Transcript
        events={[
          { type: 'assistant.message', data: { content: 'working on it' }, id: 'e1' },
          { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: text } },
        ]}
        sessionId="s1"
        cwd={null}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        display={ASSUMED_DISPLAY}
      />
    );

    const view = render(draw('The'));
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;

    let height = 2000;
    let top = 0;
    const clamp = () => { top = Math.max(0, Math.min(top, height - VIEWPORT)); };
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (to: number) => { top = Math.max(0, Math.min(to, height - VIEWPORT)); },
    });

    return {
      list,
      bottom: () => height - VIEWPORT,
      write: async (by: number, text: string) => {
        height += by;
        view.rerender(draw(text));
        await new Promise((done) => setTimeout(done, 0));
      },
      // Rows dropped from the top. The list gets shorter and the browser pulls the scroll
      // back to what is left, which is a position this component never asked for.
      trimmed: (by: number) => { height -= by; clamp(); },
      grew: (by: number) => { height += by; },
      reports: () => fireEvent.scroll(list),
    };
  }

  it('keeps following when a trim pulls the scroll back and more then arrives', async () => {
    const t = transcript();
    t.list.scrollTop = t.bottom();
    t.reports();

    await t.write(400, 'an edit lands');
    // The window is trimmed from the top, then the turn writes again before the browser
    // reports where it moved the scroll to.
    t.trimmed(600);
    t.grew(200);
    t.reports();

    await t.write(100, 'another edit lands');

    expect(t.list.scrollTop, 'the newest work should still be in view').toBe(t.bottom());
  });

  it('still lets go when the reader takes the wheel to it', async () => {
    const t = transcript();
    t.list.scrollTop = t.bottom();
    t.reports();

    await t.write(400, 'an edit lands');
    fireEvent.wheel(t.list);
    t.list.scrollTop = 200;
    t.reports();

    await t.write(100, 'another edit lands');

    expect(t.list.scrollTop, 'they should be left where they were reading').toBe(200);
  });

  /**
   * Opening a row is a pointer gesture too, and what it opens is drawn a moment later. Without
   * knowing its own scroll from the reader's, the growth that follows the click reads as the
   * click having been somebody leaving - which stopped a turn being followed the moment a file
   * change was expanded under it.
   */
  it('keeps following after a click inside it opens something', async () => {
    const t = transcript();
    t.list.scrollTop = t.bottom();
    t.reports();

    fireEvent.pointerDown(t.list);
    await t.write(400, 'an edit lands');
    // What the click opened, finishing being drawn.
    t.grew(200);
    t.reports();

    await t.write(100, 'another edit lands');

    expect(t.list.scrollTop, 'opening a row is not leaving').toBe(t.bottom());
  });

  it('lets go when a key that scrolls is pressed in it', async () => {
    const t = transcript();
    t.list.scrollTop = t.bottom();
    t.reports();

    await t.write(400, 'an edit lands');
    fireEvent.keyDown(t.list, { key: 'ArrowUp' });
    t.list.scrollTop = 200;
    t.reports();

    await t.write(100, 'another edit lands');

    expect(t.list.scrollTop, 'an arrow is the reader scrolling').toBe(200);
  });

  /**
   * The list is focusable, so the keys that move focus somewhere else arrive here on the way
   * out. Treating those as taking over would give up the bottom on a transcript nobody had
   * scrolled - the reader presses Escape to get back to the composer and the turn they were
   * watching stops following them.
   *
   * The scroll has to be moved away from the bottom for this to say anything: sitting at the
   * bottom is pinned whatever happened, so a version of this that never scrolls passes no
   * matter which keys are treated as a gesture.
   */
  it.each(['Tab', 'Escape', 'F6', 'a'])('keeps following when %s is pressed in it', async (key) => {
    const t = transcript();
    t.list.scrollTop = t.bottom();
    t.reports();

    await t.write(400, 'an edit lands');
    fireEvent.keyDown(t.list, { key });
    // Something moved the scroll, and it was not the reader: the key they pressed does not
    // scroll anything.
    t.list.scrollTop = 200;
    t.reports();

    await t.write(100, 'another edit lands');

    expect(t.list.scrollTop, `${key} is not a reader scrolling`).toBe(t.bottom());
  });

  it('can be focused, so a region key has something to aim at', () => {
    const t = transcript();

    t.list.focus();

    expect(document.activeElement, 'the transcript should take focus').toBe(t.list);
  });
});

/**
 * A page too short to scroll raises no scroll event, so scrolling cannot be the only way to
 * reach what is above it. The effect that fills such a page is capped on purpose - a session
 * that is mostly delegated work would otherwise load all of itself - and past that cap the
 * reader was told to scroll up a list that could not move (#247).
 */
describe('asking for earlier messages rather than scrolling to them', () => {
  const draw = (over: Partial<ComponentProps<typeof Transcript>> = {}) => (
    <Transcript
      events={[{ type: 'assistant.message', data: { content: 'the only thing on this page' }, id: 'e1' }]}
      sessionId="s1"
      cwd={null}
      hasOlder
      loadingOlder={false}
      display={ASSUMED_DISPLAY}
      {...over}
    />
  );

  const back = () => screen.queryByRole('button', { name: 'Show earlier messages' });

  it('offers the way back as something that can be pressed', () => {
    render(draw());

    expect(back(), 'a list that cannot scroll still has to have a way up').toBeTruthy();
  });

  it('reads the page above when pressed', () => {
    const onLoadOlder = vi.fn();
    render(draw({ onLoadOlder }));

    fireEvent.click(back()!);

    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it('says so while that page is on its way, offering nothing to press twice', () => {
    render(draw({ loadingOlder: true }));

    expect(back()).toBeNull();
    expect(screen.getByText('Loading earlier messages…')).toBeTruthy();
  });

  it('says where the start is once there is nothing above', () => {
    render(draw({ hasOlder: false }));

    expect(back()).toBeNull();
    expect(screen.getByText('Start of session')).toBeTruthy();
  });
});

/**
 * Opening or closing every fold at once (#135).
 *
 * The CLI answers ctrl+o with this, and a long session is a column of one-line rows that
 * each have to be opened by hand. The rows keep their own state, so the request is carried
 * as a value and a count: each row answers a request it has not answered yet and then goes
 * back to being its own row.
 */
describe('folding the whole transcript', () => {
  const fold = (folds: ComponentProps<typeof Transcript>['folds']) => (
    <Transcript
      events={[...shell('e1', 'ls', 't1'), ...shell('e2', 'pwd', 't2')]}
      sessionId="s1"
      cwd={null}
      folds={folds}
      display={ASSUMED_DISPLAY}
    />
  );

  const output = () => [screen.queryByText('output of ls'), screen.queryByText('output of pwd')].filter(Boolean);

  it('opens every row when asked', () => {
    const { rerender } = render(fold(null));
    expect(output(), 'closed to begin with').toHaveLength(0);

    rerender(fold({ open: true, at: 1 }));

    expect(output()).toHaveLength(2);
  });

  it('closes them again', () => {
    const { rerender } = render(fold(null));
    rerender(fold({ open: true, at: 1 }));

    rerender(fold({ open: false, at: 2 }));

    expect(output()).toHaveLength(0);
  });

  /**
   * One press does not freeze every fold until the next one. A reader who opened everything
   * and then closed one row has closed that row, not asked a question of the whole list.
   */
  it('leaves a row free to be worked on its own afterwards', async () => {
    const { rerender } = render(fold(null));
    rerender(fold({ open: true, at: 1 }));

    await userEvent.click(screen.getByRole('button', { name: /ls/ }));

    expect(screen.queryByText('output of ls')).toBeNull();
    expect(screen.queryByText('output of pwd'), 'and the other is untouched').toBeTruthy();
  });

  /** The same request arriving again is the same request, not a second press. */
  it('does nothing when the request has not changed', async () => {
    const { rerender } = render(fold(null));
    rerender(fold({ open: true, at: 1 }));
    await userEvent.click(screen.getByRole('button', { name: /ls/ }));

    rerender(fold({ open: true, at: 1 }));

    expect(screen.queryByText('output of ls'), 'still closed by hand').toBeNull();
  });

  /**
   * A row that arrives after the request counts as having answered it, so a tool call
   * landing while everything is expanded still opens closed, as every new row does.
   */
  it('leaves a row that arrived later on its own default', () => {
    const { rerender } = render(
      <Transcript events={shell('e1', 'ls', 't1')} sessionId="s1" cwd={null} folds={{ open: true, at: 1 }} display={ASSUMED_DISPLAY} />,
    );

    rerender(
      <Transcript
        events={[...shell('e1', 'ls', 't1'), ...shell('e2', 'pwd', 't2')]}
        sessionId="s1"
        cwd={null}
        folds={{ open: true, at: 1 }}
        display={ASSUMED_DISPLAY}
      />,
    );

    expect(screen.queryByText('output of pwd')).toBeNull();
  });
});

/**
 * Finding words inside one conversation (#209).
 *
 * Distinct from searching the sessions, which finds which session said something. This is
 * for when the reader is already in the right place and the word appears forty times.
 */
describe('finding words in the session', () => {
  const said = (body: string, id: string) => event('assistant.message', { content: body }, id);

  const draw = (over: Partial<ComponentProps<typeof Transcript>> = {}) => (
    <Transcript
      events={[said('the quick brown fox', 'e1'), said('nothing here', 'e2'), said('another fox entirely', 'e3')]}
      sessionId="s1"
      cwd={null}
      display={ASSUMED_DISPLAY}
      {...over}
    />
  );

  const field = () => screen.getByLabelText('Find in this session') as HTMLInputElement;
  /** The whole sentence the bar is saying: the number is a field, so it has no text of its own. */
  const count = () => findCount();
  const marked = () => document.querySelector('li.entry.found')?.textContent;

  it('is not there until it is asked for', () => {
    render(draw());

    expect(screen.queryByLabelText('Find in this session')).toBeNull();
  });

  it('opens when it is', () => {
    render(draw({ finding: 1 }));

    expect(field()).toBeTruthy();
  });

  it('counts the rows holding the words', async () => {
    render(draw({ finding: 1 }));

    await userEvent.type(field(), 'fox');

    expect(count()).toBe('1 of 2');
  });

  it('walks to the next one', async () => {
    render(draw({ finding: 1 }));
    await userEvent.type(field(), 'fox');

    await userEvent.keyboard('{Enter}');

    expect(count()).toBe('2 of 2');
  });

  /** A key that stops working at the last match reads as broken rather than as finished. */
  it('wraps round the end', async () => {
    render(draw({ finding: 1 }));
    await userEvent.type(field(), 'fox');

    await userEvent.keyboard('{Enter}{Enter}');

    expect(count()).toBe('1 of 2');
  });

  it('marks the row it walked to', async () => {
    render(draw({ finding: 1 }));

    await userEvent.type(field(), 'fox');

    expect(marked()).toContain('the quick brown fox');
  });

  it('moves the mark as the walk goes on', async () => {
    render(draw({ finding: 1 }));
    await userEvent.type(field(), 'fox');

    await userEvent.keyboard('{Enter}');

    expect(marked()).toContain('another fox entirely');
  });

  it('says so when the words are nowhere', async () => {
    render(draw({ finding: 1 }));

    await userEvent.type(field(), 'elephant');

    expect(count()).toBe('Nothing here');
    expect(marked()).toBeUndefined();
  });

  /** The row they were on was found by a different question and may not be a hit now. */
  it('starts again when the words change', async () => {
    render(draw({ finding: 1 }));
    await userEvent.type(field(), 'fox');
    await userEvent.keyboard('{Enter}');

    await userEvent.type(field(), 'y');

    expect(count()).toBe('Nothing here');
  });

  it('asks to be closed', async () => {
    const onFindClosed = vi.fn();
    render(draw({ finding: 1, onFindClosed }));

    await userEvent.keyboard('{Escape}');

    expect(onFindClosed).toHaveBeenCalled();
  });

  /**
   * A folded row can be found in, because the reader can see the row and expects the word in
   * it to turn up - so landing on one has to open it.
   */
  it('opens a folded row it walks to', async () => {
    render(
      draw({
        events: [...shell('e1', 'ls', 't1'), said('nothing here', 'e2')],
        finding: 1,
      }),
    );
    expect(screen.queryByText('output of ls')).toBeNull();

    await userEvent.type(field(), 'output of ls');

    expect(screen.getByText('output of ls')).toBeTruthy();
  });
});

/**
 * Walking the hits has to move the view, which is most of what walking them is for.
 *
 * jsdom lays nothing out, so what is checked is that the row is asked to come into view and
 * that nothing puts the transcript back at the end afterwards.
 */
describe('following the find', () => {
  const said = (body: string, id: string) => event('assistant.message', { content: body }, id);
  const events = [said('the quick brown fox', 'e1'), said('nothing here', 'e2'), said('another fox', 'e3')];

  function finding() {
    const came: string[] = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function (this: Element) {
        came.push(this.textContent ?? '');
      });

    const view = render(
      <Transcript events={events} sessionId="s1" cwd={null} display={ASSUMED_DISPLAY} finding={1} />,
    );
    const list = view.container.querySelector('ol.transcript') as HTMLOListElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 5000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 400 });

    return { came, list, done: () => scrollIntoView.mockRestore() };
  }

  const field = () => screen.getByLabelText('Find in this session') as HTMLInputElement;

  it('brings the first hit into view as the words are typed', async () => {
    const { came, done } = finding();

    await userEvent.type(field(), 'fox');

    expect(came[came.length - 1]).toContain('the quick brown fox');
    done();
  });

  it('brings the next one into view as the walk goes on', async () => {
    const { came, done } = finding();
    await userEvent.type(field(), 'fox');

    await userEvent.keyboard('{Enter}');

    expect(came[came.length - 1]).toContain('another fox');
    done();
  });

  /**
   * The transcript follows the end of the conversation until somebody scrolls away, and the
   * mark moving counts as a mutation - so without letting go of the end, the view snapped
   * back to the bottom on every keystroke in the find box.
   */
  it('lets go of the end, so nothing pulls the view back', async () => {
    const { list, done } = finding();
    list.scrollTop = 4600;

    await userEvent.type(field(), 'fox');
    await new Promise((settle) => setTimeout(settle, 0));

    expect(list.scrollTop, 'put back at the end by the follower').not.toBe(5000);
    done();
  });
});

/**
 * Reaching back for the rest of the session (#209).
 *
 * Loading it is what makes the older half searchable on the same terms as the near half.
 * The index the session search uses holds only what was said, so counting from it would find
 * nothing in a tool call and say so in the same breath as a count that did.
 */
describe('finding past what is loaded', () => {
  const said = (body: string, id: string) => event('assistant.message', { content: body }, id);

  const draw = (over: Partial<ComponentProps<typeof Transcript>> = {}) => (
    <Transcript
      events={[said('the quick brown fox', 'e1')]}
      sessionId="s1"
      cwd={null}
      display={ASSUMED_DISPLAY}
      finding={1}
      {...over}
    />
  );

  const field = () => screen.getByLabelText('Find in this session') as HTMLInputElement;
  const toggle = () => screen.getByRole('checkbox', { name: /Entire session/ }) as HTMLInputElement;

  beforeEach(resetStores);

  it('asks for the pages it has not read', async () => {
    const onLoadOlder = vi.fn();
    render(draw({ hasOlder: true, onLoadOlder }));

    await userEvent.type(field(), 'fox');

    expect(onLoadOlder).toHaveBeenCalled();
  });

  it('asks for nothing until there is something to find', () => {
    const onLoadOlder = vi.fn();
    render(draw({ hasOlder: true, onLoadOlder }));

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('asks for nothing once the reach is turned off', async () => {
    const onLoadOlder = vi.fn();
    render(draw({ hasOlder: true, onLoadOlder }));
    await userEvent.click(toggle());

    await userEvent.type(field(), 'fox');

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('stops asking once there is nothing left to read', async () => {
    const onLoadOlder = vi.fn();
    render(draw({ hasOlder: false, onLoadOlder }));

    await userEvent.type(field(), 'fox');

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  /** Asking again while a page is on its way would ask for the same page twice. */
  it('waits for the page it asked for', async () => {
    const onLoadOlder = vi.fn();
    render(draw({ hasOlder: true, loadingOlder: true, onLoadOlder }));

    await userEvent.type(field(), 'fox');

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  /** A reader who does not want their finds reaching back does not want it next time either. */
  it('remembers being turned off', async () => {
    const { unmount } = render(draw());
    await userEvent.click(toggle());
    unmount();

    render(draw());

    expect(toggle().checked).toBe(false);
  });

  /**
   * The walk is held by row rather than by place in the list: reaching back puts older
   * entries in front of it, which moves every index along.
   */
  it('stays on the row it was on when a page arrives', async () => {
    const { rerender } = render(draw({ hasOlder: true, events: [said('a fox here', 'e1')] }));
    await userEvent.type(field(), 'fox');
    expect(findCount()).toBe('1 of 1 so far');

    rerender(draw({ hasOlder: false, events: [said('an older fox', 'e0'), said('a fox here', 'e1')] }));

    expect(findCount(), 'still on the same row, now second').toBe('2 of 2');
  });
});
