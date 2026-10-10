import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Attachments } from './Attachments';
import { Elapsed } from './Elapsed';
import { PlusIcon, SendIcon, StopIcon } from './Icons';
import { Menu, type MenuItem } from './Menu';
import {
  commandText,
  completionOf,
  continuationOf,
  findCommand,
  matchCommands,
  typedCommand,
  type Typed,
} from '../lib/slash';
import { cycled, erased, highlighted, opened, typed as searchTyped, type Search } from '../lib/reverseSearch';
import { useDirectoryCompletion } from '../lib/useDirectoryCompletion';
import { useMcpServers } from '../lib/useMcpServers';
import { REWIND, REWIND_SCOPES, takesServerName, typedRewindScope, typedServerName } from '../lib/localCommands';
import { MODE_LABELS } from '../lib/useMode';
import { typedMention, withMention } from '../lib/mentions';
import { useMentionCompletion } from '../lib/useMentionCompletion';
import { chordsOf, type Overrides } from '../lib/bindings';
import { matchesChord } from '../lib/chords';
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
  /**
   * A paste too long for the box, answered with what should stand in its place.
   *
   * Null leaves the paste alone, which is the ordinary case: most are short enough to
   * read where they land, and hiding one behind a placeholder would take it away for
   * nothing (#55).
   */
  onPasteText?: (text: string) => string | null;
  onError: (message: string) => void;
  /**
   * Takes focus whenever this changes to something other than null, so a session opens
   * ready to type in - and so does answering the last thing the agent was waiting on, which
   * is what draws this box again (#75).
   */
  focusOn: string | null;
  /**
   * Where the caret was when this box last stood down, and a way to say so as it moves.
   *
   * The box is not drawn at all while the agent is waiting on an answer (#75), and a
   * textarea that is drawn again starts at the beginning however much text it is handed
   * back - so somebody who was mid-sentence when a permission request arrived came back to
   * find the caret in front of everything they had written.
   */
  caretAt?: number;
  onCaret?: (at: number) => void;
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
  /** The session directory relative command paths begin in. */
  cwd: string | null;
  /** Called once a slash is typed, so the list can be fetched if it is not known yet. */
  onCommandsNeeded: () => void;
  /** Asked when /rewind is named, since reading the turns resumes the session. */
  onRewindNeeded?: () => void;
  /**
   * Why the rewind menu is empty, when it is.
   *
   * Reading the turns resumes a session, so there is a wait before the menu has anything in
   * it - and a wait that draws nothing looks exactly like a session with nowhere to go back
   * to. Null once there is something to show, which is the menu's job rather than this one's.
   */
  rewindNotice?: string | null;
  /**
   * Set while the box holds a message that is already waiting, rather than a new one.
   *
   * The composer is where a queued message is rewritten, because it is the only box in the
   * app that handles several lines and attachments - the row it came from is a reminder of
   * what is coming rather than a place to write (#76).
   */
  rewriting?: { onCancel: () => void } | null;
  /**
   * Undo the message that started the turn now running, where that is still possible.
   *
   * Not the same as stopping it: the turn goes, and so does the record of ever having
   * asked, and the words come back. Absent unless the runtime would still take it back -
   * which it will not once the model has answered, or for a message this app did not send.
   */
  onTakeBack?: () => void;
  /** How the session is working, shown beside the box as the CLI shows it. */
  mode: SessionMode;
  /** Advance to the next mode, which Alt+M asks for. */
  onCycleMode: () => void;
  /**
   * The keys a reader moved, if any (#246).
   *
   * This box answers two of them itself, so it has to be told what they are now rather than
   * assume the defaults it was written with.
   */
  shortcuts?: Overrides;
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
 * What the selected row would add to the text, for the ghost drawn ahead of the cursor.
 *
 * Silent when the row is not a continuation of what is typed: `matchCommands` ranks aliases
 * and substring hits too, and a row reached that way cannot be drawn as the end of a word
 * it does not start with.
 */
