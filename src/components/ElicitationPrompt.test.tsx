// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { PendingElicitation } from '../../shared/protocol';
import { ElicitationPrompt } from './ElicitationPrompt';
import { useShortcuts } from '../lib/useShortcuts';

const question: PendingElicitation = {
  sessionId: 's1',
  requestId: 'r1',
  kind: 'input',
  message: 'Which database do you prefer?',
  schema: null,
  choices: ['PostgreSQL', 'MySQL', 'SQLite'],
  mode: null,
  url: null,
  expiresAt: '2026-01-01T00:05:00.000Z',
};

function ask() {
  const onResolve = vi.fn();
  render(<ElicitationPrompt pending={question} onResolve={onResolve} />);
  return { onResolve, user: userEvent.setup() };
}

const radios = () => screen.getAllByRole('radio') as HTMLInputElement[];
const freeform = () => screen.getByPlaceholderText('or type your own') as HTMLInputElement;
const chosen = () => radios().findIndex((radio) => radio.checked);

describe('ElicitationPrompt keyboard use', () => {
  // The first choice is preselected, matching the CLI, so a question can be answered
  // with a single keystroke.
  it('answers without the mouse', async () => {
    const { onResolve, user } = ask();

    expect(chosen()).toBe(0);
    await user.keyboard('{Enter}');

    expect(onResolve).toHaveBeenCalledWith('accept', { answer: 'PostgreSQL' });
  });

  it('moves with the arrows and with w and s', async () => {
    const { user } = ask();

    await user.keyboard('{ArrowDown}');
    expect(chosen()).toBe(1);

    await user.keyboard('s');
    expect(chosen()).toBe(2);

    await user.keyboard('w');
    expect(chosen()).toBe(1);

    await user.keyboard('{ArrowUp}');
    expect(chosen()).toBe(0);
  });

  // The freeform box is the one entry that cannot be reached by picking, so both ends
  // of the list lead into it rather than wrapping straight past.
  it('lands in the text box when moving off either end', async () => {
    const { user } = ask();

    // Up from the first choice.
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(freeform());
    expect(chosen()).toBe(-1);

    // And down past the last.
    await user.keyboard('{ArrowDown}');
    expect(chosen()).toBe(0);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(freeform());
    expect(chosen()).toBe(-1);
  });

  it('starts typing an unlisted answer without a keystroke to get there', async () => {
    const { onResolve, user } = ask();

    await user.keyboard('Maria');
    expect(document.activeElement).toBe(freeform());
    expect(freeform().value).toBe('Maria');

    await user.keyboard('DB{Enter}');
    expect(onResolve).toHaveBeenCalledWith('accept', { answer: 'MariaDB' });
  });

  // w and s only navigate outside the box, or an unlisted answer could not contain them.
  it('treats w and s as text once inside the box', async () => {
    const { user } = ask();

    await user.click(freeform());
    await user.keyboard('sw');
    expect(freeform().value).toBe('sw');
    expect(chosen()).toBe(-1);
  });

  // Reaching the box makes it the answer wherever the focus came from, so the choice
  // must clear on a click just as it does when arrowed into.
  it('drops the selected choice when the box is clicked into', async () => {
    const { user } = ask();

    expect(chosen()).toBe(0);
    await user.click(freeform());
    expect(chosen()).toBe(-1);
  });

  it('will not submit a choice the cursor has already left', async () => {
    const { onResolve, user } = ask();

    await user.click(freeform());
    await user.keyboard('{Enter}');

    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveProperty('disabled', true);
  });

  it('resumes from the box, not from the choice that was selected before it', async () => {
    const { user } = ask();

    await user.click(freeform());
    // Down from the box is the first choice; without clearing it would have been the second.
    await user.keyboard('{ArrowDown}');
    expect(chosen()).toBe(0);
  });

  it('still escapes the box with the arrows', async () => {
    const { user } = ask();

    await user.click(freeform());
    await user.keyboard('x');
    expect(freeform().value).toBe('x');

    await user.keyboard('{ArrowDown}');
    expect(chosen()).toBe(0);
    expect(document.activeElement).not.toBe(freeform());
  });

  it('declines without sending an answer', async () => {
    const { onResolve, user } = ask();

    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onResolve).toHaveBeenCalledWith('decline');
  });

  // Cancel meant the same as Decline for every question the CLI actually asks.
  it('offers one way to refuse rather than two', () => {
    ask();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  // A radio is an HTMLInputElement, so treating any focused input as a text box left the
  // list deaf to everything but the arrows after a choice was clicked.
  it('still takes keys after a choice is clicked rather than arrowed to', async () => {
    const { user } = ask();

    await user.click(radios()[1] as HTMLInputElement);
    expect(chosen()).toBe(1);

    await user.keyboard('s');
    expect(chosen()).toBe(2);

    await user.keyboard('w');
    expect(chosen()).toBe(1);
  });

  it('types from a clicked choice into the box', async () => {
    const { user } = ask();

    await user.click(radios()[0] as HTMLInputElement);
    await user.keyboard('Maria');

    expect(document.activeElement).toBe(freeform());
    expect(freeform().value).toBe('Maria');
  });
});

// Typing an answer and then looking back at the options should not cost the typing.
describe('ElicitationPrompt keeps typed text', () => {
  it('holds the text while an option is picked, and answers with the option', async () => {
    const { onResolve, user } = ask();

    await user.keyboard('MariaDB');
    await user.click(radios()[2] as HTMLInputElement);

    expect(freeform().value).toBe('MariaDB');
    await user.keyboard('{Enter}');
    expect(onResolve).toHaveBeenCalledWith('accept', { answer: 'SQLite' });
  });

  it('gives the text back when the box is arrowed into again', async () => {
    const { onResolve, user } = ask();

    await user.keyboard('MariaDB');
    // Out to a choice and straight back.
    await user.keyboard('{ArrowDown}');
    expect(chosen()).toBe(0);

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(freeform());
    expect(freeform().value).toBe('MariaDB');

    await user.keyboard('{Enter}');
    expect(onResolve).toHaveBeenCalledWith('accept', { answer: 'MariaDB' });
  });

  it('gives the text back when the box is clicked into again', async () => {
    const { onResolve, user } = ask();

    await user.keyboard('MariaDB');
    await user.click(radios()[1] as HTMLInputElement);
    await user.click(freeform());

    expect(chosen()).toBe(-1);
    await user.keyboard('{Enter}');
    expect(onResolve).toHaveBeenCalledWith('accept', { answer: 'MariaDB' });
  });

  // Typing carries on from what is already there, so checking the options mid-answer
  // does not cost the words already written.
  it('continues the text when typing starts again from the list', async () => {
    const { onResolve, user } = ask();

    await user.keyboard('MariaDB');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('Test');

    expect(freeform().value).toBe('MariaDBTest');
    await user.keyboard('{Enter}');
    expect(onResolve).toHaveBeenCalledWith('accept', { answer: 'MariaDBTest' });
  });

  it('leaves the answer empty when nothing was ever typed', async () => {
    const { user } = ask();

    await user.click(freeform());
    expect(freeform().value).toBe('');
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveProperty('disabled', true);
  });
});

/**
 * The questions worth asking come with a table of numbers or a list of what each answer
 * costs, which is what the terminal lays out. Drawn as one span, the newlines collapsed
 * into a run-on line and the table arrived as a row of pipes.
 */
describe('a question written as markdown', () => {
  const rich: PendingElicitation = {
    ...question,
    message:
      'Proposed rework:\n\n- **Tartarus:** durability unchanged\n\n| Biome | Slot 1 |\n|---|---|\n| Styx | 0.14 |\n\nHow should I apply it?',
  };

  it('lays the question out the way it was written', () => {
    const { container } = render(<ElicitationPrompt pending={rich} onResolve={vi.fn()} />);
    const message = container.querySelector('.elicitation-message');

    expect(message?.querySelector('table td')?.textContent).toBe('Styx');
    expect(message?.querySelector('li strong')?.textContent).toBe('Tartarus:');
    expect(screen.getByText('How should I apply it?')).toBeTruthy();
  });
});
/**
 * A question with nothing to choose from is answered by typing, so the field is where the
 * keyboard belongs.
 *
 * The container holds it while there are choices for the arrows to walk. With none it only
 * stands between the reader and the box, and it is not a field - so a question mark pressed
 * there reached the window, which reads one as a request for the shortcut list.
 */
describe('a question with nothing to choose from', () => {
  const open: PendingElicitation = { ...question, choices: [] };

  it('puts the keyboard in the field rather than on the prompt', () => {
    render(<ElicitationPrompt pending={open} onResolve={vi.fn()} />);

    expect((document.activeElement as HTMLElement)?.tagName).toBe('INPUT');
  });

  it('leaves a question mark to the field', async () => {
    const on = vi.fn();
    renderHook(() => useShortcuts(on, () => ''));
    render(<ElicitationPrompt pending={open} onResolve={vi.fn()} />);

    await userEvent.keyboard('?');

    expect(on).not.toHaveBeenCalled();
  });

  /** The choices are what the container is for, so with some it keeps the keyboard. */
  it('keeps the keyboard on the prompt while there are choices to walk', () => {
    render(<ElicitationPrompt pending={question} onResolve={vi.fn()} />);

    expect((document.activeElement as HTMLElement)?.classList.contains('elicitation')).toBe(true);
  });
});