import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';

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
import { Repository } from './components/Repository';
import { Wiki } from './components/Wiki';
import { AgentPicker } from './components/AgentPicker';
import { ModelPicker } from './components/ModelPicker';
import { OpenIn } from './components/OpenIn';
import { PermissionPrompt } from './components/PermissionPrompt';
import { PlanPrompt } from './components/PlanPrompt';
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
  invokeCommand,
  enqueueCommand,
  runShell,
  sessionUsage,
  setMcpEnabled,
  sendMessage,
  evictSession,
  loadSession,
  renameSession,
  deleteSession,
  writeCliSettings,
} from './lib/sidecar';
import { CHANGES, ENVIRONMENT, GIT, TAG, USAGE, WIKI, wantsDirectory, withTagChoices } from './lib/localCommands';
import { copyText } from './lib/clipboard';
import { sessionActions } from './lib/sessionActions';
import { useArchived } from './lib/useArchived';
import { normalise, useTags } from './lib/useTags';
import { TagPicker } from './components/TagPicker';
import { RenamePrompt } from './components/RenamePrompt';
import { HeaderTags } from './components/HeaderTags';
import { sessionDefaults, useSettings } from './lib/useSettings';
import { useRecycleBin } from './lib/useRecycleBin';
import { useDiskUsage } from './lib/useDiskUsage';
import { useCliSettings } from './lib/useCliSettings';
import { useCliDisplay } from './lib/useCliDisplay';
import { SettingsWindow } from './components/SettingsWindow';
import { usePanel } from './lib/usePanel';
import { Confirm } from './components/Confirm';
import { SidebarGrip } from './components/SidebarGrip';
import { SidebarToggle } from './components/SidebarToggle';
import { useSidebarWidth } from './lib/useSidebarWidth';
import { openPath } from '@tauri-apps/plugin-opener';
import { explain, messageOf } from './lib/errors';
import { revealPointerForPicker } from './lib/nativePicker';
import { usageReport } from './lib/usageReport';
import { activityOf } from './lib/activity';
import { clockFrom, intentOf, subagentNameIn } from './lib/timeline';
import { stashFiles } from './lib/paste';
import { promptHistory } from './lib/promptHistory';
import { useChanges } from './lib/useChanges';
import { useEnvironment } from './lib/useEnvironment';
import { useDisabledSkills } from './lib/useDisabledSkills';
import { useDrafts } from './lib/useDrafts';
import { useAgent } from './lib/useAgent';
import { useModel } from './lib/useModel';
import { useMode } from './lib/useMode';
import { useContextUsage } from './lib/useContextUsage';
import { useCommands } from './lib/useCommands';
import { useRepoStatus } from './lib/useRepoStatus';
import { useRuntimeHealth } from './lib/useRuntimeHealth';
import { useFavourites } from './lib/useFavourites';
import { STEP, clampScale } from './lib/scale';
import { useSubagents } from './lib/useSubagents';
import { useWiki } from './lib/useWiki';
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

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Whether the knowledge base is being read instead of a session.
   *
   * A destination rather than a panel over a session: it belongs to no session, is read for
   * minutes at a time, and wants the width. Kept beside the selected session so closing it
   * returns to where the reader was.
   */
  const [showWiki, setShowWiki] = useState(false);
  /** Whether the model's thinking is shown. Off is a preference, not a session's state. */
  const { display, set: setDisplay, take: takeDisplay } = useCliDisplay();
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
  /**
   * What the agent last said it was doing, for the status line under the composer.
   *
   * Transient: the runtime revises it as the work changes shape, and never writes it to the
   * log, so there is nothing to read back for a session that was not being watched.
   */
  const [intent, setIntent] = useState<string | null>(null);
  /** Whether the shortcut list is up. There is nothing else in the app that names them. */
  /**
   * Which help is showing, if any.
   *
   * Two lists, not two components: `?` asks for the keys, `/help` for the keys and every
   * command. Split so the reminder stays short enough to read at a glance.
   */
  const panel = usePanel(selectedId);
  const [help, setHelp] = useState<'keys' | 'full' | null>(null);
  /** Whether the list of files this session changed is showing. */
  /** Whether what this session would load is showing. */
  /** Whether the source control panel is open, which is what asks git for the tree state. */
  /**
   * The session being woken, if one is.
   *
   * Kept per session rather than as a flag: waking takes seconds, and a reader who moves
   * to another session in the meantime was being told that one was waking, and having
   * their Enter refused for it.
   */
  const [resuming, setResuming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    // Choosing a session is asking for that conversation, including the one whose delegated
    // task is being read: the subagent view would otherwise be a room with one door.
    subagents.close();
    // The wiki is somewhere else entirely, and a session chosen while reading it is a
    // request to go back to work.
    setShowWiki(false);
  }, []);

  const transcript = useTranscript(selectedId, setError);
  const tree = useTreeState(selected?.cwd ?? null);
  const queue = useQueue();
  const model = useModel(selectedId, setError);
  // A restored session is back on disk but not in the list, which is built from what is
  // there: nothing notices a directory reappearing until it is looked at again.
  const bin = useRecycleBin(sessions.refresh, setError);
  const disk = useDiskUsage();
  const cliSettings = useCliSettings(setError);
  const mode = useMode(selectedId, setError);
  const contextUsage = useContextUsage(selectedId);
  const agent = useAgent(selectedId, selected?.cwd ?? null, setError);
  const slash = useCommands(selectedId);
  const subagents = useSubagents();
  // Up here with the other hooks because the keyboard reads it: Ctrl+= and Ctrl+- change
  // the text size, which is one of these rather than a value of its own.
  const { settings, apply: applySettings } = useSettings();
  const width = useSidebarWidth();
  const { favourites, toggle: toggleFavourite } = useFavourites();
  const { archived, toggle: toggleArchived, unarchive } = useArchived();
  const { tags, known: knownTags, toggle: toggleTag, retire: retireTag } = useTags();
  /** The session whose tags are being changed, if any. */
  const [tagging, setTagging] = useState<SessionSummary | null>(null);
  /** The session whose name is being changed, if any. */
  const [naming, setNaming] = useState<SessionSummary | null>(null);
  /**
   * Using an archived session takes it back out of the archive.
   *
   * Archiving evicts, so everything in there is cold; loading one again is a clear enough
   * statement that it is not finished with. Without this it would drop back into a folded
   * group the moment it was unloaded, having just been worked in.
   */
  useEffect(() => {
    unarchive(sessions.all.filter((session) => session.loaded).map((session) => session.sessionId));
  }, [sessions.all, unarchive]);

  const wiki = useWiki(showWiki);
  const changes = useChanges(selectedId);
  const repository = useRepoStatus(selected?.cwd ?? null, panel.open === 'repository');
  const environment = useEnvironment(selected?.cwd ?? null);
  const skills = useDisabledSkills(selectedId);
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
      // something quickly should not begin with choosing a directory. What was set as the
      // default is used, and empty means the home directory as it always did.
      const { sessionId } = await createSession(sessionDefaults(settings));
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
    setIntent(null);
  }, [selectedId]);

  // Nor a help list open over a session nobody asked to read it in. Not remembered per
  // session: it is a reference, so wanting it back is a keypress away.
  useEffect(() => setHelp(null), [selectedId]);


  // Read inside event handlers without making them depend on the selected session.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  /** Read by a shortcut handler registered once, which would otherwise hold the first render's answer. */
  const busyRef = useRef(false);
  busyRef.current = busy;
  /**
   * What each running subagent is called, by its id.
   *
   * Only `subagent.started` names an agent; the events that drive the status line carry the
   * id alone, so the name has to be remembered from the announcement to be shown with the
   * work. Kept for the app's lifetime, which is cheap - a name apiece - and right, since a
   * session returned to later is still the session that delegated them.
   */
  const subagentNames = useRef(new Map<string, string>());

  useTauriEvent(() =>
    onSessionEvent(({ sessionId, event }) => {
      sessions.observe(sessionId, event);
      // Every session's, not just the one on screen: a delegation in a session the reader
      // has looked away from is still work they asked for and may come back to.
      subagents.observe(sessionId, event);

      // The queue belongs to whichever session owns it rather than to the one on screen: a
      // session left running keeps its queue while the reader is elsewhere, and it must be
      // right when they come back. The runtime says only that its queue changed, so this is
      // a prompt to read it again rather than something to apply.
      if (event.type === 'pending_messages.modified') queue.refresh(sessionId);
      // Stopping a turn discards everything behind it, and the runtime does not always
      // announce that as a queue change.
      if (event.type === 'abort') queue.clear(sessionId);

      if (sessionId !== selectedRef.current) return;

      if (event.type === 'assistant.turn_start') setBusy(true);
      // Not `assistant.turn_end`, which is one model round trip: a request that calls tools
      // ends and starts a turn many times over, and clearing the flag in those gaps offered
      // a Send button for a session that was still working.
      if (event.type === 'session.idle' || event.type === 'abort') setBusy(false);
      // When this answer started, which is not the same as when the reader last waited: a
      // queued prompt begins a new answer without the runtime going idle in between (#70).
      setBusySince((current) => clockFrom(event, current));
      // What the agent is up to, which it revises through a turn as the work changes shape.
      // Ephemeral, so this is the only chance to see it: it is never written to the log.
      // A subagent's is named after it, since while one runs its tool calls are the only
      // ones there are and the line would otherwise report its work as the session's.
      const named = subagentNameIn(event);
      if (named && event.agentId) subagentNames.current.set(event.agentId, named);
      const said = intentOf(event, event.agentId ? subagentNames.current.get(event.agentId) : undefined);
      if (said) setIntent(said);
      // A new answer, so the tool the last one ended on is no longer what is happening.
      if (event.type === 'user.message' || event.type === 'session.idle' || event.type === 'abort') {
        setIntent(null);
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
      // And the same for the mode, which /autopilot or a terminal can change from under us.
      mode.observe(event);
      // And the same for the window's occupancy, which a finished reply or a compaction
      // moves without either being something this app asked for.
      contextUsage.observe(event);

      /**
       * The status line under the composer is driven by the description attached to each
       * tool call, and while a subagent is working those are the only tool calls there are,
       * so every observer above has to see them. What does not belong in the conversation
       * is dropped by the transcript itself (#11).
       */
      transcript.push(event);
    }),
  );

  useTauriEvent(() =>
    onSessionLoaded(({ sessionId, loaded, loading }) => {
      sessions.observeLoaded(sessionId, loaded, loading);

      // The queue lives in the session that was let go, so nothing is waiting any more.
      if (!loaded) queue.clear(sessionId);
      /**
       * A session let go takes its delegations with it.
       *
       * Their work was only ever held here - nothing was read from disk to build it - so an
       * entry outliving its session would offer a transcript this app can no longer produce.
       *
       * Only this session's view is closed. Any session ageing out used to throw the reader
       * out of whatever delegated task they were reading, and since the idle timer fires at
       * ten minutes, reading one for long enough was itself the trigger.
       */
      if (!loaded) {
        subagents.forget(sessionId);
      }

      // A session that is awake knows about a few commands the runtime at large does not,
      // and a server is already running to ask, so this costs nothing to take.
      slash.observe(loaded, sessionId);

      // Waking one is what gives it a window to measure, and letting it go takes the
      // measurement with it. Only for the session on screen, since that is the only meter.
      if (sessionId === selectedRef.current) contextUsage.observeLoaded(loaded);
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
        if (panel.open === 'changes' && sessionId === selectedId) changes.load();
        // The agent editing files is the main thing that changes what git would say, and
        // the app already knows when it happened - so the panel does not need a timer.
        if (panel.open === 'repository' && sessionId === selectedId) repository.refresh();
      }),
    [panel.open, selectedId, changes.load, repository.refresh],
  );



  /** Everything that was waiting on the runtime, stood down because it will not answer. */
  const standDown = useCallback(() => {
    setBusy(false);
    setResuming(null);
    prompts.clear();
  }, [prompts.clear]);

  /** A replacement knows nothing the old one was told, so the list is read again. */
  const afterRestart = useCallback(() => {
    setError(null);
    standDown();
    sessions.refresh();
  }, [standDown, sessions.refresh]);

  const runtime = useRuntimeHealth(standDown, afterRestart);

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

        if (shortcut === 'larger' || shortcut === 'smaller' || shortcut === 'reset-size') {
          // Straight to the setting, which is the one place the size lives. The keyboard
          // and the settings window are two ways to the same value rather than two values.
          const scale =
            shortcut === 'larger'
              ? clampScale(settings.scale + STEP)
              : shortcut === 'smaller'
                ? clampScale(settings.scale - STEP)
                : 1;
          applySettings({ scale });
          return;
        }

        if (shortcut === 'sidebar') {
          width.toggle();
          return;
        }

        if (shortcut === 'reasoning') {
          setDisplay('showReasoning', !display.showReasoning);
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
      [interrupt, drafts, settings.scale, applySettings, width],
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
    panel.show('changes');
    changes.load();
    toComposer();
  }

  function closeChanges() {
    panel.hide();
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
    panel.show('environment');
    void environment.load();
    toComposer();
  }

  function closeEnvironment() {
    panel.hide();
    toComposer();
  }

  /**
   * Turn an MCP server on or off, then read the panel again so it shows what is now true.
   *
   * The runtime keeps the disabled list, not this app, so there is nothing here to update
   * optimistically - the next read is the only account of what took.
   */
  async function toggleMcp(name: string, enabled: boolean) {
    setError(null);
    try {
      await setMcpEnabled(name, enabled);
      await environment.load();
    } catch (e: unknown) {
      setError(explain(e));
    }
  }

  /**
   * Answer `/tag`, which either names one or opens the picker.
   *
   * An argument acts and no argument asks, which is the shape every other command with an
   * optional argument already has. Tagging is a toggle, so the same line both adds and
   * removes and the reply says which it was: the header and the sidebar are both a long way
   * from the composer, and a change with no acknowledgement reads as nothing happening.
   */
  function tagFromCommand(sessionId: string, argument: string) {
    const tag = normalise(argument);
    if (!tag) {
      // Only the picker needs the whole session; naming a tag needs nothing but the id.
      const session = sessions.find(sessionId);
      if (session) setTagging(session);
      return;
    }

    const had = (tags[sessionId] ?? []).includes(tag);
    toggleTag(sessionId, tag);
    transcript.showLocal('command.output', {
      text: had ? `Removed the tag ${tag} from this session.` : `Tagged this session ${tag}.`,
    });
  }

  /**
   * Answer `/usage` in the transcript, where the CLI puts it.
   *
   * A row rather than a panel: it is a handful of figures that are read once and scrolled
   * past, and it belongs in the record beside the question that asked for it. Nothing is
   * resumed to produce it - a cold session is read from its log.
   */
  async function showUsage(sessionId: string) {
    transcript.showSent(`/${USAGE.name}`);
    try {
      transcript.showLocal('command.output', { text: usageReport(await sessionUsage(sessionId)), markdown: true });
    } catch (e: unknown) {
      transcript.showLocal('command.failed', { text: messageOf(e) });
    }
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
    const what = dispatch(prompt, commands);

    if (what.kind === 'local') {
      drafts.clear(selectedId);
      setError(null);
      // Which one it is decides what opens. There is no default: an unhandled local
      // command would silently do whatever the last branch happened to do.
      if (what.command.name === CHANGES.name) openChanges();
      else if (what.command.name === ENVIRONMENT.name) openEnvironment();
      else if (what.command.name === USAGE.name) void showUsage(selectedId);
      else if (what.command.name === WIKI.name) setShowWiki(true);
      else if (what.command.name === TAG.name) tagFromCommand(selectedId, what.input);
      else if (what.command.name === GIT.name) {
        panel.show('repository');
        repository.refresh();
      } else setHelp('full');
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
          (near.length > 0 ? ` Did you mean ${near.join(', ')}?` : ' Type / to see all commands.'),
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

    /**
     * A command that wants a directory is answered with a window rather than a usage line.
     *
     * A path is the one argument a keyboard is bad at: it is long, it is easy to mistype,
     * and the runtime only finds out at the end. `/add-dir` with nothing after it fails
     * outright, so there is nothing to lose by asking; `/cwd` with nothing after it reports
     * where the session is, which is worth keeping, so that one has to be asked for by name.
     */
    let argument = input;
    if (wantsDirectory(command, input)) {
      let picked: string | string[] | null;
      try {
        await revealPointerForPicker();
        picked = await pickFolder({ directory: true, title: `Choose a directory for /${command.name}` });
      } catch (e: unknown) {
        transcript.showLocal('command.failed', { text: messageOf(e) });
        return;
      }

      // Dismissing the picker abandons the command. The draft stays, so the line that was
      // typed is still there to edit rather than having to be typed again.
      if (typeof picked !== 'string') return;
      argument = picked;
    }

    const typed = argument ? `/${command.name} ${argument}` : `/${command.name}`;

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
      const outcome = await invokeCommand(sessionId, command.name, argument || undefined);

      /**
       * The runtime says when a command changed settings, so the panel showing them can
       * stop being wrong (#168).
       *
       * Only while it is open: it re-reads on every open anyway, so refreshing a panel
       * nobody is looking at would be work for an answer that is thrown away.
       */
      if (outcome.settingsChanged && panel.open === 'environment') void environment.load();

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
  const history = useMemo(
    () => promptHistory(transcript.events, display.commandHistoryMaxSize),
    [transcript.events, display.commandHistoryMaxSize],
  );

  // What each session is doing, for the sidebar. Joined here because the three sources sit
  // apart - the runtime reports turns, the prompts hold unanswered questions, the queue is
  // its own.
  const activity = useMemo(
    () =>
      activityOf(
        sessions.working,
        prompts.blocking,
        Object.fromEntries(Object.entries(queue.queues).map(([id, waiting]) => [id, waiting.length])),
        sessions.loading,
      ),
    [sessions.working, prompts.blocking, queue.queues, sessions.loading],
  );

  useTaskbar(sessions.working.size > 0, display.taskbarPresence);

  /** Sessions stopped on a question, for the fold control to mark while the sidebar is away. */
  const waitingCount = useMemo(
    () => Object.values(activity).filter((mark) => mark.state === 'blocked').length,
    [activity],
  );

  /** The session waiting on an answer to "really delete this?". */
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  /** Whether the settings window is open. */
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * Delete a session, and leave it if it was the one open.
   *
   * Out of the list before the CLI is asked, rather than after it answers. Removing a large
   * session is a gigabyte of event log and thousands of snapshot blobs, and nobody who has
   * just confirmed a deletion wants to watch the row sit there while that happens. It goes
   * back if the delete fails, which is the only case where it still exists.
   *
   * Leaving the session first for the same reason: the transcript would otherwise go on
   * asking for a log that is being removed underneath it.
   */
  const removeSession = useCallback(
    (target: SessionSummary) => {
      if (target.sessionId === selectedId) setSelectedId(null);
      sessions.drop(target.sessionId);

      deleteSession(target.sessionId)
        .then(() => sessions.refresh())
        .catch((e: unknown) => {
          sessions.restore(target.sessionId);
          setError(explain(e));
        });
    },
    [selectedId, sessions],
  );

  /**
   * The commands the menu offers, with the tags there are folded in as arguments to `/tag`.
   *
   * Not in `useCommands` with the fixed choices: these change as sessions are tagged and
   * depend on which one is open, so they cannot be baked into the command the way
   * `/session id` is.
   */
  const commands = useMemo(
    () => withTagChoices(slash.commands, knownTags, selectedId ? (tags[selectedId] ?? []) : []),
    [slash.commands, knownTags, tags, selectedId],
  );

  const sessionMenu = useCallback(
    (session: SessionSummary) =>
      sessionActions(session, {
        favourites,
        toggleFavourite,
        archived,
        rename: setNaming,
        tag: setTagging,
        // Archiving is a decision that the session is finished with, so it also stops paying
        // for it: keeping one resumed while hiding it from view is the memory cost this app
        // exists to avoid (#101).
        toggleArchived: (sessionId) => {
          const putting = !archived.includes(sessionId);
          toggleArchived(sessionId);
          if (putting) evictSession(sessionId).then(() => sessions.refresh()).catch(() => undefined);
        },
        working: sessions.working,
        load: (sessionId) => {
          loadSession(sessionId)
            .then(() => sessions.refresh())
            .catch((e: unknown) => setError(explain(e)));
        },
        unload: (sessionId) => {
          evictSession(sessionId)
            .then(() => sessions.refresh())
            .catch((e: unknown) => setError(explain(e)));
        },
        copy: (text) => void copyText(text),
        // Not explained: these translations are about the Copilot runtime, and a path that
        // happens to contain "copilot" would be read as the CLI failing to start.
        openDirectory: (path) => void openPath(path).catch((e: unknown) => setError(messageOf(e))),
        remove: (target) => (settings.confirmDelete ? setDeleting(target) : void removeSession(target)),
      }),
    [favourites, toggleFavourite, archived, toggleArchived, sessions, settings.confirmDelete, removeSession],
  );

  return (
    <div className={width.dragging ? 'app resizing' : 'app'}>
      <Sidebar
        sessions={sessions.all}
        selectedId={selectedId}
        onSelect={open}
        onCreate={() => void handleCreate()}
        onWiki={() => setShowWiki(true)}
        onSettings={() => setSettingsOpen(true)}
        creating={creating}
        maxLoaded={sessions.maxLoaded}
        activity={activity}
        subagents={subagents.watched}
        selectedSubagentId={subagents.openId}
        onSelectSubagent={(agentId) => {
          // A delegated task belongs to the conversation that delegated it, so opening one
          // moves the sidebar there: leaving the previous session marked would say the
          // reader is somewhere they are not.
          const entry = subagents.find(agentId);
          if (entry) open(entry.sessionId);
          subagents.setOpenId(agentId);
        }}
        favourites={favourites}
        archived={archived}
        tags={tags}
        onFavourite={toggleFavourite}
        actionsFor={sessionMenu}
        onToggle={width.toggle}
        onDismissSubagent={(agentId) => {
          subagents.dismiss(agentId);
        }}
      />

      <SidebarGrip
        dragging={width.dragging}
        onStart={width.start}
        onNudge={width.nudge}
        onReset={width.reset}
      />

      {/* The sidebar takes its own control with it, so the way back is drawn here instead,
          at the corner the reader was already looking at. */}
      {width.hidden && <SidebarToggle hidden waiting={waitingCount} onToggle={width.toggle} />}

      <main className="main">
        {/* Nothing here works once the sidecar is gone, so it says so instead of showing
            a transcript that can no longer be added to. One child, like the other
            branches: .main assigns its rows by position. */}
        {runtime.stopped ? (
          <div className="placeholder">
            <p className="error">{runtime.stopped}</p>
          </div>
        ) : showWiki ? (
          /* The local knowledge base, which belongs to no session and so replaces the
             whole pane rather than sitting under one. */
          <Wiki
            pages={wiki.pages}
            where={wiki.where}
            page={wiki.page}
            loading={wiki.loading}
            failed={wiki.failed}
            saving={wiki.saving}
            draft={wiki.draft}
            unsaved={wiki.unsaved}
            onEdit={wiki.edit}
            onRevert={wiki.revert}
            onSave={(path) => void wiki.save(path)}
            onCreate={() => void wiki.create()}
            query={wiki.query}
            onQuery={wiki.setQuery}
            results={wiki.results}
            onOpen={wiki.go}
            onBack={wiki.back}
            onForward={wiki.forward}
            canGoBack={wiki.canGoBack}
            canGoForward={wiki.canGoForward}
            trail={wiki.trail}
            onClose={() => setShowWiki(false)}
          />
        ) : subagents.open ? (
          /* A subagent's own transcript, in place of the session that delegated it.
             Read-only: whether one can be spoken to at all is an open question about the
             runtime rather than a decision this app has made (#179). */
          <>
            <header className="main-header">
              <h1>{subagents.open.name}</h1>
              <div className="header-row">
                <button type="button" className="changes-action" onClick={subagents.close}>
                  Back to the session
                </button>
                <span className="session-meta">
                  {subagents.open.outcome === undefined
                    ? 'working'
                    : subagents.open.outcome === 'failed'
                      ? 'failed'
                      : 'finished'}
                </span>
              </div>
            </header>

            {/* The row .main reserves for notices. Empty here, but present: the grid assigns
                its rows by position, and a branch one child short puts the transcript where
                the notices go and the footer where the transcript belongs. Unnamed, since
                nothing draws it - it is the space itself that matters. */}
            <div />

            {/* Paged like any other transcript, by what a screenful costs to draw. Nothing
                to fetch behind it - a watched task's events are all already held - so it
                needs no older page, only the window the transcript keeps for itself. */}
            <Transcript
              events={subagents.open.events}
              sessionId={subagents.open.agentId}
              cwd={selected?.cwd ?? null}
              ofAgent={subagents.open.agentId}
              display={display}
            />

            <div className="footer">
              <p className="changes-note">
                Read-only. Recorded by the session that delegated it.
              </p>
            </div>
          </>
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
                <HeaderTags tags={tags[selected.sessionId] ?? []} onEdit={() => setTagging(selected)} />
                <div className="header-controls">
                  {/* Reads files rather than starting a session, so it costs nothing until
                      it is asked for - and then costs enough to be worth asking for. */}
                  <button
                    type="button"
                    className={panel.open === 'changes' ? 'header-button on' : 'header-button'}
                    onClick={() => (panel.open === 'changes' ? closeChanges() : openChanges())}
                    aria-pressed={panel.open === 'changes'}
                    title="Show what this session changed"
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
                    usage={contextUsage.usage}
                    failed={model.failed}
                    onOpen={model.refresh}
                    onChoose={model.choose}
                  />
                </div>
              </div>
            </header>

            {/* Always rendered, even when empty: .main assigns rows by position, so a
                child that comes and goes moves the transcript into another row. */}
            <div>
              {error && <p className="error">{error}</p>}
              {/* Said on arrival rather than on the first message. A session whose history
                  is gone draws an empty transcript, which is exactly what a new one looks
                  like - so without this the only way to find out is to write a prompt and
                  have it refused (#196). */}
              {!transcript.reopenable && (
                <p className="error">
                  This session cannot be reopened. Its history is incomplete. What remains is shown below.
                </p>
              )}
            </div>

            <Transcript
              events={transcript.events}
              sessionId={selected.sessionId}
              cwd={selected.cwd}
              abandoned={transcript.abandoned}
              hasOlder={transcript.hasOlder}
              loadingOlder={transcript.loadingOlder}
              onLoadOlder={transcript.loadOlder}
              extraPages={transcript.extraPages}
              onDropOlder={transcript.dropOlder}
              display={display}
            />

            <div className="footer">
              {/* Above the composer and below everything else, because that is where the
                  CLI puts it and where someone typing is already looking. */}
              {help && (
                <Shortcuts commands={help === 'full' ? commands : undefined} onClose={() => setHelp(null)} />
              )}

              {panel.open === 'changes' && (
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

              {panel.open === 'repository' && (
                <Repository
                  status={repository.status}
                  loading={repository.loading}
                  cwd={selected.cwd}
                  diffs={repository.diffs}
                  onDiff={repository.diff}
                  busy={repository.busy}
                  onStage={(path, staged) => void repository.stage(path, staged)}
                  onCommit={(message, amend) => void repository.commit(message, amend)}
                  committing={repository.committing}
                  onSync={(direction, strategy) => void repository.sync(direction, strategy)}
                  syncing={repository.syncing}
                  diverged={repository.diverged}
                  onDismissDiverged={repository.dismissDiverged}
                  // Written where the CLI keeps it, so the terminal stops asking too.
                  onRememberStrategy={(strategy) => {
                    void writeCliSettings({ mergeStrategy: strategy }).catch(() => undefined);
                  }}
                  branches={repository.branches}
                  onBranches={() => void repository.readBranches()}
                  onSwitch={(name, create) => void repository.switchTo(name, create)}
                  switching={repository.switching}
                  failed={repository.failed}
                  onRefresh={repository.refresh}
                  onClose={() => {
                    panel.hide();
                    toComposer();
                  }}
                />
              )}

              {panel.open === 'environment' && (
                <Environment
                  environment={environment.environment}
                  loading={environment.loading}
                  failed={environment.failed ?? skills.failed}
                  onReload={() => void environment.load()}
                  onClose={closeEnvironment}
                  disabledSkills={skills.disabled}
                  onToggleSkill={selectedId ? (name, enabled) => void skills.toggle(name, enabled) : undefined}
                  onToggleMcp={(name, enabled) => void toggleMcp(name, enabled)}
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

              {prompts.mine.plans.map((pending) => (
                <PlanPrompt
                  key={pending.requestId}
                  pending={pending}
                  onResolve={(approved, selectedAction, feedback) =>
                    prompts.answerPlan(pending, approved, selectedAction, feedback)
                  }
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
                commands={commands}
                cwd={selected.cwd}
                onCommandsNeeded={slash.open}
                mode={mode.mode}
                onCycleMode={mode.cycle}
                intent={intent}
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

      {/* Fixed rather than placed, so it can appear over whichever branch is showing
          without becoming a row in the grid: .main and .app both assign by position, and a
          child that comes and goes would move everything under it.

          Development only - `onSidecarBehind` has nothing to listen to in a packaged app,
          where the sidecar was built alongside the window and cannot drift from it. */}
      {runtime.behind && (
        <div className="behind-bar" role="status">
          <span>{runtime.behind}</span>
          <button
            type="button"
            className="changes-action primary"
            disabled={runtime.rebuilding}
            onClick={runtime.rebuild}

          >
            {runtime.rebuilding ? 'Rebuilding…' : 'Rebuild and restart'}
          </button>
          <button type="button" onClick={runtime.dismiss} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {naming && (
        <RenamePrompt
          current={naming.title ?? ''}
          onRename={(name) => {
            renameSession(naming.sessionId, name)
              .then(() => sessions.refresh())
              .catch((e: unknown) => setError(explain(e)));
          }}
          onClose={() => setNaming(null)}
        />
      )}

      {tagging && (
        <TagPicker
          title={tagging.title ?? 'Untitled session'}
          held={tags[tagging.sessionId] ?? []}
          known={knownTags}
          onToggle={(tag) => toggleTag(tagging.sessionId, tag)}
          onRetire={retireTag}
          onClose={() => setTagging(null)}
        />
      )}

      {deleting && (
        <Confirm
          title="Delete this session?"
          body={
            <>
              <p>
                <strong>{deleting.title ?? 'Untitled session'}</strong> and everything it wrote will be removed:
                the whole conversation, its checkpoints, and the snapshots that let its file changes be
                rewound.
              </p>
              <p>Nothing it did to your files is undone, and this cannot be reversed.</p>
            </>
          }
          confirmLabel="Delete session"
          remember="Do not ask again"
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) applySettings({ confirmDelete: false });
            removeSession(deleting);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
      {settingsOpen && (
        <SettingsWindow
          settings={settings}
          onSave={applySettings}
          onClose={() => setSettingsOpen(false)}
          models={model.models}
          onNeedModels={model.refresh}
          binned={bin.binned}
          onNeedBin={bin.refresh}
          onRestore={bin.restore}
          onPurge={bin.purge}
          usage={disk.usage}
          usageReading={disk.reading}
          onNeedUsage={disk.refresh}
          // Closing the window on the way, since the session is behind it and a list of
          // sizes is not what somebody wants to be looking at once they have chosen one.
          onOpenSession={(sessionId) => {
            open(sessionId);
            setSettingsOpen(false);
          }}
          cli={cliSettings.cli}
          onNeedCli={cliSettings.refresh}
          onWriteCli={(changes) => {
            cliSettings.write(changes);
            // The same file, so what this app draws from it has to move with it.
            takeDisplay(changes);
          }}
          onPickDirectory={async (startingAt) => {
            // The same wake the composer's picker needs: Windows hides the pointer while
            // typing, and a native dialog taking focus with it hidden is hard to aim at.
            await revealPointerForPicker();
            const picked = await pickFolder({
              directory: true,
              title: 'Choose a working directory',
              // Opens where the setting already points, so it starts near the last answer
              // rather than at the top of the disk.
              ...(startingAt ? { defaultPath: startingAt } : {}),
            });
            return typeof picked === 'string' ? picked : null;
          }}
        />
      )}
    </div>
  );
}

function describeError(event: TranscriptEvent): string {
  const data = event.data as { message?: unknown } | null;
  return typeof data?.message === 'string' ? explain(data.message) : 'Session error';
}












