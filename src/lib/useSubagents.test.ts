// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';

const getAgentTranscript = vi.fn();
vi.mock('./sidecar', () => ({ getAgentTranscript: (...args: unknown[]) => getAgentTranscript(...args) }));

import { useSubagents } from './useSubagents';
import type { TranscriptEvent } from '../../shared/protocol';

const started = (agentId: string, name = 'explore') =>
  ({
    type: 'subagent.started',
    agentId,
    timestamp: '2026-01-02T00:00:00.000Z',
    data: { toolCallId: 'c1', agentName: name, agentDisplayName: name },
  }) as TranscriptEvent;

const finished = (agentId: string, type: 'subagent.completed' | 'subagent.failed' = 'subagent.completed') =>
  ({ type, agentId, data: { toolCallId: 'c1' } }) as TranscriptEvent;

const prompt = () => ({ type: 'user.message', data: { content: 'next please' } }) as TranscriptEvent;

/** An event a run produces that no transcript draws, so no log keeps it. */
const machinery = (agentId: string, type: string) => ({ type, agentId, data: {} }) as TranscriptEvent;
const working = (agentId: string, content: string) =>
  ({ type: 'assistant.message', agentId, data: { content } }) as TranscriptEvent;

beforeEach(() => {
  // Nothing settles unless a test says so, which keeps the ageing tests about ageing.
  getAgentTranscript.mockReset().mockRejectedValue(new Error('no log'));
});

