// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { QueuedItem } from '../../shared/protocol';

import { Queue } from './Queue';

const message = (id: string, text: string): QueuedItem => ({ id, kind: 'message', text });
const file = (path: string) => ({ type: 'file' as const, path });

describe('Queue', () => {
  // The row is a frame around what is waiting; with nothing it is a frame around nothing.
  it('shows nothing when nothing is waiting', () => {
    const { container } = render(<Queue items={[]} />);
    expect(container.textContent).toBe('');
  });

  it('lists what is waiting, in the order it will run', () => {
    render(<Queue items={[message('a', 'first thing'), message('b', 'second thing')]} />);

    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items[0]).toContain('first thing');
    expect(items[1]).toContain('second thing');
  });

  // Which one goes next is the only ordering worth showing.
  it('marks the one that goes next', () => {
    render(<Queue items={[message('a', 'first thing'), message('b', 'second thing')]} />);

    expect(screen.getAllByRole('listitem')[0].textContent).toContain('Next');
    expect(screen.getAllByRole('listitem')[1].textContent).toContain('2');
  });

  it('says how many are waiting', () => {
    render(<Queue items={[message('a', 'one')]} />);
    expect(screen.getByText(/1 queued/)).toBeTruthy();
  });

  // A queued command is not a message, and reads as one without being marked.
  it('distinguishes a queued command from a message', () => {
    render(<Queue items={[message('a', 'one'), { id: 'b', kind: 'command', text: '/compact' }]} />);

    const rows = screen.getAllByRole('listitem');
    expect(rows[0].querySelector('.queue-text.command')).toBeNull();
    expect(rows[1].querySelector('.queue-text.command')).not.toBeNull();
  });
});
/**
 * Changing your mind about something already waiting (#76). The runtime owns the queue and
 * is consuming from it as the turn runs, so everything here only asks - what is waiting
 * afterwards is whatever the runtime then reports.
 */
