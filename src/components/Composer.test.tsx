// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Composer } from './Composer';

function show(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn();
  const view = render(
    <Composer disabled={false} busy={false} focusOn="s1" onSend={onSend} onAbort={() => {}} {...props} />,
  );
  return { onSend, view, user: userEvent.setup() };
}

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('Composer', () => {
  it('is ready to type in as soon as a session is chosen', () => {
    show();
    expect(document.activeElement).toBe(box());
  });

  it('takes focus again when a different session is chosen', () => {
    const { view } = show({ focusOn: 's1' });
    box().blur();
    expect(document.activeElement).not.toBe(box());

    view.rerender(
      <Composer disabled={false} busy={false} focusOn="s2" onSend={() => {}} onAbort={() => {}} />,
    );
    expect(document.activeElement).toBe(box());
  });

  // The agent is blocked on its own prompt, which has the better claim on the keyboard.
  it('leaves the keyboard alone while the agent is waiting on an answer', () => {
    show({ focusOn: null });
    expect(document.activeElement).not.toBe(box());
  });

  it('sends on Enter and clears', async () => {
    const { onSend, user } = show();

    await user.keyboard('hello{Enter}');

    expect(onSend).toHaveBeenCalledWith('hello');
    expect(box().value).toBe('');
  });

  it('keeps Shift+Enter for a newline', async () => {
    const { onSend, user } = show();

    await user.keyboard('one{Shift>}{Enter}{/Shift}two');

    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe('one\ntwo');
  });

  it('will not send nothing', async () => {
    const { onSend, user } = show();

    await user.keyboard('   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });
});
