import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Attachments } from './Attachments';
import { Elapsed } from './Elapsed';
import { PlusIcon, SendIcon, StopIcon } from './Icons';
import { Menu, type MenuItem } from './Menu';
import { commandText, completionOf, findCommand, matchCommands, typedCommand } from '../lib/slash';
import { cycled, erased, highlighted, opened, typed as searchTyped, type Search } from '../lib/reverseSearch';
import { MODE_LABELS } from '../lib/useMode';
import type { Attachment, SessionMode, SlashCommand } from '../../shared/protocol';

interface ComposerProps {
  disabled: boolean;
  busy: boolean;
  /** When the running turn began, so the composer can say how long it has been going. */
  busySince: string | null;
  /**
   * Waking a cold session, which is the one action that genuinely costs something.
   *
   * Between 1.4 and 5.6 seconds depending on how much history there is to read, and
   * deliberate: browsing a session spawns nothing, so the cost lands on the first message.
   */
  resuming: boolean;
  /** Files to send with this message, held outside for the same reason the text is. */
  attached: Attachment[];
  onAttach: (attached: Attachment[]) => void;
  /**
   * Files pasted into the box, which arrive as bytes rather than as paths.
   *
   * Handed up rather than written from here, because a screenshot has to be saved before a
   * message can carry it, and where it is saved is the session's business, not the box's.
   */
  onPasteFiles: (files: File[]) => void;
  onError: (message: string) => void;
  /**
   * Takes focus whenever this changes to something other than null, so a session opens
   * ready to type in. Null while the agent is waiting on a prompt of its own, which has
   * a better claim on the keyboard.
   */
  focusOn: string | null;
  /**
   * The text being written. Held outside, because an unsent message belongs to the
   * session it was meant for rather than to the box it was typed in.
   */
  value: string;
  onChange: (value: string) => void;
  /**
   * Whether a prompt is set aside for this session.
   *
   * Only the box can say so - a stash leaves no other mark, and an empty box that quietly
   * holds something is the one state where the reader needs telling.
   */
  stashed: boolean;
  onSend: (prompt: string) => void;
  onAbort: () => void;
  /**
   * Prompts already sent in this session, newest first, for Up and Down to step through.
   *
   * Passed in rather than read here because the transcript is what knows them, and because
   * a composer that fetched its own history would be answering a question about the session
   * from inside the box.
   */
  history: readonly string[];
  /** The slash commands there are, for the menu a leading slash opens. */
  commands: SlashCommand[];
  /** Called once a slash is typed, so the list can be fetched if it is not known yet. */
  onCommandsNeeded: () => void;
  /** How the session is working, shown beside the box as the CLI shows it. */
  mode: SessionMode;
  /** Advance to the next mode, which Shift+Tab asks for. */
  onCycleMode: () => void;
  /** What the agent says it is doing right now, when it has said. */
  intent: string | null;
}

/** Where the line the caret sits on ends: the next newline, or the end of the text. */
function endOfLine(value: string, caret: number): number {
  const next = value.indexOf('\n', caret);
  return next === -1 ? value.length : next;
}

