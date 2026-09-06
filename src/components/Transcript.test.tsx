// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
