import { describe, expect, it } from 'vitest';

import { TODO_ORDERS, isDone, ordered } from './todoOrder';
import type { Todo } from '../../shared/protocol';

/** A todo, with only what a test is about spelled out. */
const todo = (id: string, over: Partial<Todo> = {}): Todo => ({
  id,
  title: id,
  status: 'pending',
  dependsOn: [],
  createdAt: '2026-01-01 00:00:00',
  updatedAt: '2026-01-01 00:00:00',
  ...over,
});

/** What came out, by id, which is what every order here is actually about. */
const ids = (list: Todo[]) => list.map((one) => one.id);

describe('the orders there are', () => {
  it('offers planned order first, since that is what the agent wrote', () => {
    expect(TODO_ORDERS[0]?.value).toBe('planned');
  });

  it('names every one of them', () => {
    expect(TODO_ORDERS.map((one) => one.value)).toEqual(['planned', 'open', 'changed', 'created']);
    for (const one of TODO_ORDERS) expect(one.label.length).toBeGreaterThan(0);
  });
});

describe('planned order', () => {
  it('is the list exactly as it arrived', () => {
    const list = [todo('c'), todo('a'), todo('b')];

    expect(ids(ordered(list, 'planned'))).toEqual(['c', 'a', 'b']);
  });

  /** Nothing to sort means nothing to copy, and the panel compares what it is given. */
  it('hands back the same list rather than a copy of it', () => {
    const list = [todo('a')];

    expect(ordered(list, 'planned')).toBe(list);
  });
});

describe('open first', () => {
  /**
   * In progress leads, because it is the one thing actually happening. Blocked sits with
   * what is waiting rather than with what is finished: it is unfinished work, and a reader
   * asking what is left wants to know something is stuck.
   */
  it('puts what is happening above what is waiting above what is done', () => {
    const list = [
      todo('done', { status: 'done' }),
      todo('blocked', { status: 'blocked' }),
      todo('pending', { status: 'pending' }),
      todo('doing', { status: 'in_progress' }),
    ];

    expect(ids(ordered(list, 'open'))).toEqual(['doing', 'pending', 'blocked', 'done']);
  });

  /** A list that reshuffles its equal rows whenever one is touched cannot be followed. */
  it('keeps the planned order within a status', () => {
    const list = [todo('third'), todo('first'), todo('second')];

    expect(ids(ordered(list, 'open'))).toEqual(['third', 'first', 'second']);
  });

  /** The column is constrained to four, so this is a database a later version wrote. */
  it('treats a status it does not know as unfinished', () => {
    const list = [todo('done', { status: 'done' }), todo('odd', { status: 'deferred' })];

    expect(ids(ordered(list, 'open'))).toEqual(['odd', 'done']);
  });

  it('still puts a known waiting status above an unknown one', () => {
    const list = [todo('odd', { status: 'deferred' }), todo('blocked', { status: 'blocked' })];

    expect(ids(ordered(list, 'open'))).toEqual(['blocked', 'odd']);
  });
});

describe('by time', () => {
  it('puts the most recently changed first', () => {
    const list = [
      todo('old', { updatedAt: '2026-01-01 00:00:00' }),
      todo('new', { updatedAt: '2026-03-01 00:00:00' }),
      todo('middle', { updatedAt: '2026-02-01 00:00:00' }),
    ];

    expect(ids(ordered(list, 'changed'))).toEqual(['new', 'middle', 'old']);
  });

  it('puts the most recently created first', () => {
    const list = [
      todo('old', { createdAt: '2026-01-01 00:00:00' }),
      todo('new', { createdAt: '2026-03-01 00:00:00' }),
    ];

    expect(ids(ordered(list, 'created'))).toEqual(['new', 'old']);
  });

  /** Two orders over two columns, which have to be told apart or one of them is a lie. */
  it('reads the column the order is named for', () => {
    const list = [
      todo('a', { createdAt: '2026-01-01 00:00:00', updatedAt: '2026-03-01 00:00:00' }),
      todo('b', { createdAt: '2026-02-01 00:00:00', updatedAt: '2026-02-01 00:00:00' }),
    ];

    expect(ids(ordered(list, 'changed')), 'a moved last').toEqual(['a', 'b']);
    expect(ids(ordered(list, 'created')), 'b was written last').toEqual(['b', 'a']);
  });

  /** Where a row with no time belongs: last, rather than claiming to be the newest there is. */
  it('sorts a row with no time to the end', () => {
    const list = [todo('none', { updatedAt: undefined }), todo('dated', { updatedAt: '2026-01-01 00:00:00' })];

    expect(ids(ordered(list, 'changed'))).toEqual(['dated', 'none']);
  });

  it('keeps the planned order for two written at the same moment', () => {
    const list = [todo('second'), todo('first')];

    expect(ids(ordered(list, 'created'))).toEqual(['second', 'first']);
  });
});

describe('leaving out what is finished', () => {
  it('drops exactly the done ones', () => {
    const list = [todo('a', { status: 'done' }), todo('b'), todo('c', { status: 'blocked' })];

    expect(ids(ordered(list, 'planned', true))).toEqual(['b', 'c']);
  });

  it('keeps them when it was not asked for', () => {
    const list = [todo('a', { status: 'done' }), todo('b')];

    expect(ids(ordered(list, 'planned', false))).toEqual(['a', 'b']);
  });

  /** A status nobody here anticipated is unfinished work, so hiding it would lose it. */
  it('keeps a status it does not know', () => {
    const list = [todo('odd', { status: 'deferred' })];

    expect(ids(ordered(list, 'planned', true))).toEqual(['odd']);
  });

  it('applies whichever order is being read', () => {
    const list = [todo('done', { status: 'done' }), todo('doing', { status: 'in_progress' }), todo('todo')];

    expect(ids(ordered(list, 'open', true))).toEqual(['doing', 'todo']);
  });
});

describe('whether a todo is finished', () => {
  it.each([
    ['done', true],
    ['pending', false],
    ['blocked', false],
    ['in_progress', false],
    ['', false],
  ])('says %s is %s', (status, finished) => {
    expect(isDone(todo('a', { status }))).toBe(finished);
  });
});