/** Keys that move the caret, which is what ends a reverse search rather than feeding it. */
const CARET_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/**
 * Sending is the only action that costs memory: it resumes the session in the shared
 * CLI server. Everything above this component is a pure disk read.
 */export function Composer({
  disabled,
  busy,
  busySince,
  resuming,
  attached,
  onAttach,
  onPasteFiles,
  onError,
  focusOn,
  value,
  onChange,
  stashed,
  onSend,
  onAbort,
  history,
  commands,
  onCommandsNeeded,
  mode,
  onCycleMode,
  intent,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The picker lives with the chips; the button that opens it lives with the buttons. */
  const attacher = useRef<(() => void) | null>(null);
  const focusBack = useCallback(() => inputRef.current?.focus(), []);
  /** Which row the command menu's cursor is on, reset whenever the list changes under it. */
  const [selected, setSelected] = useState(0);
  /**
   * Escape closes the menu without closing what is being written.
   *
   * Remembered against the text it was closed for, so carrying on typing the same command
   * leaves it closed while starting a different one opens it again.
   */
  const [dismissed, setDismissed] = useState<string | null>(null);

  /**
   * How far back through the history the reader has stepped, and what they had written
   * before they started.
   *
   * Both are one piece of state because they are only ever meaningful together: `at` is a
   * position in a list that the draft is the end of, and forgetting the draft while keeping
   * the position would lose whatever was being written the moment Up was pressed.
   */
  const [browsing, setBrowsing] = useState<{ at: number; draft: string } | null>(null);

  /** The open reverse search, or null when there is none. */
  const [search, setSearch] = useState<Search | null>(null);
  const match = search && highlighted(search);

  /**
   * Shell mode, and the text without the marker that carries it.
   *
   * The mode is the draft's own leading `!` rather than a piece of state beside it. That
   * makes it per session for nothing - drafts already are - so switching away from a
   * half-typed command and back cannot return the text without the mode it was meant for,
   * which would send it to the agent instead of to the shell.
   *
   * The marker is not shown: it is drawn as the mode instead, so typing `!` reads as the
   * CLI's "strips itself" while still being the only place the mode is kept.
   */
  const shell = value.startsWith('!');
  const text = shell ? value.slice(1) : value;

  /** Write what the box should now contain, keeping the mode the draft is carrying. */
  const write = useCallback((next: string) => onChange(shell ? `!${next}` : next), [onChange, shell]);

  // Anything typed, sent or switched to ends the walk: the position only means something
  // relative to the text it was taken from.
  useEffect(() => setBrowsing(null), [focusOn]);

  // A search is against one session's history and over text that is no longer in the box,
  // so it cannot outlive either.
  useEffect(() => setSearch(null), [focusOn]);

  useEffect(() => {
    if (focusOn) inputRef.current?.focus();
  }, [focusOn]);

  const typed = typedCommand(value);
  const named = typed ? findCommand(commands, typed.name) : undefined;

  /**
   * What the menu is offering, if anything.
   *
   * Before the space, the commands themselves. After it, the values the argument accepts,
   * for the commands whose argument is a choice rather than free text - the only case where
   * this app knows enough for the offer to be worth making.
   */
  const items = useMemo((): MenuItem[] => {
    if (!typed || dismissed === value) return [];

    if (typed.input === null) {
      return matchCommands(commands, typed.name).map((each) => ({
        id: each.name,
        label: each.hint ? `/${each.name} <${each.hint}>` : `/${each.name}`,
        description: each.description,
      }));
    }

    const wanted = typed.input.toLowerCase();
    return (named?.choices ?? [])
      .filter((choice) => choice.name.toLowerCase().startsWith(wanted))
      .map((choice) => ({ id: choice.name, label: choice.name, description: choice.description }));
  }, [typed?.name, typed?.input, value, dismissed, commands, named]);

  // A list that changes under the cursor leaves it on a row that has moved or gone.
  useEffect(() => setSelected(0), [items.length, typed?.name]);

  // Asked for on the first slash rather than at startup: the list costs a Copilot process,
  // and most sessions are read without a command ever being typed.
  const wanted = typed !== null;
  useEffect(() => {
    if (wanted) onCommandsNeeded();
  }, [wanted, onCommandsNeeded]);

  /** The rest of the selected command's name, drawn ahead of the cursor. */
  const ghost =
    typed?.input === null && items[selected]
      ? completionOf(typed.name, findCommand(commands, items[selected]!.id))
      : '';

  function submit(next = value) {
    const prompt = next.trim();
    // A second send while the first is still waking would look like the fix for a button
    // that appears to have done nothing.
    if (!prompt || prompt === '!' || disabled || resuming) return;
    setBrowsing(null);
    onSend(prompt);
  }

  /**
   * Take a row from the menu.
   *
   * Tab finishes the word and leaves the cursor where it was, which is what completion
   * means everywhere else. Enter finishes it and acts, so a command needing no argument
   * runs on one keypress as it does in the CLI, while one that does is left ready to type
   * into rather than sent half-written.
   */
  function choose(item: MenuItem, key: 'Tab' | 'Enter') {
    if (!typed) return;

    // A value for the argument: the name stays, and only what follows it is filled in.
    if (typed.input !== null) {
      const text = `/${typed.name} ${item.id}`;
      onChange(text);
      if (key === 'Enter') submit(text);
      else inputRef.current?.focus();
      return;
    }

    const picked = findCommand(commands, item.id);
    if (!picked) return;

    const text = commandText(picked);
    onChange(text);
    if (key === 'Enter' && !picked.hint) submit(text);
    else inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The menu claims Enter and Tab from a listener that runs first, so a key it has
    // already acted on must not be acted on again here: completing a command would
    // otherwise also send the half-written name that was completed.
    if (event.defaultPrevented) return;

    // An open search owns the keyboard, exactly as it does at a shell prompt: what is typed
    // goes to the search rather than into the box behind it.
    if (search) {
      onSearchKey(event, search);
      return;
    }

    // Shift+Tab cycles the mode, as it does in the CLI. Ahead of everything except the
    // search because it means the same thing wherever the caret is, and the menu claims
    // only plain Tab, so completing a command and changing the mode cannot be confused.
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      onCycleMode();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }

    // Escape leaves shell mode without throwing the command away: what was typed is often
    // worth asking the agent about instead, and losing it to change one's mind would be a
    // poor trade. Claimed here so the global Escape Escape does not also act on it.
    if (event.key === 'Escape' && shell) {
      event.preventDefault();
      onChange(text);
      return;
    }

    // Backspace at the very start is how the marker is deleted, since it is not in the box
    // to delete. Without this an empty shell prompt would have no way out but Escape.
    if (event.key === 'Backspace' && shell && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
      event.preventDefault();
      onChange(text);
      return;
    }

    // Reverse search, opened with the key the CLI opens it with. Prevented whether or not
    // it opens, because the webview would otherwise reload the whole app instead.
    if (event.ctrlKey && event.key === 'r' && !event.altKey && !event.metaKey) {
      event.preventDefault();
      // The history is of prompts, which a shell command is not: searching it here would
      // offer a sentence where a command line is expected.
      if (!shell) setSearch(opened());
      return;
    }

    // Kill to the start or end of the line, which a textarea does not provide and every
    // other place text is typed does.
    if (event.ctrlKey && (event.key === 'u' || event.key === 'k')) {      const box = event.currentTarget;
      const caret = box.selectionStart;
      // A selection already means something to these keys elsewhere; with one in place the
      // line the caret is "on" is ambiguous, so leave it to the browser.
      if (caret !== box.selectionEnd) return;

      event.preventDefault();
      const cut =
        event.key === 'u'
          ? text.slice(0, text.lastIndexOf('\n', caret - 1) + 1) + text.slice(caret)
          : text.slice(0, caret) + text.slice(endOfLine(text, caret));
      const at = event.key === 'u' ? text.lastIndexOf('\n', caret - 1) + 1 : caret;
      setBrowsing(null);
      write(cut);
      requestAnimationFrame(() => box.setSelectionRange(at, at));
      return;
    }

    // Up and down step through what has already been sent, once the caret has nowhere left
    // to go in that direction. That test is what keeps a multi-line message editable: the
    // arrows move within it until they would leave it, and only then reach for history.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      // The history is of prompts, which a shell command is not. Offering them here would
      // put a sentence where a command line is expected.
      if (items.length > 0 || shell) return;

      const box = event.currentTarget;
      const caret = box.selectionStart;
      if (caret !== box.selectionEnd) return;

      const leaving =
        event.key === 'ArrowUp' ? text.lastIndexOf('\n', caret - 1) === -1 : endOfLine(text, caret) === text.length;
      if (!leaving) return;

      const step = stepped(event.key === 'ArrowUp' ? 1 : -1);
      if (step === null) return;

      event.preventDefault();
      write(step);
      requestAnimationFrame(() => box.setSelectionRange(step.length, step.length));
    }
  }

  /**
   * The text one step further back (or forward) through the history, or null if there is
   * nowhere to go - in which case the key is left alone and moves the caret as usual.
   *      *
   * Position -1 is the draft: stepping forward off the end of the history puts back
   * whatever was being written when the walk started, rather than emptying the box.
   */
  function stepped(by: 1 | -1): string | null {
    const from = browsing?.at ?? -1;
    const to = from + by;
    if (to < -1 || to >= history.length) return null;

    const draft = browsing?.draft ?? text;
    if (to === -1) {
      setBrowsing(null);
      return draft;
    }

    setBrowsing({ at: to, draft });
    return history[to]!;
  }

  /**
   * Keys while a reverse search is open, following the CLI branch for branch.
   *
   * Ctrl+R steps back another match, Escape abandons the search, Enter takes what it found,
   * and anything that moves the caret takes it too and gets out of the way - because a
   * search that swallowed an arrow key would leave the reader with no way to edit what they
   * had just found.
   */
  function onSearchKey(event: KeyboardEvent<HTMLTextAreaElement>, open: Search) {
    if (event.ctrlKey && event.key === 'r') {
      event.preventDefault();
      setSearch(cycled(open, history));
      return;
    }

    // The box was never written to while searching, so abandoning it has nothing to put
    // back: what was being typed is still sitting there.
    if (event.key === 'Escape' || (event.ctrlKey && (event.key === 'c' || event.key === 'g'))) {
      event.preventDefault();
      setSearch(null);
      return;
    }

    // Enter takes the match without also sending it. A prompt arrived at by searching is
    // one the reader wants to look at, and often to change, before it goes.
    if (event.key === 'Enter' || (event.ctrlKey && event.key === 'j')) {
      event.preventDefault();
      accept(open);
      return;
    }

    if (event.key === 'Backspace') {
      event.preventDefault();
      setSearch(erased(open, history));
      return;
    }

    // Left unprevented, so the key lands in the text the search has just put in the box.
    if (CARET_KEYS.has(event.key)) {
      accept(open);
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      setSearch(searchTyped(open, history, event.key));
    }
  }

  /** Put the found prompt in the box, close the search, and leave the caret after it. */
  function accept(open: Search) {
    setSearch(null);
    if (open.match === null) return;

    const found = open.match;
    write(found);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(found.length, found.length));
  }

  return (
    <div className={`composer mode-${mode}`}>
      {/* Chips sit above everything else, so a message with several files attached grows
          upwards instead of pushing the box down the pane. */}
      <Attachments
        attached={attached}
        onChange={onAttach}
        onPicker={(pick) => (attacher.current = pick)}
        onFocusBack={focusBack}
        onError={onError}
      />

      {items.length > 0 && !search && (
        <Menu
          items={items}
          selected={selected}
          onSelect={setSelected}
          onChoose={choose}
          onDismiss={() => setDismissed(value)}
          label="Slash commands"
        />
      )}

      {/* Above the box rather than in it, because the box still holds what the search
          interrupted: the match is a proposal until Enter takes it. */}
      {search && (
        <div className={search.failed ? 'reverse-search failed' : 'reverse-search'} role="status">
          <span className="reverse-search-label">
            {search.failed ? '(failed reverse-i-search)' : '(reverse-i-search)'}`{search.query}':
          </span>
          {match && (
            <span className="reverse-search-match">
              {match.before}
              <mark>{match.hit}</mark>
              {match.after}
            </span>
          )}
        </div>
      )}

      {/* The ghost is drawn behind the box rather than in it, because a textarea cannot
          hold text it does not own. Laid out as a single line, which is safe: a command is
          one line by definition, so there is no wrapping to mirror. */}
      <div className="composer-input">
        {/* The `!` the reader typed, drawn as the mode it means rather than left in the box
            as a character to be edited around. */}
        {shell && (
          <span className="composer-mode" title="Escape leaves shell mode">
            shell
          </span>
        )}
        {/* Said here rather than at the top of the pane, because this is where the reader is
            looking after pressing Send, and in terms that make the wait make sense: this
            session costs nothing until it is woken, which is the whole idea. On its own row,
            because a sentence sitting beside the buttons would squeeze the box it is about. */}
        {resuming && <span className="waking">Waking this session up</span>}

        <textarea
          ref={inputRef}
          value={text}
          className={shell ? 'shell' : undefined}
          onChange={(e) => {
            // Typing ends a walk through the history: the position was taken against text
            // that no longer exists.
            setBrowsing(null);
            write(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            // Text is by far the commonest paste, and the clipboard carries files only when
            // files were copied, so an empty list means there is nothing to do here.
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length === 0) return;

            event.preventDefault();
            onPasteFiles(files);
          }}
          placeholder={
            shell
              ? 'Run a command in this session\'s shell. Escape leaves shell mode.'
              : stashed
                ? 'A prompt is stashed. Ctrl+S brings it back.'
                : busy
                  ? 'Agent is working. Enter queues this behind it.'
                  : 'Send a message. Enter to send, Shift+Enter for a newline, / for commands, ! for a shell command.'
          }
          rows={1}
          disabled={disabled}
        />
        {ghost && (
          <div className="ghost" aria-hidden="true">
            <span>{value}</span>
            <span className="ghost-rest">{ghost}</span>
          </div>
        )}

        {/* In the box rather than under it, so the composer is what the pane ends on. Each
            one is named as well as drawn: an icon on its own says nothing to a reader who
            cannot see it, and little to one seeing it for the first time. */}
        <div className="composer-actions">
          <button
            type="button"
            className="attach"
            onClick={() => attacher.current?.()}
            title="Attach files"
            aria-label="Attach files"
          >
            <PlusIcon />
          </button>

          {busy && (
            <button type="button" onClick={onAbort} title="Stop this turn" aria-label="Stop this turn">
              <StopIcon />
            </button>
          )}

          {/* Live while the agent works, which is what makes typing ahead possible: the
              message goes on the queue rather than into the run. A shell command is the
              exception: it is not the agent's work and does not wait behind it. */}
          <button
            type="button"
            className="send"
            onClick={() => submit()}
            disabled={disabled || resuming || !text.trim()}
            title={shell ? 'Run in the shell' : busy ? 'Queue this behind the turn' : 'Send'}
            aria-label={shell ? 'Run in the shell' : busy ? 'Queue this behind the turn' : 'Send'}
          >
            <SendIcon />
          </button>
        </div>

        {/* The status line the CLI puts under its prompt: what mode the session is in on
            one side, what it is doing on the other. Absent entirely when there is neither
            to report, which is most of the time - a line that is always there is a line
            nobody reads, and an empty one only shortens the transcript above it. */}
        {(mode !== 'interactive' || busy) && (
          <div className="composer-status">
            {/* Only when the session is somewhere other than interactive. That is where a
                session spends most of its life, and saying so every time would bury the two
                modes that actually change what the agent may do unasked. A button rather
                than a label because it is the same action Shift+Tab performs, which also
                remains the only way back in. */}
            {mode !== 'interactive' && (
              <button
                type="button"
                className={`composer-agent-mode mode-${mode}`}
                onClick={onCycleMode}
                title={`${MODE_LABELS[mode].hint}. Shift+Tab for the next mode.`}
                aria-label={`Mode: ${MODE_LABELS[mode].label}. Shift+Tab for the next mode.`}
              >
                {MODE_LABELS[mode].label}
              </button>
            )}

            {/* What the agent says it is doing, which it revises as the work turns into
                something else. It says nothing at the start of a turn and nothing at all on
                some of them, so "Working" stands in rather than leaving the line empty.
                Elapsed sits with it because together they answer one question: is this
                progressing, and how long has it been (#70). */}
            {busy && (
              <span className="composer-working">
                <span className="composer-spinner" aria-hidden="true" />
                <span className="composer-intent">{intent ?? 'Working'}</span>
                <Elapsed since={busySince ?? undefined} />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
