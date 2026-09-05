// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { Composer } from './Composer';

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;

/** Stands in for the app, which keeps a draft per session. */
function Host({ session, onSend }: { session: string; onSend: (prompt: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <Composer
      disabled={false}
      busy={false}
      focusOn={session}
      value={drafts[session] ?? ''}
      onChange={(text) => setDrafts((current) => ({ ...current, [session]: text }))}
      onSend={(prompt) => {
        setDrafts((current) => ({ ...current, [session]: '' }));
        onSend(prompt);
      }}
      onAbort={() => {}}
    />
  );
}

function hosted(session = 'a') {
  const onSend = vi.fn();
  const view = render(<Host session={session} onSend={onSend} />);
  return { onSend, view, user: userEvent.setup() };
}

function bare(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn();
  const view = render(
    <Composer
      disabled={false}
      busy={false}
      focusOn="s1"
      value=""
      onChange={() => {}}
      onSend={onSend}
      onAbort={() => {}}
      {...props}
    />,
  );
  return { onSend, view, user: userEvent.setup() };
}

describe('Composer', () => {
  it('is ready to type in as soon as a session is chosen', () => {
    bare();
    expect(document.activeElement).toBe(box());
  });

  it('takes focus again when a different session is chosen', () => {
    const { view } = bare({ focusOn: 's1' });
    box().blur();

    view.rerender(
      <Composer
        disabled={false}
        busy={false}
        focusOn="s2"
        value=""
        onChange={() => {}}
        onSend={() => {}}
        onAbort={() => {}}
      />,
    );
    expect(document.activeElement).toBe(box());
  });

  // The agent is blocked on its own prompt, which has the better claim on the keyboard.
  it('leaves the keyboard alone while the agent is waiting on an answer', () => {
    bare({ focusOn: null });
    expect(document.activeElement).not.toBe(box());
  });

  it('sends on Enter and clears', async () => {
    const { onSend, user } = hosted();

    await user.keyboard('hello{Enter}');

    expect(onSend).toHaveBeenCalledWith('hello');
    expect(box().value).toBe('');
  });

  it('keeps Shift+Enter for a newline', async () => {
    const { onSend, user } = hosted();

    await user.keyboard('one{Shift>}{Enter}{/Shift}two');

    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe('one\ntwo');
  });

  it('will not send nothing', async () => {
    const { onSend, user } = hosted();

    await user.keyboard('   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  /**
   * The bug behind #83. The text used to live in the composer, which is not remounted
   * when the session changes, so it followed the reader across and Enter sent it to
   * whichever session they had opened.
   */
  it('does not carry unsent text into another session', async () => {
    const { view, user } = hosted('a');
    await user.keyboard('meant for a');

    view.rerender(<Host session="b" onSend={() => {}} />);
    expect(box().value).toBe('');
  });

  it('gives the text back on returning to the session it was written for', async () => {
    const { view, user } = hosted('a');
    await user.keyboard('meant for a');

    view.rerender(<Host session="b" onSend={() => {}} />);
    await user.keyboard('meant for b');
    expect(box().value).toBe('meant for b');

    view.rerender(<Host session="a" onSend={() => {}} />);
    expect(box().value).toBe('meant for a');
  });
});