describe('Queue, changing what is waiting', () => {
  const user = userEvent.setup();

  it('offers nothing to change when nothing can be', () => {
    render(<Queue items={[message('a', 'first thing')]} />);

    expect(screen.queryByLabelText('Take this back')).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Clear')).toBeNull();
    expect(screen.queryByLabelText('Send this into the turn that is running')).toBeNull();
  });

  it('takes one back', async () => {
    const onRemove = vi.fn();
    render(<Queue items={[message('a', 'first thing')]} onRemove={onRemove} />);

    await user.click(screen.getByLabelText('Take this back'));

    expect(onRemove).toHaveBeenCalledWith('a');
  });

  it('drops everything waiting', async () => {
    const onClear = vi.fn();
    render(<Queue items={[message('a', 'first'), message('b', 'second')]} onClear={onClear} />);

    await user.click(screen.getByText('Clear'));

    expect(onClear).toHaveBeenCalled();
  });

  /** A queued command or a model change is not text somebody wrote, so there is nothing to rewrite. */
  it('does not offer to rewrite a queued command', () => {
    render(<Queue items={[{ id: 'c', kind: 'command', text: '/model' }]} onEdit={() => {}} onRemove={() => {}} />);

    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.getByLabelText('Take this back')).toBeTruthy();
  });

  it('hands one to the turn that is running', async () => {
    const onSendNow = vi.fn();
    render(<Queue items={[message('a', 'first thing')]} onSendNow={onSendNow} />);

    await user.click(screen.getByLabelText('Send this into the turn that is running'));

    expect(onSendNow).toHaveBeenCalledWith('a');
  });

  /** Steering is something for the agent to take account of mid-answer, which a command is not. */
  it('does not offer to steer a queued command', () => {
    render(<Queue items={[{ id: 'c', kind: 'command', text: '/model' }]} onSendNow={() => {}} />);

    expect(screen.queryByLabelText('Send this into the turn that is running')).toBeNull();
  });

  it('moves one sooner and later, by where it is shown', async () => {
    const onMove = vi.fn();
    render(
      <Queue items={[message('a', 'first'), message('b', 'second'), message('c', 'third')]} onMove={onMove} />,
    );

    const sooner = screen.getAllByLabelText('Run this one sooner');
    const later = screen.getAllByLabelText('Run this one later');

    await user.click(sooner[2]!);
    expect(onMove).toHaveBeenCalledWith('c', 1);

    await user.click(later[0]!);
    expect(onMove).toHaveBeenCalledWith('a', 1);
  });

  it('cannot move the first one sooner or the last one later', () => {
    render(<Queue items={[message('a', 'first'), message('b', 'second')]} onMove={() => {}} />);

    expect((screen.getAllByLabelText('Run this one sooner')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByLabelText('Run this one later')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  /** Nowhere to move to, so the arrows would only ever be two disabled buttons. */
  it('offers no reordering for a queue of one', () => {
    render(<Queue items={[message('a', 'alone')]} onMove={() => {}} />);

    expect(screen.queryByLabelText('Run this one sooner')).toBeNull();
  });

  /**
   * The composer is where a queued message is rewritten, because it is the only box in the
   * app that handles several lines and attachments. The row hands over the whole message
   * rather than only its id, so nothing has to be looked up again to fill the box.
   */
  it('hands the message to the composer rather than opening a box of its own', async () => {
    const onEdit = vi.fn();
    render(<Queue items={[message('a', 'first thing')]} onEdit={onEdit} />);

    await user.click(screen.getByText('Edit'));

    expect(onEdit).toHaveBeenCalledWith({ id: 'a', kind: 'message', text: 'first thing' });
    expect(screen.queryByRole('textbox'), 'nothing is typed into the row itself').toBeNull();
  });

  /** So the row and the words in the composer are read as the same message. */
  it('marks the row whose message is in the composer', () => {
    const { container } = render(
      <Queue items={[message('a', 'first'), message('b', 'second')]} onEdit={() => {}} editing="b" />,
    );

    const rows = container.querySelectorAll('.queue-item');
    expect(rows[0]?.className).not.toContain('editing');
    expect(rows[1]?.className).toContain('editing');
  });
});

/**
 * The runtime does not report what a waiting message carries, so a row can only say so for
 * a message this app sent. Saying nothing is not the same as saying none.
 */
describe('Queue, what a waiting message carries', () => {
  it('says how many files went with it', () => {
    render(<Queue items={[{ id: 'a', kind: 'message', text: 'look at these', attachments: [file('a.png'), file('b.png'), file('c.png')] }]} />);

    expect(screen.getByText('3 files')).toBeTruthy();
  });

  it('counts one file as one rather than as a number of them', () => {
    render(<Queue items={[{ id: 'a', kind: 'message', text: 'look at this', attachments: [file('a.png')] }]} />);

    expect(screen.getByText('1 file')).toBeTruthy();
  });

  /** Nothing known is not nothing attached, and a row must not claim otherwise. */
  it('says nothing about a message it knows nothing about', () => {
    const { container } = render(<Queue items={[message('a', 'from somewhere else')]} />);

    expect(container.querySelector('.queue-attached')).toBeNull();
  });
});

/**
 * Holding stops the queue draining without stopping the turn, so several things can be
 * lined up and let go deliberately.
 */
describe('Queue, holding what is waiting', () => {
  const user = userEvent.setup();

  it('asks for the hold when it is not held', async () => {
    const onHold = vi.fn();
    render(<Queue items={[message('a', 'first')]} onHold={onHold} />);

    await user.click(screen.getByText('Hold'));

    expect(onHold).toHaveBeenCalledWith(true);
  });

  it('offers to let it go again once held, and says that it is', async () => {
    const onHold = vi.fn();
    render(<Queue items={[message('a', 'first')]} onHold={onHold} held />);

    expect(screen.getByText(/held, nothing will run/)).toBeTruthy();
    await user.click(screen.getByText('Release'));

    expect(onHold).toHaveBeenCalledWith(false);
  });

  it('offers neither where the queue cannot be held', () => {
    render(<Queue items={[message('a', 'first')]} />);

    expect(screen.queryByText('Hold')).toBeNull();
    expect(screen.queryByText('Release')).toBeNull();
  });
});

/**
 * Up to five controls on a row, so walking them one at a time meant pressing Tab five times
 * to reach the message below (#249).
 */
describe('walking the queue with the arrows', () => {
  const three = [message('a', 'first'), message('b', 'second'), message('c', 'third')];
  const full = () =>
    render(
      <Queue
        items={three}
        onRemove={() => {}}
        onEdit={() => {}}
        onMove={() => {}}
        onSendNow={() => {}}
      />,
    );

  const rows = () => [...document.querySelectorAll('.queue-item')] as HTMLElement[];
  const buttonsIn = (row: HTMLElement) => [...row.querySelectorAll('button')] as HTMLElement[];

  it('goes to the first control of the message below', () => {
    full();
    const first = rows()[0]!;
    buttonsIn(first)[1]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });

    expect(document.activeElement, 'the row below, from its start').toBe(buttonsIn(rows()[1]!)[0]);
  });

  it('goes to the message above', () => {
    full();
    buttonsIn(rows()[2]!)[0]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(buttonsIn(rows()[1]!)[0]);
  });

  it('walks along the controls of one message', () => {
    full();
    const row = rows()[1]!;
    buttonsIn(row)[0]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });

    expect(document.activeElement, 'still the same message').toBe(buttonsIn(row)[1]);
  });

  it('comes back along them', () => {
    full();
    const row = rows()[1]!;
    buttonsIn(row)[1]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });

    expect(document.activeElement).toBe(buttonsIn(row)[0]);
  });

  /**
   * Left and right stay on the message they were pressed on.
   *
   * Asked of the row rather than of the list, so the end of one row comes round to its own
   * start rather than running on into the next message's controls - which is the difference
   * between moving the keyboard and losing it.
   */
  it('comes round within the one message rather than running into the next', () => {
    full();
    const row = rows()[1]!;
    const buttons = buttonsIn(row);
    buttons[buttons.length - 1]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });

    expect(document.activeElement).toBe(buttons[0]);
  });

  /**
   * Moving a message was offered only as a pair of buttons to find and press. Ctrl and an
   * arrow is the shorter way, and the one a reader already holding the keyboard reaches for.
   */
  it('moves the message itself on a held arrow', () => {
    const onMove = vi.fn();
    render(<Queue items={three} onRemove={() => {}} onEdit={() => {}} onMove={onMove} onSendNow={() => {}} />);
    const buttons = [...rows()[0]!.querySelectorAll('button')] as HTMLElement[];
    buttons[0]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', ctrlKey: true });

    expect(onMove).toHaveBeenCalledWith('a', 1);
  });

  /** Off the end there is nowhere to go, so the press belongs to whatever else wanted it. */
  it('leaves a held arrow alone at the end it is already at', () => {
    const onMove = vi.fn();
    render(<Queue items={three} onRemove={() => {}} onEdit={() => {}} onMove={onMove} onSendNow={() => {}} />);
    const buttons = [...rows()[0]!.querySelectorAll('button')] as HTMLElement[];
    buttons[0]!.focus();

    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);

    expect(onMove).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not move the keyboard when it moves the message', () => {
    const onMove = vi.fn();
    render(<Queue items={three} onRemove={() => {}} onEdit={() => {}} onMove={onMove} onSendNow={() => {}} />);
    const buttons = [...rows()[0]!.querySelectorAll('button')] as HTMLElement[];
    buttons[0]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', ctrlKey: true });

    expect(document.activeElement, 'the list has not been told to redraw here').toBe(buttons[0]);
  });
});

