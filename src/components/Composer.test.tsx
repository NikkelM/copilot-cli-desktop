// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { Composer } from './Composer';
import type { SlashCommand } from '../../shared/protocol';

const { listDirectories } = vi.hoisted(() => ({ listDirectories: vi.fn() }));

vi.mock('../lib/sidecar', () => ({
  listDirectories: (cwd: string | undefined, path: string) => listDirectories(cwd, path),
}));

beforeEach(() => {
  listDirectories.mockReset().mockResolvedValue({
    entries: [],
    separator: '\\',
    caseSensitive: false,
  });
});

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;

/** Stands in for the app, which keeps a draft per session. */
function Host({
  session,
  onSend,
  history = [],
  stashed = false,
}: {
  session: string;
  onSend: (prompt: string) => void;
  history?: string[];
  stashed?: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <Composer
      disabled={false}
      busy={false}
      busySince={null}
      resuming={false}
      attached={[]}
      onAttach={() => {}}
      onPasteFiles={() => {}}
      stashed={stashed}
      onError={() => {}}
      focusOn={session}
      value={drafts[session] ?? ''}
      onChange={(text) => setDrafts((current) => ({ ...current, [session]: text }))}
      onSend={(prompt) => {
        setDrafts((current) => ({ ...current, [session]: '' }));
        onSend(prompt);
      }}
      onAbort={() => {}}
      history={history}
      commands={[]}
      cwd={'C:\\repo'}
      onCommandsNeeded={() => {}}
      mode="interactive"
      onCycleMode={() => {}}
      intent={null}
    />
  );
}

function hosted(session = 'a', history?: string[]) {
  const onSend = vi.fn();
  const view = render(<Host session={session} onSend={onSend} history={history} />);
  return { onSend, view, user: userEvent.setup() };
}

