// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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
});
