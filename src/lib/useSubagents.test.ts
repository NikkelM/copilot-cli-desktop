// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StrictMode } from 'react';

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

const working = (agentId: string, content: string) =>
  ({ type: 'assistant.message', agentId, data: { content } }) as TranscriptEvent;

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