function bare(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn();
  const view = render(
    <Composer
      disabled={false}
      busy={false}
      busySince={null}
      resuming={false}
      attached={[]}
      onAttach={() => {}}
      onPasteFiles={() => {}}
      stashed={false}
      onError={() => {}}
      focusOn="s1"
      value=""
      onChange={() => {}}
      onSend={onSend}
      onAbort={() => {}}
      history={[]}
      commands={[]}
      cwd={'C:\\repo'}
      onCommandsNeeded={() => {}}
      mode="interactive"
      onCycleMode={() => {}}
      intent={null}
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
        busySince={null}
      resuming={false}
      attached={[]}
      onAttach={() => {}}
      onPasteFiles={() => {}}
      stashed={false}
      onError={() => {}}
        focusOn="s2"
        value=""
        onChange={() => {}}
        onSend={() => {}}
        onAbort={() => {}}
        history={[]}
        commands={[]}
        cwd={'C:\\repo'}
        onCommandsNeeded={() => {}}
      mode="interactive"
      onCycleMode={() => {}}
      intent={null}
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
    {
      name: 'cwd',
      description: 'Change the working directory',
      aliases: ['cd'],
      hint: 'directory',
      completion: 'directory',
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
          busySince={null}
          resuming={false}
          attached={[]}
          onAttach={() => {}}
          onPasteFiles={() => {}}
          stashed={false}
          onError={() => {}}
          focusOn="s1"
          value={value}
          onChange={setValue}
          onSend={onSend}
          onAbort={() => {}}
          history={[]}
          commands={COMMANDS}
          cwd={'C:\\repo'}
          onCommandsNeeded={() => {}}
      mode="interactive"
      onCycleMode={() => {}}
      intent={null}
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

  it('shows folders below the session working directory', async () => {
    listDirectories.mockResolvedValue({
      entries: ['src', 'tests'],
      separator: '\\',
      caseSensitive: false,
    });
    const { user } = menu();

    await user.keyboard('/cwd ');

    await waitFor(() => expect(rows()).toContain('src\\' + 'directory'));
    expect(rows()).toContain('tests\\' + 'directory');
    expect(listDirectories).toHaveBeenCalledWith('C:\\repo', '');
  });

  it('filters folders as a relative path is typed without reading the directory again', async () => {
    listDirectories.mockResolvedValue({
      entries: ['Source', 'src', 'tests'],
      separator: '\\',
      caseSensitive: false,
    });
    const { user } = menu();

    await user.keyboard('/cwd s');
    await waitFor(() => expect(rows()).toEqual(['Source\\' + 'directory', 'src\\' + 'directory']));
    await user.keyboard('r');

    expect(rows()).toEqual(['src\\' + 'directory']);
    expect(listDirectories).toHaveBeenCalledTimes(1);
  });

  it('drills into the selected folder with Tab', async () => {
    listDirectories
      .mockResolvedValueOnce({
        entries: ['src'],
        separator: '\\',
        caseSensitive: false,
      })
      .mockResolvedValueOnce({
        entries: ['components'],
        separator: '\\',
        caseSensitive: false,
      });
    const { onSend, user } = menu();

    await user.keyboard('/cwd s');
    await waitFor(() => expect(rows()).toEqual(['src\\' + 'directory']));
    await user.keyboard('{Tab}');

    expect(box().value).toBe('/cwd src\\');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(rows()).toEqual(['components\\' + 'directory']));
    expect(listDirectories).toHaveBeenNthCalledWith(2, 'C:\\repo', 'src\\');
  });

  it('runs the command with the selected folder on Enter', async () => {
    listDirectories.mockResolvedValue({
      entries: ['src'],
      separator: '\\',
      caseSensitive: false,
    });
    const { onSend, user } = menu();

    await user.keyboard('/cwd s');
    await waitFor(() => expect(rows()).toEqual(['src\\' + 'directory']));
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('/cwd src');
  });

  it('completes directories through the cwd alias too', async () => {
    listDirectories.mockResolvedValue({
      entries: ['src'],
      separator: '\\',
      caseSensitive: false,
    });
    const { user } = menu();

    await user.keyboard('/cd s');
    await waitFor(() => expect(rows()).toEqual(['src\\' + 'directory']));
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
        busySince={null}
        resuming={true}
        attached={[]}
        onAttach={() => {}}
        onPasteFiles={() => {}}
        stashed={false}
        onError={() => {}}
        focusOn="s1"
        value="hello"
        onChange={() => {}}
        onSend={() => {}}
        onAbort={() => {}}
        history={[]}
        commands={[]}
        cwd={'C:\\repo'}
        onCommandsNeeded={() => {}}
      mode="interactive"
      onCycleMode={() => {}}
      intent={null}
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

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

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
        busySince={null}
        resuming={false}
        attached={[]}
        onAttach={() => {}}
        onPasteFiles={() => {}}
        stashed={false}
        onError={() => {}}
        focusOn="s2"
        value="hello"
        onChange={() => {}}
        onSend={() => {}}
        onAbort={() => {}}
        history={[]}
        commands={[]}
        cwd={'C:\\repo'}
        onCommandsNeeded={() => {}}
      mode="interactive"
      onCycleMode={() => {}}
      intent={null}
      />,
    );

    expect(screen.queryByText('Waking this session up')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});

/**
 * The buttons live in the box rather than in a row under it (#148), so the composer is the
 * last thing in the pane. Icons say nothing on their own, so every one of them is named.
 */
describe('the buttons in the box', () => {
  it('names each one, since none of them carries text', () => {
    bare({ value: 'hello' });

    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  /**
   * Both, not one or the other. Send stays live so a message typed during a turn goes on
   * the queue rather than being refused, and it says so rather than still reading "Send".
   */
  it('offers both stopping and queueing while the agent works', () => {
    bare({ busy: true, value: 'next thing' });

    expect(screen.getByRole('button', { name: 'Stop this turn' })).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Queue this behind the turn' });
    expect(send).toHaveProperty('disabled', false);
  });

  it('offers nothing to stop when nothing is running', () => {
    bare({ value: 'hello' });
    expect(screen.queryByRole('button', { name: 'Stop this turn' })).toBeNull();
  });

  it('will not send an empty message', () => {
    bare({ value: '   ' });
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
  });

  it('will not send while the session is still waking', () => {
    bare({ resuming: true, value: 'hello' });
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
  });

  it('draws the chips above the box, so several files grow it upwards', () => {
    const { view } = bare({
      attached: [{ type: 'file', path: '/tmp/a.png', displayName: 'a.png' }],
    });

    const chips = view.container.querySelector('.attachments');
    const input = view.container.querySelector('.composer-input');
    expect(chips).not.toBeNull();
    expect(input).not.toBeNull();
    // Node.DOCUMENT_POSITION_FOLLOWING: the box comes after the chips.
    expect(chips!.compareDocumentPosition(input!) & 4).toBeTruthy();
  });
});

/**
 * Up and down reach for what was already sent, but only once the caret has nowhere left to
 * go: a multi-line message has to stay editable with the same keys (#135).
 */
describe('stepping back through what was sent', () => {
  it('puts the last prompt in the box', async () => {
    const { user } = hosted('a', ['second', 'first']);

    await user.keyboard('{ArrowUp}');
    expect(box().value).toBe('second');
  });

  it('keeps going back, and stops at the oldest', async () => {
    const { user } = hosted('a', ['second', 'first']);

    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(box().value).toBe('first');
  });

  it('gives back what was being written when the walk started', async () => {
    const { user } = hosted('a', ['second', 'first']);

    await user.type(box(), 'half a thought');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(box().value).toBe('first');

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(box().value).toBe('half a thought');
  });

  it('leaves the arrows alone inside a message that spans lines', async () => {
    const { user } = hosted('a', ['old']);

    await user.type(box(), 'one{Shift>}{Enter}{/Shift}two');
    // The caret is on the second line, so up belongs to the text.
    await user.keyboard('{ArrowUp}');
    expect(box().value).toBe('one\ntwo');
  });

  it('does nothing when there is nothing to go back to', async () => {
    const { user } = hosted('a', []);

    await user.type(box(), 'draft');
    await user.keyboard('{ArrowUp}');
    expect(box().value).toBe('draft');
  });

  it('stops browsing once the recalled prompt is edited', async () => {
    const { user } = hosted('a', ['second', 'first']);

    await user.keyboard('{ArrowUp}');
    await user.type(box(), '!');
    // Down would restore the draft if the walk were still live; it is a fresh message now.
    await user.keyboard('{ArrowDown}');
    expect(box().value).toBe('second!');
  });
});

/** What readline gives and a textarea does not (#135). */
describe('deleting to the start or end of a line', () => {
  it('cuts back to the start of the line with ctrl+u', async () => {
    const { user } = hosted();

    await user.type(box(), 'one{Shift>}{Enter}{/Shift}two');
    await user.keyboard('{Control>}u{/Control}');
    expect(box().value).toBe('one\n');
  });

  it('cuts forward to the end of the line with ctrl+k', async () => {
    const { user } = hosted();

    await user.type(box(), 'keep this');
    box().setSelectionRange(4, 4);
    await user.keyboard('{Control>}k{/Control}');
    expect(box().value).toBe('keep');
  });

  it('leaves the rest of the message alone', async () => {
    const { user } = hosted();

    await user.type(box(), 'first{Shift>}{Enter}{/Shift}second');
    box().setSelectionRange(9, 9);
    await user.keyboard('{Control>}k{/Control}');
    expect(box().value).toBe('first\nsec');
  });
});



/**
 * How long the turn has been going, next to the button that stops it (#70). Long work
 * otherwise gives no sign of whether it is progressing or hung.
 */
describe('the clock on a running turn', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('says how long the agent has been working', () => {
    bare({ busy: true, busySince: ago(95_000) });
    expect(screen.getByText('1m 35s')).toBeTruthy();
  });

  it('says nothing when nothing is running', () => {
    bare({ busy: false, busySince: ago(95_000) });
    expect(screen.queryByText('1m 35s')).toBeNull();
  });

  /** A turn that has just started needs no clock; it would appear, say "1s", and go. */
  it('waits until the wait is worth mentioning', () => {
    bare({ busy: true, busySince: ago(500) });
    expect(screen.queryByText(/\ds/)).toBeNull();
  });
});

/**
 * The `!` prefix, which the CLI treats as a mode rather than a one-shot marker. It is kept
 * in the draft rather than beside it, so switching sessions cannot return the text without
 * the mode and send a command line to the agent (#134).
 */
describe('Composer, shell mode', () => {
  it('takes the marker out of the box and shows the mode instead', async () => {
    const { user } = hosted();

    await user.type(box(), '!');
    expect(box().value).toBe('');
    expect(screen.getByText('shell')).toBeTruthy();
  });

  it('says nothing about a mode that is not on', () => {
    hosted();
    expect(screen.queryByText('shell')).toBeNull();
  });

  it('sends the command with its marker, so the app can tell it apart', async () => {
    const { onSend, user } = hosted();

    await user.type(box(), '!git status{Enter}');
    expect(onSend).toHaveBeenCalledWith('!git status');
  });

  it('does not send a marker on its own', async () => {
    const { onSend, user } = hosted();

    await user.type(box(), '!{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('leaves the mode on Escape and keeps what was typed', async () => {
    const { user } = hosted();

    await user.type(box(), '!git status');
    await user.keyboard('{Escape}');

    expect(screen.queryByText('shell')).toBeNull();
    expect(box().value).toBe('git status');
  });

  /** The marker is not in the box, so the key that would delete it has to be answered. */
  it('leaves the mode on backspace at the start', async () => {
    const { user } = hosted();

    await user.type(box(), '!');
    await user.keyboard('{Backspace}');

    expect(screen.queryByText('shell')).toBeNull();
    expect(box().value).toBe('');
  });

  it('keeps the mode when backspacing over the command itself', async () => {
    const { user } = hosted();

    await user.type(box(), '!ls');
    await user.keyboard('{Backspace}');

    expect(screen.getByText('shell')).toBeTruthy();
    expect(box().value).toBe('l');
  });

  /** A shell command is not a prompt, so the prompts already sent are not what Up offers. */
  it('offers no prompt history in shell mode', async () => {
    const { user } = hosted('a', ['a previous prompt']);

    await user.type(box(), '!');
    await user.keyboard('{ArrowUp}');

    expect(box().value).toBe('');
  });

  it('cuts to the start of the line without eating the marker', async () => {
    const { user } = hosted();

    await user.type(box(), '!git status');
    await user.keyboard('{Control>}u{/Control}');

    expect(screen.getByText('shell')).toBeTruthy();
    expect(box().value).toBe('');
  });

  it('calls the send button what it will do', async () => {
    const { user } = hosted();

    await user.type(box(), '!ls');
    expect(screen.getByRole('button', { name: 'Run in the shell' })).toBeTruthy();
  });

  /** A shell command is not the agent's work, so it does not wait behind it. */
  it('offers to run rather than to queue while the agent works', () => {
    bare({ busy: true, value: '!ls' });
    expect(screen.getByRole('button', { name: 'Run in the shell' })).toBeTruthy();
  });
});

describe('pasting into the box', () => {
  /** React reads clipboardData off the native event, so the shape is what matters here. */
  const paste = (files: File[], text = '') =>
    fireEvent.paste(box(), { clipboardData: { files, getData: () => text } });

  it('hands pasted files up rather than dropping them', () => {
    const onPasteFiles = vi.fn();
    bare({ onPasteFiles });
    const shot = new File(['pixels'], 'image.png');

    paste([shot]);

    expect(onPasteFiles).toHaveBeenCalledWith([shot]);
  });

  it('leaves a text paste to the box, which is what pasting usually means', () => {
    const onPasteFiles = vi.fn();
    bare({ onPasteFiles });

    const event = paste([], 'some text');

    expect(onPasteFiles).not.toHaveBeenCalled();
    // Not prevented, so the browser puts the text in at the caret as it always has.
    expect(event).toBe(true);
  });

  it('takes every file in one paste', () => {
    const onPasteFiles = vi.fn();
    bare({ onPasteFiles });

    paste([new File(['a'], 'a.png'), new File(['b'], 'b.png')]);

    expect(onPasteFiles.mock.calls[0]?.[0]).toHaveLength(2);
  });
});

describe('a stashed prompt', () => {
  /** A stash leaves no other mark, and the box it was taken from is where it is missed. */
  it('says so in the empty box', () => {
    render(<Host session="a" onSend={vi.fn()} stashed />);

    expect(box().placeholder).toContain('stashed');
  });

  it('says nothing when there is none', () => {
    render(<Host session="a" onSend={vi.fn()} />);

    expect(box().placeholder).not.toContain('stashed');
  });
});

describe('searching back through what was sent', () => {
  const history = ['fix the parser', 'add a test for the parser', 'run the build'];
  const row = () => screen.queryByRole('status');

  async function searching() {
    const view = hosted('a', history);
    await view.user.click(box());
    await view.user.keyboard('{Control>}r{/Control}');
    return view;
  }

  it('opens on ctrl+r with the prompt a shell shows', async () => {
    await searching();

    expect(row()?.textContent).toContain("(reverse-i-search)`':");
  });

  it('shows the newest prompt containing what is typed', async () => {
    const { user } = await searching();
    await user.keyboard('run');

    expect(row()?.textContent).toContain('run the build');
  });

  it('leaves the typed characters out of the box, since they are the search', async () => {
    const { user } = await searching();
    await user.keyboard('run');

    expect(box().value).toBe('');
  });

  it('says the search failed without dropping the match it had', async () => {
    const { user } = await searching();
    await user.keyboard('runz');

    expect(row()?.textContent).toContain('(failed reverse-i-search)');
    expect(row()?.textContent).toContain('run the build');
  });

  it('steps back another match on a second ctrl+r', async () => {
    const { user } = await searching();
    await user.keyboard('parser');
    await user.keyboard('{Control>}r{/Control}');

    expect(row()?.textContent).toContain('add a test for the parser');
  });

  it('takes the match into the box on Enter without sending it', async () => {
    const { user, onSend } = await searching();
    await user.keyboard('run');
    await user.keyboard('{Enter}');

    expect(box().value).toBe('run the build');
    expect(onSend).not.toHaveBeenCalled();
    expect(row()).toBeNull();
  });

  it('abandons the search on Escape, leaving what was being written', async () => {
    const view = hosted('a', history);
    await view.user.click(box());
    await view.user.keyboard('half a thought');
    await view.user.keyboard('{Control>}r{/Control}');
    await view.user.keyboard('run');
    await view.user.keyboard('{Escape}');

    expect(row()).toBeNull();
    expect(box().value).toBe('half a thought');
  });

  it('backspace takes back a character of the search rather than of the message', async () => {
    const view = hosted('a', history);
    await view.user.click(box());
    await view.user.keyboard('keep me');
    await view.user.keyboard('{Control>}r{/Control}');
    await view.user.keyboard('runz{Backspace}');

    expect(row()?.textContent).not.toContain('failed');
    expect(box().value).toBe('keep me');
  });

  it('does not open in shell mode, where a prompt is not what is wanted', async () => {
    const view = hosted('a', history);
    await view.user.click(box());
    await view.user.keyboard('!ls');
    await view.user.keyboard('{Control>}r{/Control}');

    expect(row()).toBeNull();
  });
});

/**
 * The mode the session is working in, which the CLI puts by the prompt and cycles with
 * Shift+Tab. The indicator is the only sign the shortcut exists, so it is also the button.
 */
describe('the mode indicator', () => {
  const indicator = () => screen.getByRole('button', { name: /^Mode:/ });

  it('says which mode the session is in', () => {
    bare({ mode: 'plan' });

    expect(indicator().textContent).toBe('plan');
  });

  /**
   * Interactive is where a session spends most of its life, and saying so every time would
   * bury the two modes that change what the agent may do without asking. Shift+Tab is still
   * the way back in, whether or not anything is drawn.
   */
  it('says nothing while the session is interactive', () => {
    bare({ mode: 'interactive' });

    expect(screen.queryByRole('button', { name: /^Mode:/ })).toBeNull();
  });

  // And still nothing when work has brought the line out for its own reasons.
  it('stays quiet in interactive even while the line is up', () => {
    const { view } = bare({ mode: 'interactive', busy: true, busySince: new Date().toISOString() });

    expect(view.container.querySelector('.composer-status')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Mode:/ })).toBeNull();
  });

  // Nothing to report on either end, so there is no line either.
  it('leaves no empty line behind when there is nothing to say', () => {
    const { view } = bare({ mode: 'interactive', busy: false });

    expect(view.container.querySelector('.composer-status')).toBeNull();
  });

  it('marks the mode on the element, so the colour can follow it', () => {
    bare({ mode: 'autopilot' });

    expect(indicator().className).toContain('mode-autopilot');
  });

  // The shell badge above the box already owned `composer-mode`, and reusing the name here
  // put the pill's padding and colours on the badge instead.
  it('does not wear the shell badge class', () => {
    bare({ value: '!ls', mode: 'plan' });

    expect(screen.getByTitle('Escape leaves shell mode').className).toBe('composer-mode');
    expect(indicator().className.split(' ')).not.toContain('composer-mode');
  });

  it('cycles on Shift+Tab', async () => {
    const onCycleMode = vi.fn();
    const { user } = bare({ onCycleMode });

    await user.keyboard('{Shift>}{Tab}{/Shift}');

    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });

  // Shift+Tab is the browser's own "focus the previous thing", and losing the box mid-message
  // to change the mode would be a poor trade.
  it('keeps the caret in the box', async () => {
    const { user } = bare();

    await user.keyboard('{Shift>}{Tab}{/Shift}');

    expect(document.activeElement).toBe(box());
  });

  // Whoever never finds the shortcut should still be able to change the mode.
  it('cycles when clicked', async () => {
    const onCycleMode = vi.fn();
    const { user } = bare({ onCycleMode, mode: 'plan' });

    await user.click(indicator());

    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });

  // Plain Tab belongs to the command menu, and completing a command must not also change
  // the mode out from under the message being written.
  it('leaves plain Tab alone', async () => {
    const onCycleMode = vi.fn();
    const { user } = bare({ onCycleMode });

    await user.keyboard('{Tab}');

    expect(onCycleMode).not.toHaveBeenCalled();
  });

  // Shift+Tab means the same thing wherever the caret is, including mid-message.
  it('cycles without sending what is being written', async () => {
    const onCycleMode = vi.fn();
    const onSend = vi.fn();
    const { user } = bare({ onCycleMode, onSend, value: 'half a thought' });

    await user.keyboard('{Shift>}{Tab}{/Shift}');

    expect(onCycleMode).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  // The stripe down the side of the box, which is the same signal read from further away.
  it('marks the mode on the composer, so the edge can follow it', () => {
    const { view } = bare({ mode: 'plan' });

    expect(view.container.querySelector('.composer')?.className).toContain('mode-plan');
  });
});

/**
 * What the agent says it is doing, beside the mode on the status line. It revises this
 * through a turn, and it is never written to the log, so the only chance to show it is live.
 */
describe('the working indicator', () => {
  const working = () => document.querySelector('.composer-working');
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('says nothing while the session is idle', () => {
    bare({ busy: false, intent: 'Reading the runtime' });

    expect(working()).toBeNull();
  });

  // The line is not only about the mode: work still has to report itself in interactive.
  it('reports work even while the session is interactive', () => {
    bare({ busy: true, busySince: ago(1_000), mode: 'interactive', intent: 'Reading the runtime' });

    expect(working()?.textContent).toContain('Reading the runtime');
  });

  it('says what the agent is doing', () => {
    bare({ busy: true, busySince: ago(1_000), intent: 'Reading the runtime' });

    expect(working()?.textContent).toContain('Reading the runtime');
  });

  // A turn starts before the agent has said anything, and some never say anything at all.
  it('falls back to Working when the agent has not said', () => {
    bare({ busy: true, busySince: ago(1_000), intent: null });

    expect(working()?.textContent).toContain('Working');
  });

  // The two answer one question together: is this progressing, and for how long (#70).
  it('counts the wait beside what is being waited on', () => {
    bare({ busy: true, busySince: ago(95_000), intent: 'Running the tests' });

    expect(working()?.textContent).toContain('Running the tests');
    expect(working()?.querySelector('.elapsed')).toBeTruthy();
  });
});
