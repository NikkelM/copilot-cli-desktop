import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  Attachment,
  SessionSummary,
  SlashCommand,
  TranscriptEvent,
} from '../shared/protocol';

import { Changes } from './components/Changes';
import { Composer } from './components/Composer';
import { ElicitationPrompt } from './components/ElicitationPrompt';
import { Environment } from './components/Environment';
import { AgentPicker } from './components/AgentPicker';
import { ModelPicker } from './components/ModelPicker';
import { OpenIn } from './components/OpenIn';
import { PermissionPrompt } from './components/PermissionPrompt';
import { Shortcuts } from './components/Shortcuts';
import { Queue } from './components/Queue';
import { SessionPath } from './components/SessionPath';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import {
  abortSession,
  createSession,

  onSessionEvent,
  onSessionChanges,
  onSessionLoaded,
  onSessionsChanged,
  onSidecarRestarted,
  onSidecarStopped,
  invokeCommand,
  enqueueCommand,
  runShell,
  sendMessage,
} from './lib/sidecar';
import { CHANGES, ENVIRONMENT } from './lib/localCommands';
import { copyText } from './lib/clipboard';
import { explain, messageOf } from './lib/errors';
import { activityOf } from './lib/activity';
import { stashFiles } from './lib/paste';
import { promptHistory } from './lib/promptHistory';
import { useChanges } from './lib/useChanges';
import { useEnvironment } from './lib/useEnvironment';
import { useDrafts } from './lib/useDrafts';
import { useAgent } from './lib/useAgent';
import { useModel } from './lib/useModel';
import { useCommands } from './lib/useCommands';
import { dispatch } from './lib/slash';
import { usePrompts } from './lib/usePrompts';
import { useQueue } from './lib/useQueue';
import { useSessions } from './lib/useSessions';
import { useShortcuts } from './lib/useShortcuts';
import { useTaskbar } from './lib/useTaskbar';
import { useTranscript } from './lib/useTranscript';
import { useTreeState } from './lib/useTreeState';
import { useTauriEvent } from './lib/useTauriEvent';
import './App.css';

