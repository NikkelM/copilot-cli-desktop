// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { PendingElicitation } from '../../shared/protocol';
import { ElicitationPrompt } from './ElicitationPrompt';

const question: PendingElicitation = {
  sessionId: 's1',
  requestId: 'r1',
  kind: 'input',
  message: 'Which database do you prefer?',
  schema: null,
  choices: ['PostgreSQL', 'MySQL', 'SQLite'],
  mode: null,
  url: null,
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

  // Typing is a new answer rather than a return to the box, so it starts over.
  it('replaces the text when typing starts again from the list', async () => {
    const { user } = ask();

    await user.keyboard('MariaDB');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('X');

    expect(freeform().value).toBe('X');
  });

  it('leaves the answer empty when nothing was ever typed', async () => {
    const { user } = ask();

    await user.click(freeform());
    expect(freeform().value).toBe('');
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveProperty('disabled', true);
  });
});
