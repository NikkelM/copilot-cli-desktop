// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Todo } from '../../shared/protocol';
import { Todos } from './Todos';
import { resetStores, save } from '../lib/store';

// The panel remembers how it was last read, so one test's choice is another's starting
// point unless the store is put back between them.
beforeEach(resetStores);

const todo = (over: Partial<Todo> & { id: string }): Todo => ({
  title: `Todo ${over.id}`,
  status: 'pending',
  dependsOn: [],
  ...over,
});

const shown = (todos: Todo[], onClose = vi.fn()) => {
  render(<Todos todos={todos} onClose={onClose} />);
  return { onClose, user: userEvent.setup() };
};

const rows = () => [...document.querySelectorAll('.todo')];
const waiting = () => [...document.querySelectorAll('.todo-waiting')].map((node) => node.textContent);

/**
 * What the agent says it is doing (#172).
 *
 * The CLI draws this as a checklist and the app drew nothing, so a long piece of work gave
 * no account of itself beyond whatever scrolled past.
 */
describe('the agent’s todo list', () => {
  it('draws one row per todo', () => {
    shown([todo({ id: 'a' }), todo({ id: 'b' })]);

    expect(rows()).toHaveLength(2);
  });

  it('says how much of it is done', () => {
    shown([todo({ id: 'a', status: 'done' }), todo({ id: 'b' }), todo({ id: 'c', status: 'done' })]);

    expect(document.querySelector('.todos-title')?.textContent).toBe('2 of 3 done');
  });

  it('shows what each one is called', () => {
    shown([todo({ id: 'a', title: 'Read the log from the end' })]);

    expect(screen.getByText('Read the log from the end')).toBeTruthy();
  });

  it('shows the description where there is one', () => {
    shown([todo({ id: 'a', description: 'backwards, so the tail costs nothing' })]);

    expect(screen.getByText('backwards, so the tail costs nothing')).toBeTruthy();
  });

  it('carries the status onto the row, for the styling to find', () => {
    shown([todo({ id: 'a', status: 'in_progress' })]);

    expect(rows()[0]?.getAttribute('data-status')).toBe('in_progress');
  });

  /** `in_progress` is the table's word, not a word to put in front of anybody. */
  it('says the status in words rather than in the table’s', () => {
    shown([todo({ id: 'a', status: 'in_progress' })]);

    expect(document.querySelector('.todo-status')?.textContent).toBe('in progress');
  });

  /** The column is a free string, so a value nobody anticipated is shown as it stands. */
  it('shows a status it has no word for rather than hiding it', () => {
    shown([todo({ id: 'a', status: 'deferred' })]);

    expect(document.querySelector('.todo-status')?.textContent).toBe('deferred');
  });

  it('gives an untitled todo something to be', () => {
    shown([todo({ id: 'a', title: '' })]);

    expect(screen.getByText('Untitled')).toBeTruthy();
  });

  /**
   * An item nobody has started looks the same as one that cannot be started until
   * something else finishes, and the difference is most of what a plan is for.
   */
  describe('what a todo is waiting on', () => {
    it('names it, rather than leaving the row looking merely unstarted', () => {
      shown([
        todo({ id: 'a', title: 'Write the schema' }),
        todo({ id: 'b', title: 'Use the schema', dependsOn: ['a'] }),
      ]);

      expect(waiting()).toEqual(['Waiting on Write the schema']);
    });

    it('names every one it is still waiting on', () => {
      shown([
        todo({ id: 'a', title: 'First' }),
        todo({ id: 'b', title: 'Second' }),
        todo({ id: 'c', title: 'Third', dependsOn: ['a', 'b'] }),
      ]);

      expect(waiting()).toEqual(['Waiting on First, Second']);
    });

    // A finished dependency explains nothing: the row is free to start.
    it('says nothing about one that is already done', () => {
      shown([
        todo({ id: 'a', title: 'First', status: 'done' }),
        todo({ id: 'b', title: 'Second', dependsOn: ['a'] }),
      ]);

      expect(waiting()).toEqual([]);
    });

    it('names only the ones that are not done yet', () => {
      shown([
        todo({ id: 'a', title: 'Done one', status: 'done' }),
        todo({ id: 'b', title: 'Pending one' }),
        todo({ id: 'c', title: 'Third', dependsOn: ['a', 'b'] }),
      ]);

      expect(waiting()).toEqual(['Waiting on Pending one']);
    });

    it('says nothing for a todo that waits on nothing', () => {
      shown([todo({ id: 'a' })]);

      expect(waiting()).toEqual([]);
    });
  });

  it('closes on Escape, as the other panels do', async () => {
    const { onClose, user } = shown([todo({ id: 'a' })]);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('closes when asked', async () => {
    const { onClose, user } = shown([todo({ id: 'a' })]);

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * Reading a plan after the fact (#253, #255).
 *
 * A long plan ends up mostly finished, so the part that is still live gets harder to find as
 * the work goes on - which is exactly when the panel is most worth opening.
 */
describe('how the list is read', () => {
  const names = () => [...document.querySelectorAll('.todo-name')].map((node) => node.textContent);
  const sort = () => screen.getByLabelText('Order') as HTMLSelectElement;
  const hide = () => screen.getByRole('checkbox', { name: 'Hide done' }) as HTMLInputElement;

  const plan = () => [
    todo({ id: 'a', title: 'First', status: 'done', createdAt: '2026-01-01 00:00:01' }),
    todo({ id: 'b', title: 'Second', status: 'pending', createdAt: '2026-01-01 00:00:02' }),
    todo({ id: 'c', title: 'Third', status: 'in_progress', createdAt: '2026-01-01 00:00:03' }),
  ];

  /** What the agent wrote, which is also what the CLI draws: changing it would surprise. */
  it('opens in the order the agent planned', () => {
    shown(plan());

    expect(sort().value).toBe('planned');
    expect(names()).toEqual(['First', 'Second', 'Third']);
  });

  it('reorders when another order is chosen', async () => {
    const { user } = shown(plan());

    await user.selectOptions(sort(), 'open');

    expect(names()).toEqual(['Third', 'Second', 'First']);
  });

  it('leaves out what is done when asked', async () => {
    const { user } = shown(plan());

    await user.click(hide());

    expect(names()).toEqual(['Second', 'Third']);
  });

  /**
   * The count is the one line saying how much of the plan is finished. Hiding the finished
   * rows and the count together would take that away.
   */
  it('goes on counting what it is no longer showing', async () => {
    const { user } = shown(plan());

    await user.click(hide());

    expect(document.querySelector('.todos-title')?.textContent).toBe('1 of 3 done');
  });

  /** A box answers Space and nothing else, which surprises beside controls that take Enter. */
  it('takes Enter on the box as well as Space', async () => {
    const { user } = shown(plan());
    hide().focus();

    await user.keyboard('{Enter}');

    expect(names()).toEqual(['Second', 'Third']);
  });

  it('opens the way it was last read', async () => {
    const { user } = shown(plan());
    await user.selectOptions(sort(), 'created');
    await user.click(hide());

    cleanup();
    render(<Todos todos={plan()} onClose={vi.fn()} />);

    expect(sort().value).toBe('created');
    expect(hide().checked).toBe(true);
  });

  /** A stored order from a later version should leave the panel readable, not empty. */
  it('opens on the planned order when the stored one means nothing', () => {
    save('sessions', 'todoOrder', 'from-the-future');

    render(<Todos todos={plan()} onClose={vi.fn()} />);

    expect(sort().value).toBe('planned');
    expect(names()).toEqual(['First', 'Second', 'Third']);
  });
});