describe('the subagents this app watched start', () => {
  it('holds nothing until one starts', () => {
    const { result } = renderHook(() => useSubagents());
    expect(result.current.watched).toEqual([]);
  });

  it('takes one from the announcement that names it', () => {
    const { result } = renderHook(() => useSubagents());

    act(() => result.current.observe('s1', started('a1', 'deep-audit')));

    expect(result.current.watched).toHaveLength(1);
    expect(result.current.watched[0]).toMatchObject({ agentId: 'a1', sessionId: 's1', name: 'deep-audit' });
  });

  it('says nothing about its outcome while it is still working', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));

    expect(result.current.watched[0]?.outcome).toBeUndefined();
  });

  it.each([
    ['subagent.completed', 'completed'],
    ['subagent.failed', 'failed'],
  ] as const)('records that it %s', (type, outcome) => {
    const { result } = renderHook(() => useSubagents());
    act(() => {
      result.current.observe('s1', started('a1'));
      result.current.observe('s1', finished('a1', type));
    });

    expect(result.current.watched[0]?.outcome).toBe(outcome);
  });

  it('keeps its work, so the timeline needs no trip to disk', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => {
      result.current.observe('s1', started('a1'));
      result.current.observe('s1', working('a1', 'looking around'));
    });

    expect(result.current.find('a1')?.events).toHaveLength(1);
  });

  /** The same objects the transcript holds, so a subagent costs an entry not a second copy. */
  it('keeps the events by reference rather than copying them', () => {
    const { result } = renderHook(() => useSubagents());
    const event = working('a1', 'looking around');
    act(() => {
      result.current.observe('s1', started('a1'));
      result.current.observe('s1', event);
    });

    expect(result.current.find('a1')?.events[0]).toBe(event);
  });

  it('keeps two sessions apart', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => {
      result.current.observe('s1', started('a1'));
      result.current.observe('s2', started('a2'));
    });

    expect(result.current.watched.map((e) => e.sessionId)).toEqual(['s1', 's2']);
  });

  describe('letting one go', () => {
    /**
     * A finished task stops being what the conversation is about. Three prompts later the
     * sidebar is worth more as a list of what is happening than as an archive of what did.
     */
    it('drops a finished one after three prompts', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s1', finished('a1'));
      });

      act(() => result.current.observe('s1', prompt()));
      act(() => result.current.observe('s1', prompt()));
      expect(result.current.watched).toHaveLength(1);

      act(() => result.current.observe('s1', prompt()));
      expect(result.current.watched).toHaveLength(0);
    });

    /**
     * The count was kept inside a state updater, which React invokes twice under StrictMode
     * and may replay from a discarded render. Every development session therefore dropped a
     * finished task after two prompts rather than three, and no test noticed because none of
     * them rendered the way `main.tsx` does.
     */
    it('still takes three prompts when React double-invokes its updaters', () => {
      const { result } = renderHook(() => useSubagents(), { wrapper: StrictMode });
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s1', finished('a1'));
      });

      act(() => result.current.observe('s1', prompt()));
      act(() => result.current.observe('s1', prompt()));
      expect(result.current.watched).toHaveLength(1);

      act(() => result.current.observe('s1', prompt()));
      expect(result.current.watched).toHaveLength(0);
    });

    // However long the reader spends typing at it, it is still the work in progress.
    it('never ages one that is still working', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => result.current.observe('s1', started('a1')));

      act(() => result.current.observe('s1', prompt()));
      act(() => result.current.observe('s1', prompt()));
      act(() => result.current.observe('s1', prompt()));
      act(() => result.current.observe('s1', prompt()));

      expect(result.current.watched).toHaveLength(1);
    });

    /** Counting the instruction a subagent was given would age the task it started. */
    it('does not count a prompt sent to a subagent', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s1', finished('a1'));
      });

      const instruction = { type: 'user.message', agentId: 'a1', data: { content: 'do this' } } as TranscriptEvent;
      act(() => {
        result.current.observe('s1', instruction);
        result.current.observe('s1', instruction);
        result.current.observe('s1', instruction);
      });

      expect(result.current.watched).toHaveLength(1);
    });

    it('ages only the session that was prompted', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s1', finished('a1'));
        result.current.observe('s2', started('a2'));
        result.current.observe('s2', finished('a2'));
      });

      act(() => result.current.observe('s1', prompt()));
      act(() => result.current.observe('s1', prompt()));
      act(() => result.current.observe('s1', prompt()));

      expect(result.current.watched.map((e) => e.agentId)).toEqual(['a2']);
    });

    /**
     * Their work exists only while it is held - nothing was read from disk to build it - so
     * an entry outliving its session would offer a transcript this app cannot produce.
     */
    it('lets a session go with the session itself', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s2', started('a2'));
      });

      act(() => result.current.forget('s1'));

      expect(result.current.watched.map((e) => e.agentId)).toEqual(['a2']);
    });

    it('takes one off when the reader asks', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s1', started('a2'));
      });

      act(() => result.current.dismiss('a1'));

      expect(result.current.watched.map((e) => e.agentId)).toEqual(['a2']);
    });

    // Starting again is a new task with the same name, not the old one coming back.
    it('gives a restarted agent its full life again', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s1', finished('a1'));
      });
      act(() => result.current.observe('s1', prompt()));
      act(() => result.current.observe('s1', prompt()));

      act(() => result.current.dismiss('a1'));
      act(() => result.current.observe('s1', started('a1')));
      act(() => result.current.observe('s1', finished('a1')));
      act(() => result.current.observe('s1', prompt()));

      expect(result.current.watched).toHaveLength(1);
    });
  });

  it('finds one by id, and nothing for an id it never saw', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));

    expect(result.current.find('a1')?.agentId).toBe('a1');
    expect(result.current.find('never')).toBeNull();
    expect(result.current.find(null)).toBeNull();
  });
  /**
   * A reply arrives as hundreds of deltas and then once more in full. Kept raw, each chunk
   * was an event of its own and drew a row per fragment, which made a four-hundred-word
   * answer several hundred rows to build - slow to open and unreadable once open.
   */
  describe('folding what a subagent streams', () => {
    const delta = (agentId: string, messageId: string, deltaContent: string) =>
      ({ type: 'assistant.message_delta', agentId, data: { messageId, deltaContent } }) as TranscriptEvent;

    it('folds a run of deltas into one growing event', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s1', delta('a1', 'm1', 'Garbage '));
        result.current.observe('s1', delta('a1', 'm1', 'collectors '));
        result.current.observe('s1', delta('a1', 'm1', 'evolved.'));
      });

      const events = result.current.find('a1')?.events ?? [];
      expect(events).toHaveLength(1);
      expect((events[0]?.data as { deltaContent: string }).deltaContent).toBe('Garbage collectors evolved.');
    });

    /** The complete message says the same thing, so it replaces the run rather than following it. */
    it('lets the finished message replace the run it completes', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s1', delta('a1', 'm1', 'half a '));
        result.current.observe('s1', {
          type: 'assistant.message',
          agentId: 'a1',
          data: { messageId: 'm1', content: 'half a sentence' },
        } as TranscriptEvent);
      });

      const events = result.current.find('a1')?.events ?? [];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('assistant.message');
    });

    it('keeps two replies apart', () => {
      const { result } = renderHook(() => useSubagents());
      act(() => {
        result.current.observe('s1', started('a1'));
        result.current.observe('s1', delta('a1', 'm1', 'first'));
        result.current.observe('s1', delta('a1', 'm2', 'second'));
      });

      expect(result.current.find('a1')?.events).toHaveLength(2);
    });
  });
});
/**
 * Which delegated task is being read, held here rather than in App.
 *
 * It lived across seven sites there, and the two bugs below both came of the concern being
 * split from the data that answers it (#182).
 */
