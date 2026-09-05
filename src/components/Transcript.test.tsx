// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    show([event('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'ls' } }, 'e1')]);
    expect(screen.getByRole('button', { name: /ls/ })).toHaveProperty('disabled', true);
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

  it('shows a question with the answer that was chosen', () => {
    show([
      event(
        'tool.execution_start',
        { toolCallId: 'q1', toolName: 'ask_user', arguments: { question: 'Pick one?', choices: ['A', 'B'] } },
        'e1',
      ),
      event('tool.execution_complete', { toolCallId: 'q1', success: true, result: { content: 'User responded: B' } }, 'e2'),
    ]);

    expect(screen.getByText('ask_user')).toBeTruthy();
    expect(screen.getByText('Pick one?')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });
});
