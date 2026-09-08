// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { Composer } from './Composer';
import type { SlashCommand } from '../../shared/protocol';

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;

/** Stands in for the app, which keeps a draft per session. */
function Host({ session, onSend }: { session: string; onSend: (prompt: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <Composer
      disabled={false}
      busy={false}
      resuming={false}
      attached={[]}
      onAttach={() => {}}
      onError={() => {}}
      focusOn={session}
      value={drafts[session] ?? ''}
      onChange={(text) => setDrafts((current) => ({ ...current, [session]: text }))}
      onSend={(prompt) => {
        setDrafts((current) => ({ ...current, [session]: '' }));
        onSend(prompt);
      }}
      onAbort={() => {}}
      commands={[]}
      onCommandsNeeded={() => {}}
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
      resuming={false}
      attached={[]}
      onAttach={() => {}}
      onError={() => {}}
      focusOn="s1"
      value=""
      onChange={() => {}}
      onSend={onSend}
      onAbort={() => {}}
      commands={[]}
      onCommandsNeeded={() => {}}
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
      resuming={false}
      attached={[]}
      onAttach={() => {}}
      onError={() => {}}
        focusOn="s2"
        value=""
        onChange={() => {}}
        onSend={() => {}}
        onAbort={() => {}}
        commands={[]}
        onCommandsNeeded={() => {}}
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

/**
 * The command menu, which is how a slash command is found at all.
 *
 * Modelled on the CLI: the list opens above the composer as soon as a slash is typed, and
 * narrows as more of the name is. Tab finishes the word, Enter finishes it and acts.
 */
describe('the slash command menu', () => {
  const COMMANDS: SlashCommand[] = [
    { name: 'usage', description: 'What this session has cost', aliases: [], allowDuringTurn: true },
    {
      name: 'model',
      description: 'Change the model',
      aliases: ['models'],
      hint: 'model',
      allowDuringTurn: true,
    },
    {
      name: 'allow-all',
      description: 'Approve everything',
      aliases: ['yolo'],
      hint: '[on|off]',
      choices: [
        { name: 'on', description: 'Turn it on' },
        { name: 'off', description: 'Turn it off' },
      ],
      allowDuringTurn: true,
    },
  ];

  function menu(props: Record<string, unknown> = {}) {
    const onSend = vi.fn();
    function Wrapper() {
      const [value, setValue] = useState('');
      return (
        <Composer
          disabled={false}
          busy={false}
          resuming={false}
          attached={[]}
          onAttach={() => {}}
          onError={() => {}}
          focusOn="s1"
          value={value}
          onChange={setValue}
          onSend={onSend}
          onAbort={() => {}}
          commands={COMMANDS}
          onCommandsNeeded={() => {}}
          {...props}
        />
      );
    }
    render(<Wrapper />);
    return { onSend, user: userEvent.setup() };
  }

  const rows = () => screen.queryAllByRole('option').map((row) => row.textContent);

  it('opens on a slash, offering everything', async () => {
    const { user } = menu();
    await user.keyboard('/');
    expect(rows()).toHaveLength(COMMANDS.length);
  });

  it('narrows as the name is typed', async () => {
    const { user } = menu();
    await user.keyboard('/mod');
    expect(rows()!.some((row) => row?.includes('/model'))).toBe(true);
    expect(rows()).toHaveLength(1);
  });

  it('stays shut for ordinary text', async () => {
    const { user } = menu();
    await user.keyboard('what does /model do');
    expect(rows()).toHaveLength(0);
  });

  // Sent as the text it is: the point of matching on the name is that a path matches none.
  it('stays shut for a path', async () => {
    const { onSend, user } = menu();
    await user.keyboard('/usr/bin/env{Enter}');
    expect(rows()).toHaveLength(0);
    expect(onSend).toHaveBeenCalledWith('/usr/bin/env');
  });

  it('says what a command takes, so the argument is not a guess', async () => {
    const { user } = menu();
    await user.keyboard('/mod');
    expect(rows()[0]).toContain('/model <model>');
  });

  it('completes on Tab without sending', async () => {
    const { onSend, user } = menu();
    await user.keyboard('/us{Tab}');

    expect(box().value).toBe('/usage');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('leaves the cursor past a space for a command that takes an argument', async () => {
    const { user } = menu();
    await user.keyboard('/mod{Tab}');
    expect(box().value).toBe('/model ');
  });

  it('runs a complete command on Enter', async () => {
    const { onSend, user } = menu();
    await user.keyboard('/us{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('/usage');
  });

  // Sending it half-written would only earn a refusal, and the argument would have to be
  // typed all over again.
  it('does not send a command still missing its argument', async () => {
    const { onSend, user } = menu();
    await user.keyboard('/mod{Enter}');

    expect(box().value).toBe('/model ');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('offers the values an argument accepts', async () => {
    const { user } = menu();
    await user.keyboard('/allow-all ');
    expect(rows()).toEqual(['on' + 'Turn it on', 'off' + 'Turn it off']);
  });

  it('sends the chosen value with the command', async () => {
    const { onSend, user } = menu();
    await user.keyboard('/allow-all o{ArrowDown}{Enter}');
    expect(onSend).toHaveBeenCalledWith('/allow-all off');
  });

  it('closes on Escape and leaves what was typed alone', async () => {
    const { user } = menu();
    await user.keyboard('/mod{Escape}');

    expect(rows()).toHaveLength(0);
    expect(box().value).toBe('/mod');
  });

  it('opens again once a different command is started', async () => {
    const { user } = menu();
    await user.keyboard('/mod{Escape}e');
    expect(rows()).toHaveLength(1);
  });
});

/**
 * Waking a cold session is the one action that genuinely costs something - up to five and
 * a half seconds - and the app used to say so in a grey line at the top of the pane, far
 * from where the reader was looking.
 */
describe('while a cold session wakes', () => {
  const composer = (props: Record<string, unknown> = {}) =>
    render(
      <Composer
        disabled={false}
        busy={false}
        resuming={true}
        attached={[]}
        onAttach={() => {}}
        onError={() => {}}
        focusOn="s1"
        value="hello"
        onChange={() => {}}
        onSend={() => {}}
        onAbort={() => {}}
        commands={[]}
        onCommandsNeeded={() => {}}
        {...props}
      />,
    );

  it('says what is happening, beside the button that was pressed', () => {
    composer();
    expect(screen.getByText('Waking this session up')).toBeTruthy();
  });

  // A second send would look like the fix for a button that appears to have done nothing.
  it('refuses a second send', async () => {
    const onSend = vi.fn();
    composer({ onSend });

    await userEvent.click(screen.getByRole('button', { name: /Waking/ }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it('refuses one from the keyboard too', async () => {
    const onSend = vi.fn();
    composer({ onSend });

    await userEvent.type(screen.getByRole('textbox'), '{Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('says nothing once the session is awake', () => {
    composer({ resuming: false });
    expect(screen.queryByText('Waking this session up')).toBeNull();
  });
});

/**
 * Waking takes seconds. A reader who moves to another session in the meantime was being
 * told that one was waking, and having their Enter refused for it.
 */
describe('the waking state belongs to one session', () => {
  it('says nothing in a session that is not the one waking', () => {
    render(
      <Composer
        disabled={false}
        busy={false}
        resuming={false}
        attached={[]}
        onAttach={() => {}}
        onError={() => {}}
        focusOn="s2"
        value="hello"
        onChange={() => {}}
        onSend={() => {}}
        onAbort={() => {}}
        commands={[]}
        onCommandsNeeded={() => {}}
      />,
    );

    expect(screen.queryByText('Waking this session up')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});