/** Where showing the model's thinking is remembered, so ctrl+t survives a restart. */
const REASONING = 'copilot-desktop.reasoning';

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Whether the model's thinking is shown. Off is a preference, not a session's state. */
  const [reasoning, setReasoning] = useState(() => localStorage.getItem(REASONING) !== 'false');
  /**
   * Unsent text and the one prompt each session may have set aside, which are two states
   * of the same writing and so have one owner.
   */
  const drafts = useDrafts();
  /** Files waiting to go with a draft, kept per session for the same reason the text is. */
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const [busy, setBusy] = useState(false);
  /** When the running turn began, for the clock beside the stop button (#70). */
  const [busySince, setBusySince] = useState<string | null>(null);
  /** Whether the shortcut list is up. There is nothing else in the app that names them. */
  /**
   * Which help is showing, if any.
   *
   * Two lists, not two components: `?` asks for the keys, `/help` for the keys and every
   * command. Split so the reminder stays short enough to read at a glance.
   */
  const [help, setHelp] = useState<'keys' | 'full' | null>(null);
  /** Whether the list of files this session changed is showing. */
  const [showChanges, setShowChanges] = useState(false);
  /** Whether what this session would load is showing. */
  const [showEnvironment, setShowEnvironment] = useState(false);
  /**
   * The session being woken, if one is.
   *
   * Kept per session rather than as a flag: waking takes seconds, and a reader who moves
   * to another session in the meantime was being told that one was waking, and having
   * their Enter refused for it.
   */
  const [resuming, setResuming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when the sidecar exits: nothing works afterwards, so it outranks any other message. */
  const [stopped, setStopped] = useState<string | null>(null);
  /**
   * A session opened by id that the list does not carry.
   *
   * The sidebar hides sessions with no title and no turns, but one can still be found by
   * id and opened. Without somewhere to put its summary the header would have no path, no
   * branch and no title for a session that is plainly open.
   */
  const [offList, setOffList] = useState<SessionSummary | null>(null);

  const sessions = useSessions(setError);
  const selected = sessions.find(selectedId) ?? (offList?.sessionId === selectedId ? offList : null);

  const open = useCallback((sessionId: string, session?: SessionSummary) => {
    setSelectedId(sessionId);
    setOffList(session ?? null);
  }, []);

  const transcript = useTranscript(selectedId, setError);
  const tree = useTreeState(selected?.cwd ?? null);
  const queue = useQueue();
  const model = useModel(selectedId, setError);
  const agent = useAgent(selectedId, selected?.cwd ?? null, setError);
  const slash = useCommands(selectedId);
  const changes = useChanges(selectedId);
  const environment = useEnvironment(selected?.cwd ?? null);
  const prompts = usePrompts(selectedId, setError);
  /**
   * Starting a session is the one action here that costs a Copilot process before anything
   * has been said, so it says it is working rather than appearing to have done nothing.
   */
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      // No folder asked for: not every session is about a project, and wanting to ask
      // something quickly should not begin with choosing a directory.
      const { sessionId } = await createSession();
      // Selected only once the list holds it, or the pane has nothing to show and the
      // button looks as though it did nothing.
      await sessions.refresh();
      setSelectedId(sessionId);
    } catch (e: unknown) {
      setError(explain(e));
    } finally {
      setCreating(false);
    }
  }

  /**
   * Attach files pasted into the composer.
   *
   * The session is named rather than read from state because the write is asynchronous:
   * pasting and then moving to another session would otherwise attach the screenshot to
   * whichever one happened to be open when the bytes finished landing.
   */
  async function handlePaste(sessionId: string, files: File[]) {
    try {
      const { attached, tooLarge } = await stashFiles(sessionId, files);
      if (attached.length > 0) {
        setAttachments((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), ...attached] }));
      }
      if (tooLarge.length > 0) {
        setError(`Too large to paste: ${tooLarge.join(', ')}. Attach with + instead, which sends the path.`);
      }
    } catch (e: unknown) {
      setError(explain(e));
    }
  }

  // Selecting a session cannot leave the composer disabled by a turn that was running in
  // whichever session was open before.
  useEffect(() => {
    setBusy(false);
    setBusySince(null);
  }, [selectedId]);

  // Nor a help list open over a session nobody asked to read it in. Not remembered per
  // session: it is a reference, so wanting it back is a keypress away.
  useEffect(() => setHelp(null), [selectedId]);

  // The same for the list of changes, which is about the session that was open, not this one.
  useEffect(() => setShowChanges(false), [selectedId]);

  // And for the environment, which is read for one directory and says nothing about another.
  useEffect(() => setShowEnvironment(false), [selectedId]);

  // Read inside event handlers without making them depend on the selected session.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  /** Read by a shortcut handler registered once, which would otherwise hold the first render's answer. */
  const busyRef = useRef(false);
  busyRef.current = busy;

  useTauriEvent(() =>
    onSessionEvent(({ sessionId, event }) => {
      sessions.observe(sessionId, event);

      // The queue belongs to whichever session owns it rather than to the one on screen: a
      // session left running keeps its queue while the reader is elsewhere, and it must be
      // right when they come back. The runtime says only that its queue changed, so this is
      // a prompt to read it again rather than something to apply.
      if (event.type === 'pending_messages.modified') queue.refresh(sessionId);
      // Stopping a turn discards everything behind it, and the runtime does not always
      // announce that as a queue change.
      if (event.type === 'abort') queue.clear(sessionId);

      if (sessionId !== selectedRef.current) return;

      if (event.type === 'assistant.turn_start') {
        setBusy(true);
        // The first turn of the request, not each round trip: a request calling tools starts
        // a turn many times over, and restarting the clock in those gaps would report the
        // last hop rather than how long the reader has been waiting (#70).
        setBusySince((current) => current ?? event.timestamp ?? new Date().toISOString());
      }
      // Not `assistant.turn_end`, which is one model round trip: a request that calls tools
      // ends and starts a turn many times over, and clearing the flag in those gaps offered
      // a Send button for a session that was still working.
      if (event.type === 'session.idle' || event.type === 'abort') {
        setBusy(false);
        setBusySince(null);
      }
      if (event.type === 'session.error') setError(describeError(event));
      // The agent working is what changes the working tree, so this is the moment the
      // branch line is worth asking about again. Once per request rather than once per
      // round trip: this spawns git, and nine of them per message bought nothing.
      if (event.type === 'session.idle') tree.refresh();
      // Every resume reports the model as well as every switch, including one made from a
      // terminal, so the header follows rather than trusting what it read from the log.
      model.observe(event);
      // The same for the agent, which a slash command can change without this picker.
      agent.observe(event);

      transcript.push(event);
    }),
  );

  useTauriEvent(() =>
    onSessionLoaded(({ sessionId, loaded }) => {
      sessions.observeLoaded(sessionId, loaded);

      // The queue lives in the session that was let go, so nothing is waiting any more.
      if (!loaded) queue.clear(sessionId);

      // A session that is awake knows about a few commands the runtime at large does not,
      // and a server is already running to ask, so this costs nothing to take.
      slash.observe(loaded, sessionId);
    }),
  );

  // The store changes on every turn of every running session, including ones started in
  // a terminal, so this keeps the sidebar current without polling.
  useTauriEvent(() => onSessionsChanged(() => sessions.refresh()), [sessions.refresh]);

  /**
   * A turn recorded what it changed while the list of changes was open.
   *
   * Read again rather than left as it was: the panel is opened to watch a turn's work, and
   * one that has to be closed and reopened to say anything is answering about the past. The
   * sidecar only sends this when a turn actually wrote something, and only an open panel
   * acts on it, so a session working away with it closed costs nothing.
   */
  useTauriEvent(
    () =>
      onSessionChanges(({ sessionId }) => {
        if (showChanges && sessionId === selectedId) changes.load();
      }),
    [showChanges, selectedId, changes.load],
  );

  // Losing the sidecar takes every session with it, and a request that will never be
  // answered otherwise shows as the app quietly doing nothing.
  useTauriEvent(() =>
    onSidecarStopped((reason) => {
      setStopped(reason);
      setBusy(false);
      setResuming(null);
      prompts.clear();
    }),
  );

  // A replacement is up. Nothing it was told survives, so anything that was waiting on
  // the old one is dropped and the session list is read again.
  useTauriEvent(
    () =>
      onSidecarRestarted(() => {
        setError(null);
        setBusy(false);
        setResuming(null);
        prompts.clear();
        sessions.refresh();
      }),
    [sessions.refresh],
  );

  /** Stop the turn, saying so rather than leaving the press looking unnoticed. */
  const interrupt = useCallback(() => {
    const forSession = selectedRef.current;
    if (forSession) abortSession(forSession).catch((e: unknown) => setError(explain(e)));
  }, []);

  useShortcuts(
    useCallback(
      (shortcut) => {
        if (shortcut === 'help') {
          setHelp((showing) => (showing ? null : 'keys'));
          return;
        }

        if (shortcut === 'reasoning') {
          setReasoning((showing) => {
            localStorage.setItem(REASONING, String(!showing));
            return !showing;
          });
          return;
        }

        if (shortcut === 'interrupt') {
          interrupt();
          return;
        }

        if (shortcut === 'stash') {
          if (selectedRef.current) drafts.swap(selectedRef.current);
          return;
        }

        // Escape twice means "undo what I was about to do": stopping the turn while one is
        // running, and otherwise throwing away what was written but not sent.
        if (busyRef.current) interrupt();
        else if (selectedRef.current) drafts.clear(selectedRef.current);
      },
      [interrupt, drafts],
    ),
    // The composer's own text, rather than what a key event can be asked about the field it
    // landed in: this is where it is actually kept.
    useCallback(() => drafts.written(selectedRef.current), [drafts]),
  );

  /**
   * Put the keyboard back where someone is going to type.
   *
   * A button in the header takes focus when it is clicked and has nowhere to give it back
   * to, so the next keystroke goes to the button rather than into the message. Bumped
   * rather than set, since returning focus twice to the same session is a real request.
   */
  const [focusAt, setFocusAt] = useState(0);
  const toComposer = useCallback(() => setFocusAt((n) => n + 1), []);

  /** Open the panel and read the list, from wherever the request came from. */
  function openChanges() {
    setShowEnvironment(false);
    setShowChanges(true);
    changes.load();
    toComposer();
  }

  function closeChanges() {
    setShowChanges(false);
    toComposer();
  }

  /**
   * Open the panel and read it again.
   *
   * Reread on every open rather than kept, since the reason to open it is usually that one
   * of the files it lists has just been edited. Only one of these panels shows at a time:
   * both are tall, and stacking them pushes the transcript off the screen.
   */
  function openEnvironment() {
    setShowChanges(false);
    setShowEnvironment(true);
    void environment.load();
    toComposer();
  }

  function closeEnvironment() {
    setShowEnvironment(false);
    toComposer();
  }

  async function handleSend(prompt: string) {
    if (!selectedId) return;

    // A leading `!` is a shell command, which the runtime runs in the session's own shell.
    // Checked before the slash dispatch, since `!/usr/bin/env` is a path, not a command.
    if (prompt.startsWith('!')) {
      const command = prompt.slice(1).trim();
      if (command) return runShellCommand(selectedId, command);
      return;
    }

    // A leading slash naming a command is a command, not a message. Anything else that
    // starts with one - a path, a fraction, a sentence - is text, and is sent as text.
    const what = dispatch(prompt, slash.commands);

    if (what.kind === 'local') {
      drafts.clear(selectedId);
      setError(null);
      // Which one it is decides what opens. There is no default: an unhandled local
      // command would silently do whatever the last branch happened to do.
      if (what.command.name === CHANGES.name) openChanges();
      else if (what.command.name === ENVIRONMENT.name) openEnvironment();
      else setHelp('full');
      return;
    }

    if (what.kind === 'command') return runCommand(selectedId, what.command, what.input);

    if (what.kind === 'unknown') {
      const near = what.near.map((each) => `/${each.name}`);
      drafts.clear(selectedId);
      setError(null);
      transcript.showLocal('command.failed', {
        text:
          `Unknown command /${what.name}.` +
          (near.length > 0 ? ` Did you mean ${near.join(', ')}?` : ' Type / to see what there is.'),
      });
      return;
    }

    return send(selectedId, prompt, prompt);
  }

  /**
   * Run a slash command, and show whatever it produced.
   *
   * Nothing about this reaches the event log: the runtime hands the output back once and
   * keeps no record, so the rows written here are the only account of it there will ever be.
   *
   * Everything it has to say goes to the transcript, refusals included, which is where the
   * CLI puts them: its whole slash path is one try/catch, and both arms append a timeline
   * entry. A refusal is the answer to a line that was typed into the transcript, so a
   * banner over the top separates it from the thing it is about (#145).
   */
  async function runCommand(sessionId: string, command: SlashCommand, input: string) {
    setError(null);

    // `/session id` is the terminal's own rather than the runtime's: the runtime's
    // `/session` offers info|checkpoints|files|plan|rename and answers `id` with a usage
    // line, while the CLI adds `id` and handles it locally. This app holds the id too, so
    // it is ours to answer - and answering it here keeps it free, since nothing has to
    // wake up to read something already on screen (#129).
    if (command.name === 'session' && input.trim() === 'id') {
      drafts.clear(sessionId);
      transcript.showSent(`/${command.name} ${input.trim()}`);
      const copied = await copyText(sessionId);
      transcript.showLocal('command.output', {
        text: copied ? `${sessionId}\n\nCopied to the clipboard.` : `${sessionId}\n\nCould not reach the clipboard.`,
      });
      return;
    }

    const typed = input ? `/${command.name} ${input}` : `/${command.name}`;

    /**
     * A command the runtime will not run mid-turn joins the queue behind it.
     *
     * `allowDuringTurn` says whether a command may jump the turn, not whether it may be
     * asked for. Refusing it was this app's own rule and not the runtime's: the CLI queues
     * it, and 14 of the 32 commands - `/review` and `/compact` among them - do not carry
     * the flag, so nearly half were being turned away for no reason (#147).
     *
     * Nothing is echoed here. The queue row is the record of what is waiting, and the
     * runtime writes the conversation's own record when it finally runs.
     */
    if (busy && !command.allowDuringTurn) {
      drafts.clear(sessionId);
      try {
        const queued = await enqueueCommand(sessionId, typed, typed);
        if (!queued) {
          transcript.showLocal('command.failed', {
            text: `/${command.name} could not be queued for this session. Stop the turn and run it again.`,
          });
        }
      } catch (e: unknown) {
        transcript.showLocal('command.failed', { text: messageOf(e) });
      }
      return;
    }

    drafts.clear(sessionId);
    // Echoed as typed, so the transcript says what was asked for as well as what came back.
    transcript.showSent(typed);

    const wasCold = !sessions.find(sessionId)?.loaded;
    setResuming(wasCold ? sessionId : null);

    try {
      const outcome = await invokeCommand(sessionId, command.name, input || undefined);

      switch (outcome.kind) {
        case 'text':
          transcript.showLocal('command.output', { text: outcome.text, markdown: outcome.markdown });
          break;

        // The command wrote the prompt; the transcript already shows the command that did
        // so, which is the record of what was asked for. The prompt itself is machinery.
        case 'prompt':
          if (outcome.notice) transcript.showLocal('command.output', { text: outcome.notice });
          await send(sessionId, outcome.prompt, null);
          break;

        case 'done':
          if (outcome.message) transcript.showLocal('command.output', { text: outcome.message });
          break;

        // Named rather than swallowed: a command that quietly did nothing is worse than one
        // that says this app cannot do it yet.
        case 'unsupported':
          transcript.showLocal('command.failed', {
            text: `/${command.name} needs a ${outcome.what} view, which this app does not have yet.`,
          });
          break;
      }
    } catch (e: unknown) {
      // The runtime's own wording, which already names the command and says what it wanted:
      // invoking /add-dir with no argument answers with its usage line.
      transcript.showLocal('command.failed', { text: messageOf(e) });
    } finally {
      setResuming(null);
    }
  }

  /**
   * Send a message to the agent.
   *
   * The text sent and the text shown are not always the same: a command that produces a
   * prompt writes something longer than the transcript should carry, and has already put
   * the command that produced it there. Null means it is shown somewhere already.
   */
  /**
   * Run a shell command the reader typed, rather than sending it to the agent.
   *
   * Goes through the runtime rather than being run beside it, so the command is emitted as
   * a tool call: the transcript shows it like any other, its output persists in the event
   * log, and the agent has it in context afterwards. That last part is what makes it worth
   * having - `!git status` is useful because the agent can then be asked about it (#134).
   *
   * It does not queue. A shell command is not the agent's work and there is nothing for it
   * to wait behind, which is also what the CLI does.
   */
  async function runShellCommand(sessionId: string, command: string) {
    setError(null);
    // Back to a bare marker rather than empty: shell mode is a mode, and one command is
    // rarely the only one.
    drafts.write(sessionId, '!');

    const wasCold = !sessions.find(sessionId)?.loaded;
    setResuming(wasCold ? sessionId : null);

    try {
      await runShell(sessionId, `desktop-shell-${Date.now()}`, command);
    } catch (e: unknown) {
      transcript.showLocal('command.failed', { text: `Could not run \`${command}\`: ${explain(e)}` });
    } finally {
      setResuming(null);
    }
  }

  async function send(sessionId: string, prompt: string, display: string | null) {
    setError(null);
    drafts.clear(sessionId);
    // Taken before the send so a file picked while it is in flight belongs to the next
    // message rather than this one.
    const sent = attachments[sessionId] ?? [];
    setAttachments((current) => ({ ...current, [sessionId]: [] }));

    const wasCold = !sessions.find(sessionId)?.loaded;
    setResuming(wasCold ? sessionId : null);

    // Show the prompt straight away when nothing is running; resuming a cold session takes
    // seconds, and a prompt that appears only afterwards looks like it was not sent. While
    // a turn is running the message will queue, and showing it in the conversation would
    // claim the agent had already been given it.
    const expectQueued = busy;
    const shown = !expectQueued && display !== null ? transcript.showSent(display) : null;
    setBusy(true);

    try {
      const { queued } = await sendMessage({ sessionId, prompt, attachments: sent });

      // The runtime decides, and a turn can end while the message is on its way, so the
      // guess above is reconciled with what actually happened. Nothing is recorded for a
      // queued message: the runtime announces its own queue, and this app reads it.
      if (!queued && expectQueued && display !== null) transcript.showSent(display);
    } catch (e: unknown) {
      setError(explain(e));
      setBusy(false);

      // Nothing was sent, so nothing should be left saying it was, and the message itself
      // is the reader's: it goes back to the composer with its attachments rather than
      // being lost to an error they may want to read first. Anything typed in the meantime
      // wins, since taking that away to restore an older draft would be the worse theft.
      if (shown) transcript.remove(shown);
      if (display !== null) {
        drafts.suggest(sessionId, display);
      }
      if (sent.length) {
        setAttachments((current) => ({ ...current, [sessionId]: [...sent, ...(current[sessionId] ?? [])] }));
      }
    } finally {
      setResuming(null);
    }
  }

  // Derived rather than kept: the transcript already knows what was sent, and a second
  // record of it could only ever disagree with the first.
  const history = useMemo(() => promptHistory(transcript.events), [transcript.events]);

  // What each session is doing, for the sidebar. Joined here because the three sources sit
  // apart - the runtime reports turns, the prompts hold unanswered questions, the queue is
  // its own.
  const activity = useMemo(
    () =>
      activityOf(
        sessions.working,
        prompts.permissions,
        prompts.elicitations,
        Object.fromEntries(Object.entries(queue.queues).map(([id, waiting]) => [id, waiting.length])),
      ),
    [sessions.working, prompts.permissions, prompts.elicitations, queue.queues],
  );

  useTaskbar(sessions.working.size > 0);

  return (
    <div className="app">
      <Sidebar
        sessions={sessions.all}
        selectedId={selectedId}
        onSelect={open}
        onCreate={() => void handleCreate()}
        creating={creating}
        maxLoaded={sessions.maxLoaded}
        activity={activity}
      />

      <main className="main">
        {/* Nothing here works once the sidecar is gone, so it says so instead of showing
            a transcript that can no longer be added to. One child, like the other
            branches: .main assigns its rows by position. */}
        {stopped ? (
          <div className="placeholder">
            <p className="error">{stopped}</p>
          </div>
        ) : selected ? (
          <>
            <header className="main-header">
              <h1>{selected.title ?? 'Untitled session'}</h1>
              {/* Path, buttons and controls on one line: the buttons were a row of their
                  own against the left edge, which wasted the width the header has. */}
              <div className="header-row">
                <SessionPath cwd={selected.cwd} state={tree.state} onError={setError} />
                <OpenIn
                  cwd={selected.cwd}
                  remote={tree.state?.remote ?? null}
                  branch={tree.state?.branch ?? selected.branch}
                  onError={setError}
                />
                <div className="header-controls">
                  {/* Reads files rather than starting a session, so it costs nothing until
                      it is asked for - and then costs enough to be worth asking for. */}
                  <button
                    type="button"
                    className={showChanges ? 'header-button on' : 'header-button'}
                    onClick={() => (showChanges ? closeChanges() : openChanges())}
                    aria-pressed={showChanges}
                    title="What this session changed, and the diff for any of it"
                  >
                    Changes
                  </button>
                  <AgentPicker
                    current={agent.current}
                    agents={agent.agents}
                    failed={agent.failed}
                    onOpen={agent.refresh}
                    onChoose={agent.choose}
                  />
                  <ModelPicker
                    current={model.current}
                    models={model.models}
                    failed={model.failed}
                    onOpen={model.refresh}
                    onChoose={model.choose}
                  />
                </div>
              </div>
            </header>

            {/* Always rendered, even when empty: .main assigns rows by position, so a
                child that comes and goes moves the transcript into another row. */}
            <div className="notices">
              {error && <p className="error">{error}</p>}
            </div>

            <Transcript
              events={transcript.events}
              sessionId={selected.sessionId}
              cwd={selected.cwd}
              abandoned={transcript.abandoned}
              hasOlder={transcript.hasOlder}
              loadingOlder={transcript.loadingOlder}
              onLoadOlder={transcript.loadOlder}
              reasoning={reasoning}
            />

            <div className="footer">
              {/* Above the composer and below everything else, because that is where the
                  CLI puts it and where someone typing is already looking. */}
              {help && (
                <Shortcuts commands={help === 'full' ? slash.commands : undefined} onClose={() => setHelp(null)} />
              )}

              {showChanges && (
                <Changes
                  changes={changes.changes}
                  loading={changes.loading}
                  failed={changes.failed}
                  diffs={changes.diffs}
                  onDiff={changes.diff}
                  cwd={selected.cwd}
                  onClose={closeChanges}
                  onReview={changes.review}
                  reviewedAt={changes.reviewedAt}
                  showAll={changes.showAll}
                  onSpan={changes.setSpan}
                />
              )}

              {showEnvironment && (
                <Environment
                  environment={environment.environment}
                  loading={environment.loading}
                  failed={environment.failed}
                  onReload={() => void environment.load()}
                  onClose={closeEnvironment}
                />
              )}

              <Queue items={queue.queues[selected.sessionId] ?? []} />

              {prompts.mine.elicitations.map((pending) => (
                <ElicitationPrompt
                  key={pending.requestId}
                  pending={pending}
                  onResolve={(action, content) => prompts.answerElicitation(pending, action, content)}
                />
              ))}

              {prompts.mine.permissions.map((pending) => (
                <PermissionPrompt
                  key={pending.requestId}
                  pending={pending}
                  cwd={selected.cwd}
                  onResolve={(choice) => prompts.answerPermission(pending, choice)}
                />
              ))}

              <Composer
                disabled={!selectedId}
                busy={busy}
                busySince={busySince}
                resuming={resuming === selected.sessionId}
                attached={attachments[selected.sessionId] ?? []}
                onAttach={(files) => setAttachments((current) => ({ ...current, [selected.sessionId]: files }))}
                onPasteFiles={(files) => void handlePaste(selected.sessionId, files)}
                onError={setError}
                // A question or a permission request blocks the agent until answered, so
                // it keeps the keyboard; the composer takes it back once nothing is waiting.
                focusOn={prompts.blocked ? null : `${selectedId}:${focusAt}`}
                value={drafts.textOf(selected.sessionId)}
                onChange={(text) => drafts.write(selected.sessionId, text)}
                stashed={drafts.hasStash(selected.sessionId)}
                onSend={(prompt) => void handleSend(prompt)}
                onAbort={interrupt}
                history={history}
                commands={slash.commands}
                onCommandsNeeded={slash.open}
              />
            </div>
          </>
        ) : (
          <div className="placeholder">
            {error ? (
              <p className="error">{error}</p>
            ) : (
              <p>Select a session. Browsing costs no Copilot process.</p>
            )}
            {/* Offered whichever of the two is showing: a list that would not load is a
                reason to start a session, not a reason to hide the way to. */}
            <button type="button" className="new-session" onClick={handleCreate} disabled={creating}>
              {creating ? 'Starting…' : 'Start a new session'}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function describeError(event: TranscriptEvent): string {
  const data = event.data as { message?: unknown } | null;
  return typeof data?.message === 'string' ? explain(data.message) : 'Session error';
}