function ghostFor(typed: Typed | null, item: MenuItem | undefined, commands: SlashCommand[]): string {
  if (!typed || !item) return '';
  if (typed.input === null) return completionOf(typed.name, findCommand(commands, item.id));

  const rest = continuationOf(typed.input, item.value ?? item.id);
  if (rest === null) return '';
  // Tab drills into a folder rather than merely filling it in, so the ghost promises the
  // separator that would come with it - including for a folder already named in full.
  return item.kind === 'directory' ? `${rest}${item.separator ?? ''}` : rest;
}

/**
 * Sending is the only action that costs memory: it resumes the session in the shared
 * CLI server. Everything above this component is a pure disk read.
 */
export function Composer({
  disabled,
  busy,
  busySince,
  resuming,
  attached,
  onAttach,
  onPasteFiles,
  onPasteText,
  onError,
  focusOn,
  caretAt,
  onCaret,
  value,
  onChange,
  stashed,
  onSend,
  onAbort,
  history,
  commands,
  cwd,
  onCommandsNeeded,
  onRewindNeeded,
  rewindNotice,
  rewriting,
  onTakeBack,
  mode,
  onCycleMode,
  shortcuts,
  intent,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** What the two keys this box answers itself are bound to, which a reader may have moved. */
  const bindings = useMemo(() => chordsOf(shortcuts ?? {}), [shortcuts]);
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

  /**
   * Taken when the box is drawn, and given back where it was rather than at the beginning.
   *
   * Read through refs because both happen outside the render that knows them: the caret is
   * reported as the box goes away, and restored as it comes back.
   */
  const caretWas = useRef(caretAt);
  caretWas.current = caretAt;
  const reportCaret = useRef(onCaret);
  reportCaret.current = onCaret;

  useEffect(() => {
    const box = inputRef.current;
    return () => {
      if (box) reportCaret.current?.(box.selectionStart);
    };
  }, []);

  useEffect(() => {
    if (!focusOn) return;
    const box = inputRef.current;
    if (!box) return;

    box.focus();
    // Clamping is the platform's: setSelectionRange already pins a position past the end to
    // the end, so a draft restored shorter than it was needs nothing said about it here.
    const at = caretWas.current;
    if (at !== undefined) box.setSelectionRange(at, at);
  }, [focusOn]);

  const typed = typedCommand(value);
  const named = typed ? findCommand(commands, typed.name) : undefined;
  const directories = useDirectoryCompletion(named, typed?.input ?? null, cwd, onError);

  /**
   * The mention being written, if the caret is in one (#135).
   *
   * Read from the caret rather than from the end of the text, so completing one in the
   * middle of a sentence offers what is being written there.
   *
   * Not while a command is being typed, where `@` is an argument rather than a file, and not
   * in shell mode, where the line is a command for the shell and the box is showing the text
   * without its marker - so a position in one is not a position in the other.
   */
  const [caret, setCaret] = useState(0);
  const mention = typed || shell || dismissed === value ? null : typedMention(value, caret);
  const mentions = useMentionCompletion(mention?.path ?? null, cwd, onError);
  /** The half-typed server name, when the argument being written is one. */
  const serverPrefix = named && typed?.input != null ? typedServerName(named, typed.input) : null;
  /**
   * Fetched as soon as the command is named rather than when the name position is reached.
   *
   * The reader spends the next second or so writing ` disable `, and that second is worth
   * having: the first discovery is about 0.8 s, and several more when it is the thing that
   * starts the runtime. Asked no earlier than this, because discovery is not free and most
   * commands have nothing to do with MCP.
   */
  const servers = useMcpServers(cwd, named !== undefined && takesServerName(named), onError);

  /**
   * How much of the second `/rewind` argument has been typed, if that is where the line is.
   *
   * Null until a turn has been finished with a space, which is what says the reader has
   * moved on from which turn to what to take with it.
   */
  const rewindScope = named ? typedRewindScope(named, typed?.input ?? '') : null;

  /**
   * Ask for the turns as soon as the command is named, rather than when they are reached.
   *
   * Reading them resumes the session, so this is the one menu in here that costs something
   * - which is why it waits for the command to be named rather than for the first slash.
   */
  const needsRewind = named?.name === REWIND.name;
  useEffect(() => {
    if (needsRewind) onRewindNeeded?.();
  }, [needsRewind, onRewindNeeded]);

  /**
   * What the menu is offering, if anything.
   *
   * Before the space, the commands themselves. After it, the values the argument accepts,
   * for the commands whose argument is a choice rather than free text - the only case where
   * this app knows enough for the offer to be worth making.
   */
  const items = useMemo((): MenuItem[] => {
    if (mention) {
      return mentions.map((choice) => ({
        id: `mention:${choice.path}`,
        value: choice.path,
        label: choice.directory ? `${choice.name}${choice.separator}` : choice.name,
        description: choice.directory ? 'folder' : 'file',
        ...(choice.directory ? { kind: 'directory' as const, separator: choice.separator } : {}),
      }));
    }

    if (!typed || dismissed === value) return [];

    if (typed.input === null) {
      return matchCommands(commands, typed.name).map((each) => ({
        id: each.name,
        label: each.hint ? `/${each.name} <${each.hint}>` : `/${each.name}`,
        description: each.description,
      }));
    }

    const wanted = typed.input.toLowerCase();

    /**
     * A subcommand has been finished and what follows names a server.
     *
     * Offered instead of the subcommands rather than beside them: `disable` has already
     * been chosen by the time this applies, so listing it again alongside the servers it
     * takes would be offering the reader what they just picked.
     */
    if (serverPrefix !== null) {
      const subcommand = typed.input.slice(0, typed.input.indexOf(' '));
      const partial = serverPrefix.toLowerCase();

      return (servers ?? [])
        .filter((server) => server.name.toLowerCase().startsWith(partial))
        .map((server) => ({
          id: `server:${server.name}`,
          value: `${subcommand} ${server.name}`,
          label: server.name,
          description: server.enabled ? (server.type ?? server.source) : `${server.type ?? server.source}, off`,
        }));
    }

    /**
     * A turn has been chosen and what follows says what to take with it.
     *
     * Offered instead of the turns rather than beside them, for the same reason the server
     * names replace the subcommands: the turn has already been picked by the time this
     * applies, and listing it again would be offering back what was just chosen.
     */
    if (rewindScope !== null) {
      const partial = rewindScope.partial.toLowerCase();

      return REWIND_SCOPES.filter((scope) => scope.name.startsWith(partial)).map((scope) => ({
        id: `scope:${scope.name}`,
        value: `${rewindScope.turn} ${scope.name}`,
        label: scope.name,
        description: scope.description,
      }));
    }

    const choices = (named?.choices ?? [])
      .filter((choice) => choice.name.toLowerCase().startsWith(wanted))
      .map((choice) => ({
        id: `choice:${choice.name}`,
        value: choice.name,
        label: choice.name,
        description: choice.description,
        // What was said, rather than a name and a note about it: drawn as one field across
        // the row, since the words are the whole of what is being chosen between (#156).
        ...(needsRewind ? { kind: 'prompt' as const } : {}),
      }));
    const folders = directories.map((directory) => ({
      id: `directory:${directory.path}`,
      value: directory.path,
      label: `${directory.name}${directory.separator}`,
      description: 'directory',
      kind: 'directory' as const,
      separator: directory.separator,
    }));
    return [...choices, ...folders];
  }, [
    typed?.name,
    typed?.input,
    value,
    dismissed,
    commands,
    named,
    directories,
    mention,
    mentions,
    serverPrefix,
    servers,
    // Its parts rather than the object, which is built fresh every render and would make
    // this rebuild every render with it.
    rewindScope?.turn,
    rewindScope?.partial,
  ]);

  // A list that changes under the cursor leaves it on a row that has moved or gone.
  const itemIdentity = items.map((item) => item.id).join('\0');
  useEffect(() => setSelected(0), [itemIdentity, typed?.name]);

  // Asked for on the first slash rather than at startup: the list costs a Copilot process,
  // and most sessions are read without a command ever being typed.
  const wanted = typed !== null;
  useEffect(() => {
    if (wanted) onCommandsNeeded();
  }, [wanted, onCommandsNeeded]);

  /**
   * The rest of the selected row, drawn ahead of the cursor.
   *
   * Arguments as well as command names. A menu is a keyboard interface, and the ghost is
   * what makes the selected row and the text being typed one thing rather than two the
   * reader has to hold together (#176). It continues the argument rather than the line, so
   * what has been typed stays where it is.
   */
  const ghost = ghostFor(typed, items[selected], commands);

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
    /*
     * A file or folder named with `@`. Both keys do the same thing here, because there is
     * nothing to run: a folder is walked into and a file finishes the mention, so Enter on
     * a folder would otherwise send a message ending in half a path.
     */
    if (mention) {
      const folder = item.kind === 'directory';
      /*
       * Relative while it stays in the session, because that is what the agent resolves
       * against and what reads as a path somebody wrote. Named in full once it climbs out:
       * a `..` chain is resolvable only from where it was typed, and the agent answered one
       * by looking on the wrong drive entirely.
       */
      const chosen = mentions.find((one) => one.path === (item.value ?? item.id));
      const named = chosen && !chosen.inside ? chosen.absolute : (item.value ?? item.id);
      const path = folder ? `${named}${item.separator ?? ''}` : named;
      const next = withMention(value, mention, path, caret, !folder);

      onChange(next.value);
      setCaret(next.caret);
      // A frame later, because the box still holds the old text until React has drawn the
      // change and setting the caret before then puts it at a position in the wrong string.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(next.caret, next.caret);
      });
      return;
    }

    if (!typed) return;

    // A value for the argument: the name stays, and only what follows it is filled in.
    if (typed.input !== null) {
      const argument = item.value ?? item.id;
      const text =
        item.kind === 'directory' && key === 'Tab'
          ? `/${typed.name} ${argument}${item.separator}`
          : `/${typed.name} ${argument}`;
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

    /*
     * The two keys this box answers itself, both because they are about the message being
     * written: attaching a file, and switching modes. Matched against the bindings rather
     * than written as conditions, so a reader can move them with the rest (#246).
     *
     * Ahead of everything except the search, because they mean the same thing wherever the
     * caret is.
     */
    for (const id of ['attach', 'cycle-mode'] as const) {
      const chord = bindings.get(id);
      if (!chord || !matchesChord(chord, event)) continue;

      event.preventDefault();
      if (id === 'attach') attacher.current?.();
      else onCycleMode();
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
          label={mention ? 'Files' : 'Slash commands'}
        />
      )}

      {/* An empty rewind menu, saying which kind of empty it is. Drawn where the menu would
          have been, so the answer arrives where the reader is already looking. */}
      {needsRewind && items.length === 0 && rewindNotice && !search && (
        <div className="menu-notice" role="status">
          {rewindNotice}
        </div>
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

      {/* The box holds a message that is already waiting, not a new one, and Enter saves it
          back rather than sending it. Said above the box because that is what the words in it
          now are, and with a way out, since a rewrite is the one edit nobody can undo by
          typing. */}
      {rewriting && (
        <div className="composer-rewriting" role="status">
          <span>Rewriting a message that is waiting</span>
          <button type="button" onClick={rewriting.onCancel}>
            Cancel
          </button>
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

        <div className="composer-field">
          <textarea
            ref={inputRef}
            data-region="composer"
            value={text}
            className={shell ? 'shell' : undefined}
            onChange={(e) => {
              // Typing ends a walk through the history: the position was taken against text
              // that no longer exists.
              setBrowsing(null);
              setCaret(e.target.selectionStart);
              write(e.target.value);
            }}
            onKeyDown={onKeyDown}
            // Followed as it moves rather than only read on the way out, so the position is
            // already known when the box is asked to stand aside for a queued message.
            onSelect={(event) => {
              setCaret(event.currentTarget.selectionStart);
              onCaret?.(event.currentTarget.selectionStart);
            }}
            onPaste={(event) => {
              // Files first: the clipboard carries them only when files were copied, and a
              // screenshot is a different thing to a wall of text.
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.length > 0) {
                event.preventDefault();
                onPasteFiles(files);
                return;
              }

              /*
               * A browser hands over the whole paste in one event, so there is nothing to
               * coalesce. The CLI debounces for 200ms before deciding, because a terminal
               * receives a paste as a stream of input and would otherwise make a
               * placeholder per chunk - a problem a textarea does not have.
               */
              const text = event.clipboardData?.getData('text/plain') ?? '';
              if (!onPasteText || !text) return;

              const stands = onPasteText(text);
              if (!stands) return;

              event.preventDefault();
              // Put the placeholder where the paste would have gone, replacing whatever was
              // selected, and leave the caret after it so typing carries on from there.
              const box = event.currentTarget;
              const from = box.selectionStart;
              const to = box.selectionEnd;
              write(value.slice(0, from) + stands + value.slice(to));
              const caret = from + stands.length;
              requestAnimationFrame(() => box.setSelectionRange(caret, caret));
            }}
            placeholder={
              shell
                ? 'Run a shell command. Escape to leave shell mode.'
                : stashed
                  ? 'Prompt stashed. Ctrl+S to bring it back.'
                  : busy
                    ? 'Agent is working. Enter to queue a message.'
                    : 'Enter to send · Shift+Enter newline · / commands · ! shell'
            }
            rows={1}
            disabled={disabled}
            /* A command is not prose. Its name is a word the dictionary has never heard of,
               so spelling it correctly earns a red underline - and the shell mode below is
               worse, being paths and flags throughout. Checked again the moment what is
               being written stops being either. */
            spellCheck={!typed && !shell}
          />
          {/* Inside the same box as the textarea rather than beside it, so it lines up with
              the text by construction. Anchored to the whole composer it drifted: the border
              was counted twice, and a row above the box - the waking line - pushed the text
              down and left the ghost behind. */}
          {ghost && (
            <div className="ghost" aria-hidden="true">
              <span>{value}</span>
              <span className="ghost-rest">{ghost}</span>
            </div>
          )}
        </div>

        {/* In the box rather than under it, so the composer is what the pane ends on. Each
            one is named as well as drawn: an icon on its own says nothing to a reader who
            cannot see it, and little to one seeing it for the first time. */}
        <div className="composer-actions">
          <button
            type="button"
            onClick={() => attacher.current?.()}
            title="Attach files (Ctrl+Shift+A)"
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

        {/* The status line the CLI puts under its prompt: what mode the session is in, and
            what it is doing, both from the left. Absent entirely when there is neither to
            report, which is most of the time - a line that is always there is a line nobody
            reads, and an empty one only shortens the transcript above it. */}
        {(mode !== 'interactive' || busy) && (
          <div className="composer-status">
            {/* Only when the session is somewhere other than interactive. That is where a
                session spends most of its life, and saying so every time would bury the two
                modes that actually change what the agent may do unasked. A button rather
                than a label because it is the same action Alt+M performs, which also
                remains the only way back in. */}
            {mode !== 'interactive' && (
              <button
                type="button"
                className={`composer-agent-mode mode-${mode}`}
                onClick={onCycleMode}
                title={`${MODE_LABELS[mode].hint}. Alt+M for the next mode.`}
                aria-label={`Mode: ${MODE_LABELS[mode].label}. Alt+M for the next mode.`}
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
                {/* Not stopping the turn but undoing the message that started it, while the
                    model has not answered yet: the turn goes and so does the record of ever
                    having asked, and the words come back to be written again. Offered only
                    while the runtime would still take it back. */}
                {onTakeBack && (
                  <button type="button" className="composer-take-back" onClick={onTakeBack} title="Unsend this message and take the words back">
                    Take back
                  </button>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