describe('reading one of them instead of its session', () => {
  it('has none open to begin with', () => {
    const { result } = renderHook(() => useSubagents());

    expect(result.current.openId).toBeNull();
    expect(result.current.open).toBeNull();
  });

  it('opens the one it is given', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1', 'explore')));

    act(() => result.current.setOpenId('a1'));

    expect(result.current.open?.agentId).toBe('a1');
    expect(result.current.open?.name).toBe('explore');
  });

  it('closes again', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.setOpenId('a1'));

    act(() => result.current.close());

    expect(result.current.openId).toBeNull();
    expect(result.current.open).toBeNull();
  });

  it('holds nothing open for a task it never saw', () => {
    const { result } = renderHook(() => useSubagents());

    act(() => result.current.setOpenId('nobody'));

    expect(result.current.open).toBeNull();
  });

  /**
   * Fixed in 14d65ef: closing on any unload shut the transcript someone was reading because
   * an unrelated session aged out. The `forget` beside it was already scoped; this was not.
   */
  it('keeps it open when another session is let go', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => {
      result.current.observe('s1', started('a1'));
      result.current.observe('s2', started('a2'));
    });
    act(() => result.current.setOpenId('a1'));

    act(() => result.current.forget('s2'));

    expect(result.current.open?.agentId).toBe('a1');
  });

  it('closes it when its own session is let go', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.setOpenId('a1'));

    act(() => result.current.forget('s1'));

    expect(result.current.openId).toBeNull();
  });

  it('leaves a closed view closed when a session goes', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));

    act(() => result.current.forget('s1'));

    expect(result.current.openId).toBeNull();
  });

  // Dismissing the one being read has to close it, or the view outlives its own entry.
  it('closes it when it is dismissed', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.setOpenId('a1'));

    act(() => result.current.dismiss('a1'));

    expect(result.current.openId).toBeNull();
  });

  it('keeps it open when a different one is dismissed', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => {
      result.current.observe('s1', started('a1'));
      result.current.observe('s1', started('a2'));
    });
    act(() => result.current.setOpenId('a1'));

    act(() => result.current.dismiss('a2'));

    expect(result.current.open?.agentId).toBe('a1');
  });

  // The events keep arriving while it is being read, and the view has to show them.
  it('follows the task it has open as it works', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.setOpenId('a1'));
    const before = result.current.open?.events.length ?? 0;

    act(() => result.current.observe('s1', working('a1', 'found it')));

    expect(result.current.open?.events.length).toBe(before + 1);
  });
});

/**
 * Handing a finished run over to the log (#178).
 *
 * A subagent's work is the largest thing this list holds, and none of it is this app's to
 * keep - the log has it. What matters is that letting go is never a guess: the read has to
 * come back with the run in it first.
 */
