import { useEffect, useMemo, useState } from 'react';

import { TickIcon } from './Icons';
import { TODO_ORDERS, isDone, ordered, type TodoOrder } from '../lib/todoOrder';
import { read, save } from '../lib/store';
import type { Todo } from '../../shared/protocol';

interface TodosProps {
  todos: Todo[];
  onClose: () => void;
}

/**
 * How the panel was last read, which it opens the same way next time.
 *
 * In the sessions store rather than the settings one: this is where somebody left a panel,
 * not a decision they made about the app, and it is written whenever they change their mind
 * about a list rather than when they open a settings window.
 *
 * One answer for every session rather than one each. A reader who does not want to see
 * finished work does not want to see it in the next session either, and a per-session
 * answer would mean setting it again for every plan they open.
 */
const ORDER_KEY = 'todoOrder';
const HIDE_DONE_KEY = 'todoHideDone';

/** The order to open on, which is the one the agent wrote unless something else was chosen. */
function openingOrder(): TodoOrder {
  const last = read('sessions', ORDER_KEY);
  return TODO_ORDERS.some((one) => one.value === last) ? (last as TodoOrder) : 'planned';
}

/**
 * The four statuses the runtime's schema names, and what to draw for each.
 *
 * Anything else is drawn as a plain row with its own word beside it. The column is typed
 * as a free string by the runtime, so a value nobody here anticipated is shown as it
 * stands rather than folded into one of these.
 */
const MARK: Record<string, string> = {
  done: '✓',
  in_progress: '▸',
  blocked: '⊘',
  pending: '○',
};

/** `in_progress` is the table's word, not a word to put in front of anybody. */
const SAID: Record<string, string> = {
  done: 'done',
  in_progress: 'in progress',
  blocked: 'blocked',
  pending: 'to do',
};

/**
 * What the agent says it is doing (#172).
 *
 * The runtime keeps the agent's todos in the session's own database and announces every
 * write to it. The CLI draws them as a checklist; this app drew nothing, so a long piece of
 * work gave no account of itself beyond whatever scrolled past.
 *
 * In a panel rather than a transcript row, because a plan is not an event: it is amended as
 * the work goes on, and a row saying what was intended twenty minutes ago would scroll away
 * from the work it describes and then be wrong.
 *
 * The dependency edges are drawn rather than merely held. An item nobody has started looks
 * the same as one that cannot be started until something else finishes, and the difference
 * between those two is most of what a plan is for.
 */
export function Todos({ todos, onClose }: TodosProps) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  const [order, setOrder] = useState<TodoOrder>(openingOrder);
  const [hideDone, setHideDone] = useState(() => read('sessions', HIDE_DONE_KEY) === 'true');

  const toggleDone = () =>
    setHideDone((was) => {
      save('sessions', HIDE_DONE_KEY, String(!was));
      return !was;
    });

  const shown = useMemo(() => ordered(todos, order, hideDone), [todos, order, hideDone]);

  // Counted over everything, not over what is drawn. This is the one line saying how much of
  // the plan is finished, and hiding the finished rows should not take that away as well.
  const done = todos.filter(isDone).length;
  const titles = new Map(todos.map((todo) => [todo.id, todo.title]));

  return (
    <div className="todos" data-region="panel" tabIndex={-1}>
      <div className="todos-head">
        <span className="todos-title">
          {done} of {todos.length} done
        </span>

        <select
          className="todos-sort"
          aria-label="Order"
          value={order}
          onChange={(event) => {
            const chosen = event.target.value as TodoOrder;
            setOrder(chosen);
            save('sessions', ORDER_KEY, chosen);
          }}
        >
          {TODO_ORDERS.map((one) => (
            <option key={one.value} value={one.value}>
              {one.label}
            </option>
          ))}
        </select>

        {/* Drawn the way the settings boxes are, which is the only checkbox style this app
            has. A box answers Space and nothing else, which is a surprise beside controls
            that both answer Enter. */}
        <label className="todos-filter">
          <span className="tickbox">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={toggleDone}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                toggleDone();
              }}
            />
            <TickIcon />
          </span>
          Hide done
        </label>

        <button type="button" className="todos-action" onClick={onClose}>
          Close
        </button>
      </div>

      <ol className="todos-list">
        {shown.map((todo) => {
          // What it waits on that is not finished yet. Everything it waits on is still
          // named on a finished item, but only an unmet one explains why nothing is
          // happening - which is the question the list is being read to answer.
          const waiting = todo.dependsOn.filter((id) => {
            const on = todos.find((other) => other.id === id);
            return on && on.status !== 'done';
          });

          return (
            <li key={todo.id} className="todo" data-status={todo.status}>
              <span className="todo-mark" aria-hidden="true">
                {MARK[todo.status] ?? '·'}
              </span>
              <div className="todo-body">
                <span className="todo-name">{todo.title || 'Untitled'}</span>
                {todo.description && <span className="todo-detail">{todo.description}</span>}
                {waiting.length > 0 && (
                  <span className="todo-waiting">
                    Waiting on {waiting.map((id) => titles.get(id) || id).join(', ')}
                  </span>
                )}
              </div>
              <span className="todo-status">{SAID[todo.status] ?? todo.status}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
