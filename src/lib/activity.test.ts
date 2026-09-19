import { describe, expect, it } from 'vitest';

import { activityOf, describeActivity } from './activity';
import type { PendingElicitation, PendingPermission, PendingPlanApproval } from '../../shared/protocol';

const permission = (sessionId: string) => ({ sessionId, requestId: 'p1' }) as PendingPermission;
const elicitation = (sessionId: string) => ({ sessionId, requestId: 'e1' }) as PendingElicitation;
const plan = (sessionId: string) => ({ sessionId, requestId: 'pl1' }) as PendingPlanApproval;

describe('activityOf', () => {
  it('says nothing about a session doing nothing', () => {
    expect(activityOf(new Set(), [], {})).toEqual({});
  });

  it('marks a session with a turn running', () => {
    expect(activityOf(new Set(['a']), [], {})).toEqual({ a: { state: 'working', queued: 0 } });
  });

  /** The one state that asks for something, so it wins over merely running. */
  it('lets a decision outrank the turn it is blocking', () => {
    expect(activityOf(new Set(['a']), [permission('a')], {})).toEqual({ a: { state: 'blocked', queued: 0 } });
  });

  it('treats a question the same way as a permission', () => {
    expect(activityOf(new Set(), [elicitation('a')], {})).toEqual({ a: { state: 'blocked', queued: 0 } });
  });

  /** A plan blocks the agent as surely as a permission does, and for far longer. */
  it('treats a plan awaiting approval the same way', () => {
    expect(activityOf(new Set(), [plan('a')], {})).toEqual({ a: { state: 'blocked', queued: 0 } });
  });

  /** Queued explains a delay rather than causing one, so it never hides what is happening. */
  it('keeps the count without letting it displace the state', () => {
    expect(activityOf(new Set(['a']), [], { a: 2 })).toEqual({ a: { state: 'working', queued: 2 } });
  });

  it('stands alone when there is no turn to hide behind', () => {
    expect(activityOf(new Set(), [], { a: 1 })).toEqual({ a: { state: 'queued', queued: 1 } });
  });

  it('ignores a queue that has been emptied', () => {
    expect(activityOf(new Set(), [], { a: 0 })).toEqual({});
  });

  it('keeps sessions apart', () => {
    expect(activityOf(new Set(['a']), [permission('b')], {})).toEqual({
      a: { state: 'working', queued: 0 },
      b: { state: 'blocked', queued: 0 },
    });
  });
});

describe('describeActivity', () => {
  it('names the state in words rather than leaving it to the colour', () => {
    expect(describeActivity({ state: 'working', queued: 0 })).toBe('Working');
    expect(describeActivity({ state: 'idle', queued: 0 })).toBe('Loaded in memory');
  });

  it('says what a blocked session needs', () => {
    expect(describeActivity({ state: 'blocked', queued: 0 })).toContain('blocked');
  });

  it('counts what is waiting, in the plural only when it should be', () => {
    expect(describeActivity({ state: 'queued', queued: 1 })).toBe('1 message waiting');
    expect(describeActivity({ state: 'queued', queued: 3 })).toBe('3 messages waiting');
  });

  it('mentions the queue alongside the state it sits behind', () => {
    expect(describeActivity({ state: 'working', queued: 2 })).toBe('Working. 2 messages waiting');
  });
});

/**
 * A resume is the only thing a session can be doing without being loaded, and it is the one
 * state slow enough to be worth drawing: the reader who asked for it is watching the row
 * they asked about, and a row that sits still reads as nothing having happened.
 */
describe('a session coming into memory', () => {
  it('says so', () => {
    expect(activityOf(new Set(), [], {}, new Set(['a']))).toEqual({ a: { state: 'loading', queued: 0 } });
  });

  it('gives way to anything the session turns out to be doing', () => {
    // A resume that has already produced a question is answering it, not still arriving.
    expect(activityOf(new Set(['a']), [], {}, new Set(['a'])).a?.state).toBe('working');
    expect(activityOf(new Set(), [permission('a')], {}, new Set(['a'])).a?.state).toBe('blocked');
    expect(activityOf(new Set(), [], { a: 2 }, new Set(['a'])).a?.state).toBe('queued');
  });

  it('outranks idle, which is what a session with nothing to say reads as', () => {
    expect(activityOf(new Set(), [], { a: 0 }, new Set(['a'])).a?.state).toBe('loading');
  });

  it('says nothing about a session that is not coming', () => {
    expect(activityOf(new Set(), [], {}, new Set(['a'])).b).toBeUndefined();
  });

  it('is described in a way that says it is not there yet', () => {
    expect(describeActivity({ state: 'loading', queued: 0 })).toBe('Coming into memory');
  });

  it('leaves every other reading alone when nothing is loading', () => {
    // The argument is optional, since most callers have nothing to say about it.
    expect(activityOf(new Set(['a']), [], {})).toEqual({ a: { state: 'working', queued: 0 } });
  });
});