describe('letting the log keep a finished run', () => {
  const settle = async (result: { current: ReturnType<typeof useSubagents> }, agentId: string) => {
    await act(async () => {
      result.current.observe('s1', finished(agentId));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('lets go of the events once the log is shown to have them', async () => {
    getAgentTranscript.mockResolvedValue({ events: [started('a1'), working('a1', 'one'), working('a1', 'two')] });
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.observe('s1', working('a1', 'one')));

    await settle(result, 'a1');

    expect(result.current.watched[0]?.events).toEqual([]);
    expect(result.current.watched[0]?.onDisk).toBe(true);
  });

  it('asks the log for the run that just finished', async () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));

    await settle(result, 'a1');

    expect(getAgentTranscript).toHaveBeenCalledWith('s1', 'a1');
  });

  /** Without the announcement that opened it, the log has only part of the run. */
  it('keeps holding when the log does not have the whole run', async () => {
    getAgentTranscript.mockResolvedValue({ events: [working('a1', 'one')] });
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.observe('s1', working('a1', 'one')));

    await settle(result, 'a1');

    expect(result.current.watched[0]?.events.length).toBeGreaterThan(0);
    expect(result.current.watched[0]?.onDisk).toBeUndefined();
  });

  // Behind by design while the writing lands, and what is held is the only complete copy.
  it('keeps holding when the log has less than is held', async () => {
    getAgentTranscript.mockResolvedValue({ events: [started('a1')] });
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.observe('s1', working('a1', 'one')));
    act(() => result.current.observe('s1', working('a1', 'two')));

    await settle(result, 'a1');

    expect(result.current.watched[0]?.events.length).toBeGreaterThan(0);
  });

  it('keeps holding when the log cannot be read at all', async () => {
    getAgentTranscript.mockRejectedValue(new Error('gone'));
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.observe('s1', working('a1', 'one')));

    await settle(result, 'a1');

    expect(result.current.watched[0]?.events.length).toBeGreaterThan(0);
  });

  /**
   * What the user hit: a completed task that could never be kept, because the guard
   * compared everything watched against only what a log holds (#180).
   *
   * The live stream carries a run's machinery - how it was configured, when each turn began
   * and ended - and none of that is drawn, so none of it is read back. One real run watched
   * twenty-two events and the log offered ten of them.
   */
  it('hands over a run whose machinery the log does not keep', async () => {
    getAgentTranscript.mockResolvedValue({ events: [started('a1'), working('a1', 'one')] });
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.observe('s1', working('a1', 'one')));
    // Watched and never drawn, so the log has nothing to say about them.
    act(() => result.current.observe('s1', machinery('a1', 'subagent.configured')));
    act(() => result.current.observe('s1', machinery('a1', 'assistant.turn_start')));
    act(() => result.current.observe('s1', machinery('a1', 'assistant.turn_end')));

    await settle(result, 'a1');

    expect(result.current.watched[0]?.onDisk).toBe(true);
  });

  it('keeps holding when the log is short of what it should be drawing', async () => {
    getAgentTranscript.mockResolvedValue({ events: [started('a1')] });
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.observe('s1', working('a1', 'one')));
    act(() => result.current.observe('s1', working('a1', 'two')));

    await settle(result, 'a1');

    expect(result.current.watched[0]?.onDisk).toBeUndefined();
  });
});

/**
 * Which entries survive their session being let go (#178).
 *
 * A run the log holds can be shown again from disk, so the entry is worth keeping. One this
 * app is still the only copy of cannot, and an entry offering a transcript that cannot be
 * produced is worse than no entry.
 */
describe('a session being let go', () => {
  it('keeps a run the log was shown to hold', async () => {
    getAgentTranscript.mockResolvedValue({ events: [started('a1'), working('a1', 'one')] });
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    await act(async () => {
      result.current.observe('s1', finished('a1'));
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => result.current.forget('s1'));

    expect(result.current.watched).toHaveLength(1);
  });

  it('lets go of one it is still the only copy of', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.observe('s1', working('a1', 'one')));

    act(() => result.current.forget('s1'));

    expect(result.current.watched).toEqual([]);
  });

  it('leaves another session alone', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.observe('s2', started('a2')));

    act(() => result.current.forget('s1'));

    expect(result.current.watched.map((entry) => entry.agentId)).toEqual(['a2']);
  });

  /** Reading a kept one is the point of keeping it, so the view stays open. */
  it('leaves the open view alone when what it shows survives', async () => {
    getAgentTranscript.mockResolvedValue({ events: [started('a1')] });
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    await act(async () => {
      result.current.observe('s1', finished('a1'));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => result.current.setOpenId('a1'));

    act(() => result.current.forget('s1'));

    expect(result.current.openId).toBe('a1');
  });

  it('closes the open view when what it shows goes', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.setOpenId('a1'));

    act(() => result.current.forget('s1'));

    expect(result.current.openId).toBeNull();
  });
});

