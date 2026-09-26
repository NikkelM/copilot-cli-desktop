// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Transcript } from './Transcript';
import { useTranscript } from '../lib/useTranscript';
import { ASSUMED_DISPLAY } from '../lib/useCliDisplay';
import type { TranscriptEvent } from '../../shared/protocol';

const getTranscript = vi.hoisted(() => vi.fn());
vi.mock('../lib/sidecar', () => ({ getTranscript: (...args: unknown[]) => getTranscript(...args) }));

const said = (content: string, id: string) =>
  ({ type: 'assistant.message', data: { content }, id }) as unknown as TranscriptEvent;

/** A page whose match is far enough back that the drawn window stops short of it. */
const pageOf = (of: string) => [
  said(`the eviction rule in ${of}`, `${of}-match`),
  ...Array.from({ length: 10 }, (_, index) => said('x'.repeat(4 * 1024), `${of}-bulk${index}`)),
];

/**
 * How the app wires a search result: the place to open is worked out first, then the session
 * and the jump are set together, and the transcript reads its page for that cursor.
 *
 * Mirrored here rather than tested through App, which would need two dozen other hooks -
 * but the ordering between these three is where every one of these bugs has lived.
 */
function Harness() {
  const [selected, setSelected] = useState<string | null>(null);
  const [jump, setJump] = useState<{ sessionId: string; cursor: number; words: string } | null>(null);
  const transcript = useTranscript(selected, () => {}, jump?.sessionId === selected ? jump.cursor : null);

  const open = async (sessionId: string) => {
    // Stands in for the sidecar working out where the match sits in the log.
    const cursor = await Promise.resolve(sessionId === 'one' ? 100 : 200);
    setJump({ sessionId, cursor, words: 'eviction' });
    setSelected(sessionId);
  };

  return (
    <>
      <button type="button" onClick={() => void open('one')}>
        open one
      </button>
      <button type="button" onClick={() => void open('two')}>
        open two
      </button>
      {/* What the runtime sends while a session is on screen, which App forwards the same way. */}
      <button
        type="button"
        onClick={() =>
          transcript.push({
            type: 'assistant.message',
            data: { content: 'something said just now' },
            id: `live-${selected}`,
          } as unknown as TranscriptEvent)
        }
      >
        something arrives
      </button>
      {selected && (
        <Transcript
          events={transcript.events}
          sessionId={selected}
          cwd={null}
          hasOlder={transcript.hasOlder}
          loadingOlder={transcript.loadingOlder}
          onLoadOlder={transcript.loadOlder}
          display={ASSUMED_DISPLAY}
          highlight={jump?.sessionId === selected ? jump.words : undefined}
          onLatest={() => setJump(null)}
        />
      )}
    </>
  );
}

beforeEach(() => {
  getTranscript.mockReset().mockImplementation((sessionId: string) =>
    Promise.resolve({ events: pageOf(sessionId), truncated: true, nextBefore: null, reopenable: true }),
  );
});

const marked = () => document.querySelector('.entry.found')?.textContent ?? null;

describe('opening one search result after another', () => {
  it('points at the match in the first session opened', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByText('open one'));

    await vi.waitFor(() => expect(marked()).toContain('eviction rule in one'));
  });

  it('points at the match in the next session too', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByText('open one'));
    await vi.waitFor(() => expect(marked()).toContain('eviction rule in one'));

    await userEvent.click(screen.getByText('open two'));

    await vi.waitFor(() => expect(marked()).toContain('eviction rule in two'));
  });

  // The one the reader reported: away and back is a new arrival, not a continuation.
  it('points at it again on coming back to the first', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByText('open one'));
    await vi.waitFor(() => expect(marked()).toContain('eviction rule in one'));
    await userEvent.click(screen.getByText('open two'));
    await vi.waitFor(() => expect(marked()).toContain('eviction rule in two'));

    await userEvent.click(screen.getByText('open one'));

    await vi.waitFor(() => expect(marked()).toContain('eviction rule in one'));
  });

  /**
   * A transcript holds two lists: the page read from the log, and whatever has arrived since
   * the session was opened. Both have to belong to their session - a session that was spoken
   * in leaves the second one behind, and the next session reads it as its own conversation.
   */
  it('points at the match after a session that had been spoken in', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByText('open one'));
    await vi.waitFor(() => expect(marked()).toContain('eviction rule in one'));
    // Something arrives while the reader is here, as it does in any session in use.
    await userEvent.click(screen.getByText('something arrives'));

    await userEvent.click(screen.getByText('open two'));

    await vi.waitFor(() => expect(marked()).toContain('eviction rule in two'));
  });
});