/**
 * Moving redraws the list with the rows in a new order, and the button that was pressed can
 * be refused in its new place - a message moved to the front has nothing above it - so the
 * keyboard was dropped on the floor.
 */
describe('after a queued message is moved', () => {
  function Harness() {
    const [order, setOrder] = useState([message('a', 'first'), message('b', 'second'), message('c', 'third')]);
    return (
      <Queue
        items={order}
        onRemove={() => {}}
        onEdit={() => {}}
        onSendNow={() => {}}
        onMove={(id, to) => {
          setOrder((was) => {
            const from = was.findIndex((item) => item.id === id);
            const left = was.filter((item) => item.id !== id);
            left.splice(to, 0, was[from]!);
            return left;
          });
        }}
      />
    );
  }

  const rows = () => [...document.querySelectorAll('.queue-item')] as HTMLElement[];
  const way = (row: HTMLElement, which: 'up' | 'down') =>
    row.querySelector<HTMLElement>(`[data-way="${which}"]`)!;

  it('keeps the keyboard on the message, on the button that moved it', () => {
    render(<Harness />);
    way(rows()[2]!, 'up').focus();

    fireEvent.click(document.activeElement!);

    expect(rows()[1]!.textContent, 'the third message is now second').toContain('third');
    expect(document.activeElement).toBe(way(rows()[1]!, 'up'));
  });

  /** At either end one of the two is refused, and the keyboard still has to land somewhere. */
  it('lands on the other button when the one it used is now refused', () => {
    render(<Harness />);
    way(rows()[1]!, 'up').focus();

    fireEvent.click(document.activeElement!);

    expect(rows()[0]!.textContent, 'the second message is now first').toContain('second');
    expect(way(rows()[0]!, 'up').hasAttribute('disabled'), 'nothing above the front').toBe(true);
    expect(document.activeElement).toBe(way(rows()[0]!, 'down'));
  });

  it('leaves the keyboard alone when nothing was moved', () => {
    render(<Harness />);
    const sendNow = rows()[0]!.querySelector('button')!;
    sendNow.focus();

    expect(document.activeElement).toBe(sendNow);
  });
});