/**
 * Keeping a delegated task, so it stops ageing out (#180).
 *
 * The list lets a task go a few prompts after it finishes, which is right for the common
 * case and wrong for the one that matters most: a long audit is exactly the task worth
 * returning to an hour later, and it is the first to go.
 */
describe('keeping a delegated task', () => {
  const settle = async (result: { current: ReturnType<typeof useSubagents> }, agentId: string) => {
    await act(async () => {
      result.current.observe('s1', finished(agentId));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const handedOver = (agentId: string) => {
    getAgentTranscript.mockResolvedValue({ events: [started(agentId), working(agentId, 'one')] });
  };

  it('offers nothing to keep while this app is the only copy', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));

    expect(result.current.keepable('a1')).toBe(false);
  });

  it('offers to keep one the log was shown to hold', async () => {
    handedOver('a1');
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    await settle(result, 'a1');

    expect(result.current.keepable('a1')).toBe(true);
  });

  it('keeps nothing it could not offer to keep', () => {
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));

    act(() => result.current.keep('a1'));

    expect(result.current.isKept('a1')).toBe(false);
  });

  it('keeps one, and lets it go when asked again', async () => {
    handedOver('a1');
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    await settle(result, 'a1');

    act(() => result.current.keep('a1'));
    expect(result.current.isKept('a1')).toBe(true);

    act(() => result.current.keep('a1'));
    expect(result.current.isKept('a1')).toBe(false);
  });

  /** The point of keeping one: the prompts that age the others leave it alone. */
  it('stays through the prompts that age the rest out', async () => {
    handedOver('a1');
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    act(() => result.current.observe('s1', started('a2')));
    await settle(result, 'a1');
    act(() => result.current.observe('s1', finished('a2')));
    act(() => result.current.keep('a1'));

    for (let at = 0; at < 6; at++) act(() => result.current.observe('s1', prompt()));

    expect(result.current.watched.map((entry) => entry.agentId)).toEqual(['a1']);
  });

  it('stays when its session is let go', async () => {
    handedOver('a1');
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    await settle(result, 'a1');
    act(() => result.current.keep('a1'));

    act(() => result.current.forget('s1'));

    expect(result.current.watched).toHaveLength(1);
  });

  // Dismissing one is the plainest way of saying to stop keeping it.
  it('stops keeping one that is dismissed', async () => {
    handedOver('a1');
    const { result } = renderHook(() => useSubagents());
    act(() => result.current.observe('s1', started('a1')));
    await settle(result, 'a1');
    act(() => result.current.keep('a1'));

    act(() => result.current.dismiss('a1'));

    expect(result.current.isKept('a1')).toBe(false);
    expect(result.current.watched).toEqual([]);
  });

  /**
   * A task worth keeping for an hour is worth keeping over lunch. It comes back from what
   * was written down about it, with its work left in the log to be read when it is opened.
   */
  it('is offered again after a restart', async () => {
    handedOver('a1');
    const first = renderHook(() => useSubagents());
    act(() => first.result.current.observe('s1', started('a1', 'deep-audit')));
    await settle(first.result, 'a1');
    act(() => first.result.current.keep('a1'));
    first.unmount();

    const { result } = renderHook(() => useSubagents());

    expect(result.current.watched).toMatchObject([
      { agentId: 'a1', sessionId: 's1', name: 'deep-audit', onDisk: true, events: [] },
    ]);
  });

  it('is not offered again once it has been let go', async () => {
    handedOver('a1');
    const first = renderHook(() => useSubagents());
    act(() => first.result.current.observe('s1', started('a1')));
    await settle(first.result, 'a1');
    act(() => first.result.current.keep('a1'));
    act(() => first.result.current.keep('a1'));
    first.unmount();

    expect(renderHook(() => useSubagents()).result.current.watched).toEqual([]);
  });
});
