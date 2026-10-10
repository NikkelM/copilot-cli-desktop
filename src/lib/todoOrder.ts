import type { Todo } from '../../shared/protocol';

/**
 * The orders a plan can be read in (#253).
 *
 * `created` is the default, newest first, because the panel opens at the top and that is
 * where a reader's attention starts: a long plan with its newest rows at the bottom opens
 * on work finished weeks ago. `planned` is the same column the other way, which is the order
 * the agent wrote and the CLI draws - worth having for following a plan through, and no
 * longer worth opening on.
 */
export type TodoOrder = 'planned' | 'open' | 'changed' | 'created';

/** Where the panel opens, for a reader who has not said otherwise. */
export const OPENS_ON: TodoOrder = 'created';

/** What each order is called, in the order the picker offers them. */
export const TODO_ORDERS: readonly { value: TodoOrder; label: string }[] = [
  { value: 'created', label: 'Newest first' },
  { value: 'planned', label: 'Oldest first' },
  { value: 'open', label: 'Open first' },
  { value: 'changed', label: 'Recently changed' },
];

/**
 * Where each status sits when what is left comes first.
 *
 * In progress leads, because it is the one thing actually happening. Blocked sits with what
 * is waiting rather than with what is finished: it is unfinished work, and a reader asking
 * what is left wants to know something is stuck.
 */
const RANK: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  blocked: 2,
  done: 4,
};

/**
 * Anything the table does not name sits above done and below what is waiting.
 *
 * The column is constrained to the four, so this is for a database written by a version
 * that knows a fifth - which is unfinished work until something says otherwise.
 */
const UNKNOWN = 3;

/** Whether a todo is finished, which is the one status worth filtering on. */
export function isDone(todo: Todo): boolean {
  return todo.status === 'done';
}

/**
 * A plan in the order it is to be read, and without what is finished if that was asked for.
 *
 * Sorted rather than grouped. The three that are not `planned` are all orders over the whole
 * list, and a picker offering one list of four is simpler to use than a grouping with sorts
 * inside it - which is the same list with a joint in the middle.
 *
 * Equal rows keep the order the agent wrote them in, which `sort` gives for nothing: it has
 * been stable since ES2019. A list that reshuffles its equal rows whenever the agent touches
 * one is a list nobody can follow.
 */
export function ordered(todos: Todo[], order: TodoOrder, hideDone = false): Todo[] {
  const shown = hideDone ? todos.filter((todo) => !isDone(todo)) : todos;
  if (order === 'planned') return shown;

  if (order === 'open') {
    const rank = (todo: Todo) => RANK[todo.status] ?? UNKNOWN;
    return [...shown].sort((one, other) => rank(one) - rank(other));
  }

  // Compared as the strings they are: the table writes UTC in a format that sorts correctly
  // as text, so parsing them would only be a way to get it wrong.
  const when = (todo: Todo) => (order === 'changed' ? todo.updatedAt : todo.createdAt) ?? '';
  // Newest first, which is what both of these orders are for. A row with no time at all
  // sorts last rather than first, where it would claim to be the newest thing there is.
  return [...shown].sort((one, other) => when(other).localeCompare(when(one)));
}
