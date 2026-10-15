import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as pickFolder, save as saveFile } from '@tauri-apps/plugin-dialog';

import type {
  Attachment,
  RewindResult,
  SessionMatch,
  SessionPrompt,
  SessionSummary,
  SlashCommand,
  TranscriptEvent,
} from '../shared/protocol';

import { Changes } from './components/Changes';
import { Todos } from './components/Todos';
import { Composer } from './components/Composer';
import { ElicitationPrompt } from './components/ElicitationPrompt';
import { PromptPicker } from './components/PromptPicker';
import { Environment } from './components/Environment';
import { Repository } from './components/Repository';
import { Subagents } from './components/Subagents';
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
import { Transcript, type FoldAll } from './components/Transcript';
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
  sendMessage,
  evictSession,
  loadSession,
  renameSession,
  deleteSession,
  forkSession as fork,
  locateMoment,
  locateTurn,
  writeCliSettings,
  stashPaste,
  classifyDropped,
  exportSession,
  exportSize,
  importSession,
} from './lib/sidecar';
import { CHANGES, ENVIRONMENT, GIT, MCP, REWIND, TAG, USAGE, WIKI, readMcpCommand, readRewindCommand, SUBAGENTS, queuesBehindTurn, wantsDirectory, withModelChoices, withRewindChoices, withTagChoices } from './lib/localCommands';
import { copyText } from './lib/clipboard';
import { sessionActions } from './lib/sessionActions';
import { useArchived } from './lib/useArchived';
import { normalise, useTags } from './lib/useTags';
import { TagPicker } from './components/TagPicker';
import { RenamePrompt } from './components/RenamePrompt';
import { HeaderTags } from './components/HeaderTags';
import { HeaderNotes } from './components/HeaderNotes';
import { sessionDefaults, useSettings } from './lib/useSettings';
import { useRecycleBin } from './lib/useRecycleBin';
import { useDiskUsage } from './lib/useDiskUsage';
import { useMcp } from './lib/useMcp';
import { useCliSettings } from './lib/useCliSettings';
import { useCliDisplay } from './lib/useCliDisplay';
import { SettingsWindow } from './components/SettingsWindow';
import { usePanel } from './lib/usePanel';
import { Confirm } from './components/Confirm';
import { SidebarGrip } from './components/SidebarGrip';
import { NotesGrip } from './components/NotesGrip';
import { SessionNotes } from './components/SessionNotes';
import { SidebarToggle } from './components/SidebarToggle';
import { useSidebarWidth } from './lib/useSidebarWidth';
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { explain, messageOf } from './lib/errors';
import { revealPointerForPicker } from './lib/nativePicker';
import { usageReport } from './lib/usageReport';
import { activityOf } from './lib/activity';
import { clockFrom, intentOf, subagentNameIn } from './lib/timeline';
import { stashFiles } from './lib/paste';
import { nameOf } from './lib/paths';
import { useFileDrop } from './lib/useFileDrop';
import { useTodos } from './lib/useTodos';
import { usePromptList } from './lib/usePromptList';
import { useUnseen } from './lib/useUnseen';
import { useActiveElsewhere } from './lib/useActiveElsewhere';
import { useMarked } from './lib/useMarked';
import { bulkActions } from './lib/bulkActions';
import { promptHistory } from './lib/promptHistory';
import { useChanges } from './lib/useChanges';
import { useAgentEvents } from './lib/useAgentEvents';
import { agentChanges } from './lib/agentChanges';
import { useHasSubagents } from './lib/useHasSubagents';
import { useNativeMenu } from './lib/useNativeMenu';
import { useRewind } from './lib/useRewind';
import { countLines, humanSize, placeholder, worthCollapsing, worthWriting, written } from './lib/longPaste';
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
import { type WatchedSubagent, useSubagents } from './lib/useSubagents';
import { useWiki } from './lib/useWiki';
import { useWikiNotes } from './lib/useWikiNotes';
import { useNotesWidth } from './lib/useNotesWidth';
import { useNotesColumn } from './lib/useNotesColumn';
import { useWikiTags } from './lib/useWikiTags';
import { useOnScreen } from './lib/useOnScreen';
import { useSessionPreviews } from './lib/useSessionPreviews';
import { dispatch } from './lib/slash';
import { usePrompts } from './lib/usePrompts';
import { useQueue } from './lib/useQueue';
import { useSessions } from './lib/useSessions';
import { useShortcuts } from './lib/useShortcuts';
import { readOverrides, resolveBindings } from './lib/bindings';
import { useKeying } from './lib/useKeying';
import { focusRegion, focusToggle, inSidebar, stepRegion } from './lib/regions';
import { useTaskbar } from './lib/useTaskbar';
import { useTranscript } from './lib/useTranscript';
import { useTreeState } from './lib/useTreeState';
import { useTauriEvent } from './lib/useTauriEvent';
import './App.css';

/** Where showing the model's thinking is remembered, so ctrl+t survives a restart. */

/** One array, so a render with no subagent open does not look like a change. */
const EMPTY_EVENTS: TranscriptEvent[] = [];

export default function App() {
  // The webview's own menu belongs to text and nowhere else, and nothing has to opt out of
  // it because nothing is opted in (#226).
  useNativeMenu();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Whether the knowledge base is being read instead of a session.
   *
   * A destination rather than a panel over a session: it belongs to no session, is read for
   * minutes at a time, and wants the width. Kept beside the selected session so closing it
   * returns to where the reader was.
   */
  const [showWiki, setShowWiki] = useState(false);
  /**
   * The pages the wiki was opened for, when it was opened from a session's note count (#35).
   *
   * Held here rather than inside the browser because it is a fact about why the browser was
   * opened, which the browser itself cannot know.
   */
  const [wikiScope, setWikiScope] = useState<readonly string[] | null>(null);
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

  /**
   * Where the transcript should open, and what sent it there.
   *
   * Held against the session it belongs to so a cursor into one log cannot be used to open
   * another, which would read a page from the middle of an unrelated conversation. The words
   * come along so the page can say which part of it was being looked for.
   */
  const [jump, setJump] = useState<{ sessionId: string; cursor: number; words: string; at: number } | null>(null);

  // Up here rather than with the other hooks, because arriving at a session closes the
  // delegated task being read and the three functions that do so are just below.
  const subagents = useSubagents();

  /**
   * Put the keyboard back where someone is going to type.
   *
   * A button in the header takes focus when it is clicked and has nowhere to give it back
   * to, so the next keystroke goes to the button rather than into the message. Bumped
   * rather than set, since returning focus twice to the same session is a real request.
   *
   * Declared here rather than beside the rest of the composer's state because opening a
   * session reaches for it, and a const read from a callback built further up the render is
   * a const read before it exists.
   */
  const [focusAt, setFocusAt] = useState(0);
  const toComposer = useCallback(() => setFocusAt((n) => n + 1), []);

  /**
   * Show a session, at a cursor when one was worked out for it.
   *
   * The part every way of arriving has in common. What differs is only how the cursor was
   * arrived at - searched for, or known - and that is the caller's business rather than
   * this one's.
   */
  const show = useCallback(
    (sessionId: string, cursor: number | null, session?: SessionSummary, words?: string) => {
      // Stamped so that asking for the same result again, in the session already open, is a
      // fresh arrival rather than the one already being shown.
      setJump(cursor === null ? null : { sessionId, cursor, words: words ?? '', at: Date.now() });
      setSelectedId(sessionId);
      setOffList(session ?? null);
      // Choosing a session is asking for that conversation, including the one whose delegated
      // task is being read: the subagent view would otherwise be a room with one door.
      subagents.close();
      // The wiki is somewhere else entirely, and a session chosen while reading it is a
      // request to go back to work.
      setShowWiki(false);
    },
    [subagents],
  );

  const open = useCallback(
    async (sessionId: string, session?: SessionSummary, found?: SessionMatch, words?: string) => {
      // Asked for while already being read, which is a request to get on with it rather than
      // to go anywhere: the composer is keyed on the session, so nothing about this arrival
      // would otherwise move the keyboard and Enter on the row would look like a dead key.
      const already = sessionId === selectedRef.current;

      /**
       * Where to open, worked out before opening rather than after.
       *
       * Opening first and moving afterwards reads the end of the log, draws it, and then
       * throws it away for the page that was actually asked for - which the reader sees as a
       * session arriving and then leaving. Worse, the words were looked for in that first
       * page and found or given up on there, so by the time the right one arrived the search
       * had already been answered against the wrong conversation.
       *
       * Costs a read of a few dozen kilobytes, because the log is halved rather than
       * scanned: measured at 9 to 92 milliseconds on logs up to 609 MB.
       */
      const at = found ? await locateTurn(sessionId, found.source).catch(() => null) : null;

      show(sessionId, at, session, words);
      if (already) toComposer();
    },
    [show, toComposer],
  );

  /**
   * Go to the turn that delegated a task (#225).
   *
   * The task knows when it began, and the log is ordered by time, so the turn that sent it
   * is whatever sits immediately before that moment - no index and no search, just the read
   * that opening at a search result already does.
   *
   * A cursor points at where the next thing begins and the page is what came before it, so
   * asking for the moment the task started puts the call that started it at the end of the
   * page, with the conversation that led to it above.
   */
  const showDelegation = useCallback(
    async (entry: WatchedSubagent) => {
      const at = entry.startedAt ? await locateMoment(entry.sessionId, entry.startedAt).catch(() => null) : null;

      show(entry.sessionId, at);
    },
    [show],
  );

  const transcript = useTranscript(selectedId, setError, jump?.sessionId === selectedId ? jump.cursor : null);
  /**
   * The prompts of the open session, for the header's list to navigate by (#96).
   *
   * Keyed on how many events are loaded, which is what moves when the session says anything,
   * so a list opened after a reply is read again rather than being the one from before it.
   */
  const promptList = usePromptList(selectedId, transcript.events.length);

  /**
   * Go to a prompt, the same way the app already goes to a delegation or a search result.
   *
   * A cursor points at where the next thing begins and the page is what came before it, so
   * asking for the moment just after the prompt puts the prompt at the end of the page with
   * the conversation that led to it above - which is the wrong end to read from. The moment
   * of the prompt itself is asked for instead, so it lands at the end of the page and what
   * it produced is what loads next.
   */
  const goToPrompt = useCallback(
    async (prompt: SessionPrompt) => {
      if (!selectedId) return;

      promptList.went(prompt.at);
      const at = await locateMoment(selectedId, prompt.at).catch(() => null);
      show(selectedId, at);
    },
    [selectedId, promptList, show],
  );  const tree = useTreeState(selected?.cwd ?? null);
  const queue = useQueue();
  /**
   * The queued message being rewritten, if any, and the draft it displaced.
   *
   * Rewritten in the composer rather than in the row: the composer already handles several
   * lines and attachments, and the row is a reminder of what is coming rather than a place
   * to write. Keyed by session, since a message belongs to the one it was meant for and
   * switching away must not carry the edit with it.
   *
   * The displaced draft is held here rather than put in the stash. The stash has one slot
   * and swaps rather than stacks, so borrowing it would throw away whatever was already
   * there - and a key whose job is not to lose writing has no business losing any. Its
   * caret comes with it, so a sentence interrupted to fix a queued message is resumed
   * where it was rather than at its end.
   */
  const [editingQueued, setEditingQueued] = useState<
    Record<string, { id: string; displaced: string; caret: number; files: Attachment[]; known: boolean }>
  >({});
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
  // Up here with the other hooks because the keyboard reads it: Ctrl+= and Ctrl+- change
  // the text size, which is one of these rather than a value of its own.
  const { settings, apply: applySettings } = useSettings();
  const width = useSidebarWidth();
  const { favourites, toggle: toggleFavourite } = useFavourites();
  const { archived, toggle: toggleArchived, unarchive } = useArchived();
  const { tags, known: knownTags, toggle: toggleTag, retire: retireTag } = useTags();
  /**
   * What the sessions on screen last said, and which rows those are (#240).
   *
   * Watched rather than assumed: the sidebar draws every row it has, so a list of two
   * hundred would otherwise mean two hundred log reads for the twenty anybody can see.
   */
  const { watch: watchRow, visible: onScreen } = useOnScreen();
  const previews = useSessionPreviews(onScreen, settings.sidebarPreviewLines);
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

  /**
   * What this session is about that is already written down, for the header to say so (#35).
   *
   * Not gated on the wiki being open, unlike the browser below: the point is to say there
   * is something to find before anybody thinks to look. Reads the session's tags as well as
   * its repository - a session working in a parent folder has no repository worth the name,
   * and its tags are the only thing saying what it is for. Costs one read of the page list
   * and no Copilot process.
   */
  const wikiNotes = useWikiNotes(
    selected?.repository ?? null,
    selected?.cwd ?? null,
    selectedId ? (tags[selectedId] ?? []) : [],
  );

  /**
   * Whether a note is drawn beside the session, and how wide that column is (#35).
   *
   * When it closes is the hook's rule rather than one written here, where nothing could
   * test it. One answer for both the grid and the column, which asked twice could disagree.
   */
  const notes = useNotesColumn(selectedId, wikiNotes, showWiki);
  const notesWidth = useNotesWidth();

  /**
   * One wiki for both the browser and the column, which is what keeps edits safe.
   *
   * A second instance for the column would hold its own drafts, so the same file could have
   * two different unsaved versions and whichever was saved second would silently take the
   * other's work. One place to be, one set of drafts.
   */
  const wiki = useWiki(showWiki || notes.open);
  /**
   * The words the wiki is already written in, for the picker to offer (#35).
   *
   * Read only while the picker is open, which is the one moment they are worth anything.
   * Words refused before are already left out: the hook answers what to offer, so nothing
   * here has to remember what to hide.
   */
  const { tags: offeredWikiTags, dismiss: dismissWikiTag } = useWikiTags(tagging !== null);
  const changes = useChanges(selectedId);
  const rewind = useRewind(selectedId);
  const repository = useRepoStatus(selected?.cwd ?? null, panel.showing('repository'));
  /**
   * What the agent says it is doing, for the session on screen (#172).
   *
   * Not gated on the panel being open, unlike the repository above. The list decides
   * whether there is an entry to open at all - most sessions never make one - so it has to
   * be known before anybody asks. It costs a read of a small file on disk and no process,
   * which is what lets it answer for a session nobody has woken.
   */
  const todos = useTodos(selectedId);

  /**
   * Which sessions some other Copilot has open (#63).
   *
   * Not scoped to the one on screen: the sidebar marks them all, and a session being worked
   * in elsewhere is worth seeing before it is opened rather than after.
   */
  const elsewhere = useActiveElsewhere();

  /**
   * The sessions picked out to be acted on together (#63).
   *
   * Every session there is, rather than the ones on screen: this is what a mark is checked
   * against when the list changes, and a session folded into a collapsed group has not
   * gone anywhere. What a Shift range spans is a different question, answered by the
   * sidebar at the moment of the click, since only it knows the order things are drawn in.
   */
  const listed = useMemo(() => sessions.all.map((session) => session.sessionId), [sessions.all]);
  const { marked, selecting, click: mark, start: startSelecting, clear: clearMarks } = useMarked(listed, selectedId);

  /** Several sessions waiting on one answer about removing them all. */
  const [deletingMany, setDeletingMany] = useState<SessionSummary[] | null>(null);

  /**
   * Write several sessions out, into a folder rather than onto a file (#63).
   *
   * One at a time rather than together: a single archive of four conversations would be a
   * thing only this app could take apart, where four bundles are each the thing import
   * already accepts.
   */
  async function exportMany(chosen: SessionSummary[]) {
    try {
      const folder = await pickFolder({ directory: true, title: `Export ${chosen.length} sessions to…` });
      if (typeof folder !== 'string') return;

      for (const session of chosen) {
        const named = (session.title ?? 'session').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'session';
        await exportSession(
          session.sessionId,
          `${folder}${folder.endsWith('\\') || folder.endsWith('/') ? '' : '\\'}${named}-${session.sessionId.slice(0, 8)}.copilot-session.zip`,
        );
      }

      clearMarks();
      await revealItemInDir(folder).catch(() => undefined);
    } catch (e: unknown) {
      setError(explain(e));
    }
  }
  /**
   * Switching, then reading the tree again.
   *
   * The header indicator and the panel read the repository through different paths, so a
   * switch made in either has to say so to both or one of them goes on naming the branch
   * that was left behind (#102).
   *
   * Git refuses a switch more often than it fails one - a file that differs between the two
   * branches is in the way, and it says so rather than overwriting the work. The panel
   * prints that under its file list, so only a switch made from the header needs telling
   * somewhere, and only when the panel is not already showing it.
   */
  const switchBranch = async (name: string, create: boolean) => {
    const failure = await repository.switchTo(name, create);
    tree.refresh();
    return failure;
  };
  const environment = useEnvironment(selected?.cwd ?? null);
  /**
   * What each MCP server is doing in the session on screen, and changing what they are.
   *
   * Nothing is resumed to find out - connection state is worth seeing, not worth a process.
   * Every change is the same shape because the runtime owns the config rather than this app:
   * do it, then read the panel again, which is the only account of what took (#24).
   */
  const mcp = useMcp(selectedId, environment.load, setError, openUrl);
  const skills = useDisabledSkills(selectedId);
  const prompts = usePrompts(selectedId, setError);
  /**
   * What each session did while the reader was looking at something else (#265).
   *
   * Beside `prompts` because it reads what they are still owed: being blocked is taken from
   * the outstanding prompts rather than remembered, so a question answered from another
   * window stops counting the moment the prompt goes.
   */
  const unseen = useUnseen(selectedId, prompts.blocking);
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
      const listed = await sessions.refresh();
      setSelectedId(sessionId);

      /*
       * A session was made and the list does not have it, which used to be entirely silent:
       * the pane fell back to the empty placeholder and the button returned to what it said
       * before, so making a session looked exactly like making nothing (#227).
       *
       * Said rather than thrown, because the session does exist - it is this window that
       * cannot show it. Null means the list could not be read at all, which has already
       * been reported as itself.
       */
      if (listed && !listed.some((session) => session.sessionId === sessionId)) {
        setError('A session was started, but it is not in the list, so there is nothing to show for it yet.');
      }
    } catch (e: unknown) {
      setError(explain(e));
    } finally {
      setCreating(false);
    }
  }

  /**
   * Decide what a pasted block leaves in the box (#55).
   *
   * Three answers. Most pastes are short and are left exactly where they land. A long one is
   * held, so what is being written stays readable. One too large to be a message is also
   * written to a file, because past a point it is a document - and the agent is better given
   * the path than the wall.
   *
   * A paste going to a file says so from the start rather than being renamed once the write
   * lands. Everything the box needs to say it - the size and which paste it is - is known
   * here, and only the path is not, so naming it by its length first would put a label in
   * the box for long enough to read and then take it away.
   *
   * The write itself is not waited for. A message sent before it lands carries the text,
   * which is what it would have carried anyway, so nothing is ever a reference to a file
   * that is not there yet. If the write fails the box is told, and says what it should have
   * said all along.
   */
  function holdPaste(sessionId: string, text: string): string | null {
    if (!worthCollapsing(text)) return null;

    const lines = countLines(text);
    if (!worthWriting(text)) return placeholder(drafts.hold(sessionId, text, lines), lines);

    const size = humanSize(new TextEncoder().encode(text).length);
    const id = drafts.hold(sessionId, text, lines, size);
    void stashPaste({ sessionId, name: `pasted-${lines}-lines.txt`, data: btoa(unescape(encodeURIComponent(text))) })
      .then((path) => drafts.wroteTo(sessionId, id, path, size))
      // The paste is still held, so this costs the file rather than the text.
      .catch(() => drafts.writeFailed(sessionId, id));

    return written(id, size);
  }

  /**
   * Attach what was dropped on the window (#231).
   *
   * Nothing is copied. A dropped path is attached where it lies, exactly as the picker
   * does it, so this is the same operation reached a different way.
   *
   * The paths are sorted by the sidecar first, since this window cannot read the disk and
   * dropping a folder is an easy thing to do by accident. What cannot be attached is said
   * plainly rather than dropped in silence, which would look like the app ignoring it.
   */
  async function handleDrop(sessionId: string, paths: string[]) {
    try {
      const { files, folders, missing } = await classifyDropped(paths);

      if (files.length > 0) {
        setAttachments((current) => {
          const held = current[sessionId] ?? [];
          // Dropping a file that is already attached says nothing the first drop did not.
          const fresh = files
            .filter((path) => !held.some((file) => file.path === path))
            .map((path): Attachment => ({ type: 'file', path, displayName: nameOf(path) }));

          return fresh.length > 0 ? { ...current, [sessionId]: [...held, ...fresh] } : current;
        });
      }

      const refused = [
        folders.length > 0 ? `${folders.map(nameOf).join(', ')} ${folders.length > 1 ? 'are folders' : 'is a folder'}` : '',
        missing.length > 0 ? `${missing.map(nameOf).join(', ')} could not be read` : '',
      ].filter(Boolean);
      if (refused.length > 0) setError(`Not attached: ${refused.join('; ')}.`);
    } catch (e: unknown) {
      setError(explain(e));
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

  /**
   * Files dragged onto the window, which attach to whichever session is open (#231).
   *
   * Offered only when one is, since with nothing open there is nowhere for a drop to go
   * and an overlay would be promising something the app would then have to refuse.
   */
  const dropping = useFileDrop((paths) => {
    const forSession = selectedRef.current;
    if (forSession) void handleDrop(forSession, paths);
  }, selectedId !== null);
  /** Read by a shortcut handler registered once, which would otherwise hold the first render's answer. */
  const busyRef = useRef(false);
  busyRef.current = busy;

  /** Read the same way and for the same reason: the function is built afresh every render. */
  const createRef = useRef(handleCreate);
  createRef.current = handleCreate;

  /**
   * Show the sidebar if it is away, then put the focus in it.
   *
   * Folded away it draws nothing at all, so there is no row and no filter box to aim at
   * until it has been drawn again - which is a frame later, not now.
   */
  const toSidebar = useCallback(
    (what: 'search' | 'list') => {
      const go = () => focusRegion(what === 'search' ? 'sidebar-search' : 'sidebar');
      if (!width.hidden) {
        go();
        return;
      }

      width.toggle();
      requestAnimationFrame(go);
    },
    [width],
  );

  /**
   * Fold the sidebar away, or bring it back, keeping the keyboard on the control that did it.
   *
   * The two chevrons are different elements - one in the sidebar's header, one holding the
   * corner of the window once there is no header - so folding unmounts the very button that
   * was just pressed. Hiding takes the rows with it as well, so a keyboard anywhere in there
   * would be left on nothing at all.
   */
  const toggleSidebar = useCallback(() => {
    // Only when what is being folded away is where the keyboard already was. Ctrl+B pressed
    // while writing a message is about the view rather than about going anywhere, and moving
    // the focus out of the box would be the opposite of what was asked.
    const following = inSidebar(document.activeElement);
    const away = !width.hidden;

    width.toggle();
    if (!following) return;

    // On the next frame: the control to hand the keyboard to is not drawn yet.
    requestAnimationFrame(() => focusToggle(away));
  }, [width]);

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
      // What a session did while the reader was elsewhere, which is what every surface
      // under #85 has to read. Also every session's, and for the same reason.
      unseen.observe(sessionId, event);

      // The queue belongs to whichever session owns it rather than to the one on screen: a
      // session left running keeps its queue while the reader is elsewhere, and it must be
      // right when they come back. The runtime says only that its queue changed, so this is
      // a prompt to read it again rather than something to apply.
      if (event.type === 'pending_messages.modified') queue.refresh(sessionId);
      // Stopping a turn discards everything behind it, and the runtime does not always
      // announce that as a queue change.
      if (event.type === 'abort') queue.clear(sessionId);

      if (sessionId !== selectedRef.current) return;

      // A server connecting, failing or asking to be signed in to. Only reached for the
      // session on screen, and only ever a prompt to read the list again: the event names
      // one server, and the panel is showing all of them.
      if (
        event.type === 'session.mcp_server_status_changed' ||
        event.type === 'session.mcp_servers_loaded' ||
        event.type === 'session.mcp_oauth_completed'
      ) {
        mcp.reread();
      }

      // The agent wrote to its own todo table. A signal and nothing else - the event
      // carries no payload - so this is a prompt to read the list again rather than
      // anything to apply (#172).
      if (event.type === 'session.todos_changed') todos.changed();

      if (event.type === 'assistant.turn_start') setBusy(true);
      // Not `assistant.turn_end`, which is one model round trip: a request that calls tools
      // ends and starts a turn many times over, and clearing the flag in those gaps offered
      // a Send button for a session that was still working.
      if (event.type === 'session.idle' || event.type === 'abort') setBusy(false);
      // Nothing left to take back once the answer is in: the message has been answered and
      // is part of the record, which is exactly when the runtime stops withdrawing it.
      if (event.type === 'session.idle' || event.type === 'abort') {
        setLastSent(({ [sessionId]: _answered, ...rest }) => rest);
      }
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
        if (panel.showing('changes') && sessionId === selectedId) changes.load();
        // The agent editing files is the main thing that changes what git would say, and
        // the app already knows when it happened - so the panel does not need a timer.
        if (panel.showing('repository') && sessionId === selectedId) repository.refresh();
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

  /**
   * Keep the mouse's affordances out of the way while the keyboard is working.
   *
   * Arrowing through the sidebar scrolls it, which drags rows under a pointer nobody moved.
   */
  useKeying();

  /**
   * The keys as this reader has them, which is not the same as the defaults (#246).
   *
   * Worked out once and handed to all three places that need it - the window's listener, the
   * list a reader can call up, and the composer, which answers two of them itself. Three
   * readers of one setting rather than three parsings of one string.
   */
  const shortcutOverrides = useMemo(() => readOverrides(settings.shortcuts), [settings.shortcuts]);
  const bindings = useMemo(() => resolveBindings(shortcutOverrides), [shortcutOverrides]);

  /**
   * The last request to open or close every fold in the transcript (#135).
   *
   * Held here rather than in the transcript because the key is a window key: it has to work
   * while the composer holds the keyboard, which is whenever a session is open.
   */
  const [folds, setFolds] = useState<FoldAll | null>(null);

  /** When the reader last asked to find words in the session on screen (#209). */
  const [finding, setFinding] = useState<number | null>(null);

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
          toggleSidebar();
          return;
        }

        if (shortcut === 'next-region' || shortcut === 'previous-region') {
          stepRegion(shortcut === 'next-region' ? 1 : -1);
          return;
        }

        if (shortcut === 'go-composer') {
          focusRegion('composer');
          return;
        }

        if (shortcut === 'find-session' || shortcut === 'go-sessions') {
          toSidebar(shortcut === 'find-session' ? 'search' : 'list');
          return;
        }

        if (shortcut === 'new-session') {
          void createRef.current();
          return;
        }

        if (shortcut === 'wiki') {
          // The same key both ways: a reader who opened the wiki to look something up gets
          // back to the session with the key they arrived by, rather than hunting for a way
          // out of a place a single press put them in.
          if (showWiki) {
            setShowWiki(false);
            return;
          }

          setWikiScope(null);
          setShowWiki(true);
          return;
        }

        if (shortcut === 'import') {
          void importFrom();
          return;
        }

        if (shortcut === 'reasoning') {
          setDisplay('showReasoning', !display.showReasoning);
          return;
        }

        if (shortcut === 'fold-all') {
          // Alternating rather than worked out from what is on screen: every fold keeps its
          // own state, so there is nothing here that knows how many of them are open.
          setFolds((was) => ({ open: !(was?.open ?? false), at: (was?.at ?? 0) + 1 }));
          return;
        }

        if (shortcut === 'find-here') {
          // A fresh number each time, which is what takes the keyboard back to the box when
          // the bar is already up rather than opening a second one.
          setFinding((was) => (was ?? 0) + 1);
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
      [interrupt, drafts, settings.scale, applySettings, width, toSidebar, toggleSidebar, showWiki],
    ),
    // The composer's own text, rather than what a key event can be asked about the field it
    // landed in: this is where it is actually kept.
    useCallback(() => drafts.written(selectedRef.current), [drafts]),
    shortcutOverrides,
  );

  /**
   * Where the caret is in each session's box, kept as it moves.
   *
   * Out here because the box itself is not drawn while the agent is waiting on an answer
   * (#75), so it has nowhere of its own to remember it. A ref rather than state: nothing is
   * drawn differently for it, and a render on every arrow key would be a lot of renders.
   */
  const caretIn = useRef<Record<string, number>>({});
  /**
   * The message that started the turn now running, where this app sent it.
   *
   * Kept so it can be taken back: the runtime will withdraw a message only when told the
   * words it was sent with, and only while the model has not answered. Forgotten the moment
   * the session falls idle, since by then it has been answered and is part of the record.
   */
  const [lastSent, setLastSent] = useState<Record<string, { messageId: string; prompt: string }>>({});

  /** Open the panel and read the list, from wherever the request came from. */
  function openChanges() {
    panel.show('changes');
    changes.load();
    toComposer();
  }

  function closeChanges() {
    panel.hide('changes');
    toComposer();
  }

  /**
   * Act on a finished `/rewind` line (#156).
   *
   * Which turn and what to take with it are both chosen from the composer's own menu, so
   * by the time this runs the line says everything. A line that names no turn has asked
   * for the menu rather than for a rewind, and the menu is already open - so it does
   * nothing rather than complaining about an argument nobody was asked for yet.
   */
  function rewindFromCommand(input: string) {
    const asked = readRewindCommand(input, [...rewind.points.values()]);
    if (!asked) return;

    void rewind
      .rewind(asked.point.eventId, asked.files)
      .then((result) => {
        const trouble = rewindTrouble(result);
        if (trouble) setError(trouble);
        // The discarded turns are gone from the log, so what is on screen is no longer
        // what the session holds. Reading it again is the only way to agree.
        else transcript.reload();
      })
      .catch((e: unknown) => setError(explain(e)));
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
    panel.hide('environment');
    toComposer();
  }

  /**
   * Answer `/mcp`, which opens the panel and may open a form on the way.
   *
   * A name that matches nothing is said so rather than quietly doing nothing: typing one is
   * how these are reached from the keyboard, and a typo would otherwise look like a server
   * that had already gone.
   */
  function mcpFromCommand(argument: string) {
    const what = readMcpCommand(argument);

    if (what.kind === 'unknown') {
      transcript.showLocal('command.failed', { text: `/mcp cannot ${what.verb}. Try add, edit or delete.` });
      return;
    }
    if (what.kind === 'needs-name') {
      transcript.showLocal('command.failed', { text: `Usage: /mcp ${what.verb} <server-name>` });
      return;
    }

    // Every arm below ends up looking at the panel, so it opens either way.
    openEnvironment();

    if (what.kind === 'panel') return;
    if (what.kind === 'add') {
      // A name given to `add` fills the form in rather than naming a server to open, which
      // is what the CLI does with it. The panel reads a name it does not know as a new one.
      mcp.edit(what.name ?? '');
      return;
    }

    // Against what the panel is showing rather than the config: a server a plugin brought
    // is listed and is not the reader's to change, and saying so beats a form that cannot
    // save.
    const server = environment.environment?.mcpServers.find((each) => each.name === what.name);
    if (!server) {
      transcript.showLocal('command.failed', {
        text: `Server "${what.name}" not found. Use /mcp add to create it.`,
      });
      return;
    }
    if (!server.editable) {
      transcript.showLocal('command.failed', {
        text: `Cannot edit "${what.name}": it came from ${server.sourcePlugin ?? server.source} rather than your own configuration.`,
      });
      return;
    }

    if (what.kind === 'edit') mcp.edit(what.name);
    else {
      void mcp.remove(what.name);
      transcript.showLocal('command.output', { text: `Deleted the MCP server ${what.name}.` });
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

    /*
     * Rewriting a message that is still waiting, rather than sending a new one (#76).
     *
     * Taken before anything else, because what is in the box is that message: a slash at the
     * front of it is text that was queued, not a command to run now, and emptying the box is
     * the other way of saying the message is no longer wanted.
     */
    const rewriting = editingQueued[selectedId];
    if (rewriting !== undefined) {
      const text = prompt.trim();
      // What the box is carrying now is what the message should carry. Only sent where the
      // message's own files are known: putting one back without them would drop whatever it
      // had, and a message this app did not send cannot say what that was.
      const files = attachments[selectedId] ?? [];
      setEditingQueued(({ [selectedId]: _gone, ...rest }) => rest);
      // Whatever was being written before the edit took the box, given back where it was
      // left: a sentence interrupted to fix a queued message is resumed mid-word if that is
      // where the caret was, carrying whatever it had attached.
      drafts.write(selectedId, rewriting.displaced);
      setAttachments((current) => ({ ...current, [selectedId]: rewriting.files }));
      caretIn.current[selectedId] = rewriting.caret;
      // Asked for, because only a fresh focus applies the caret: the box is not remounting
      // here the way it does when it stands down for a prompt, so without this the words
      // come back and the caret stays at the end of them.
      toComposer();
      if (text) await queue.edit(selectedId, rewriting.id, text, rewriting.known ? files : undefined);
      else await queue.remove(selectedId, rewriting.id);
      return;
    }

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
      else if (what.command.name === WIKI.name) {
        // Opened on its own account rather than about a session, so it shows the whole wiki
        // however it was last narrowed.
        setWikiScope(null);
        setShowWiki(true);
      }
      else if (what.command.name === TAG.name) tagFromCommand(selectedId, what.input);
      else if (what.command.name === MCP.name) mcpFromCommand(what.input);
      else if (what.command.name === REWIND.name) rewindFromCommand(what.input);
      else if (what.command.name === SUBAGENTS.name) setSubagentsFor(selectedId);
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
     * Nothing is echoed here. The queue row is the record of what is waiting, and the
     * runtime writes the conversation's own record when it finally runs.
     */
    if (queuesBehindTurn(command, busy)) {
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
      if (outcome.settingsChanged && panel.showing('environment')) void environment.load();

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

  /**
   * Send a message to the agent.
   *
   * The text sent and the text shown are not always the same: a command that produces a
   * prompt writes something longer than the transcript should carry, and has already put
   * the command that produced it there. Null means it is shown somewhere already.
   */
  async function send(sessionId: string, prompt: string, display: string | null) {
    setError(null);
    drafts.clear(sessionId);
    // What the agent is given, with every held paste put back (#55).
    const whole = drafts.expand(sessionId, prompt, 'sent');
    /*
     * What the conversation shows, which is the message as it was sent rather than as it
     * was typed. The placeholder keeps the box usable while writing; once the message has
     * gone it would only hide what was asked, and a session read back from disk shows the
     * text anyway, so leaving it in would make the same message look like two.
     *
     * A paste written to a file is named rather than shown, since it was written precisely
     * because it is too big to read in a message.
     *
     * Expanded now rather than where it is shown, because one of those places is past the
     * point where the pastes behind it have been let go of.
     */
    const shownText = display === null ? null : drafts.expand(sessionId, display, 'shown');
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
    const shown = !expectQueued && shownText !== null ? transcript.showSent(shownText) : null;
    setBusy(true);

    try {
      const { messageId, queued } = await sendMessage({ sessionId, prompt: whole, attachments: sent });

      // The pastes it carried are gone for good only now. Until the send came back this
      // message could still have been handed to the box to try again (#55).
      drafts.release(sessionId, prompt);

      // Remembered only when it started a turn rather than joining the queue: a queued one
      // is already listed, with its own way of being taken back.
      if (!queued) setLastSent((held) => ({ ...held, [sessionId]: { messageId, prompt: whole } }));

      // The runtime decides, and a turn can end while the message is on its way, so the
      // guess above is reconciled with what actually happened. Nothing is recorded for a
      // queued message: the runtime announces its own queue, and this app reads it.
      if (!queued && expectQueued && shownText !== null) transcript.showSent(shownText);
    } catch (e: unknown) {
      setError(explain(e));
      setBusy(false);

      // Nothing was sent, so nothing should be left saying it was, and the message itself
      // is the reader's: it goes back to the composer with its attachments rather than
      // being lost to an error they may want to read first. Anything typed in the meantime
      // wins, since taking that away to restore an older draft would be the worse theft.
      //
      // As it was typed, placeholders and all - not as it was shown. The pastes behind them
      // are still held, so the box gets back exactly what it had (#55).
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
  /** Whose delegated tasks are being looked through, if any. Not the selected session (#228). */
  const [subagentsFor, setSubagentsFor] = useState<string | null>(null);
  const hasSubagents = useHasSubagents();

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
      unseen.forget(target.sessionId);

      deleteSession(target.sessionId)
        .then(() => sessions.refresh())
        .catch((e: unknown) => {
          sessions.restore(target.sessionId);
          setError(explain(e));
        });
    },
    [selectedId, sessions, unseen.forget],
  );

  /**
   * The commands the menu offers, with the tags there are folded in as arguments to `/tag`.
   *
   * Not in `useCommands` with the fixed choices: these change as sessions are tagged and
   * depend on which one is open, so they cannot be baked into the command the way
   * `/session id` is.
   */
  const commands = useMemo(
    () =>
      withRewindChoices(
        withModelChoices(
          withTagChoices(slash.commands, knownTags, selectedId ? (tags[selectedId] ?? []) : []),
          model.models,
        ),
        [...rewind.points.values()],
      ),
    [slash.commands, knownTags, tags, selectedId, rewind.points, model.models],
  );

  /**
   * Why the rewind menu has nothing in it, when it has nothing in it.
   *
   * Three ways to be empty, and they mean opposite things. Reading the turns resumes the
   * session, so there is a wait before there is a list; a read that failed has no list to
   * offer; a session whose first turn is still running has nowhere to go back to. Drawn
   * apart because a menu that says nothing lets the reader believe whichever they fear.
   */
  const rewindNotice = rewind.loading
    ? 'Reading the conversation.'
    : rewind.failed
      ? `Could not read the turns: ${rewind.failed}`
      : rewind.points.size === 0
        ? 'No turn to go back to yet.'
        : null;

  /**
   * The open subagent's own events, read from the log where the log has them (#178).
   *
   * A hook, so it is asked unconditionally rather than only in the branch that draws the
   * subagent view - which is also why it takes the ids as null when none is open.
   */
  const agentEvents = useAgentEvents(
    subagents.open?.sessionId ?? null,
    subagents.open?.agentId ?? null,
    subagents.open?.events ?? EMPTY_EVENTS,
  );

  /**
   * What the open run changed, from the diffs its own writes reported (#261).
   *
   * Derived from the events already in hand rather than asked for, so it costs nothing and
   * is known before anybody presses anything - which is what lets the button appear only
   * where the run actually wrote something. Most runs never do: the delegated runs in the
   * largest log here are read-only to a one.
   */
  const agentWork = useMemo(() => agentChanges(agentEvents), [agentEvents]);
  const [showAgentChanges, setShowAgentChanges] = useState(false);

  // A different run's files are not this one's, and a panel left open would be showing them.
  useEffect(() => setShowAgentChanges(false), [subagents.open?.agentId]);

  /**
   * Copy a session into a new one and go to the copy.
   *
   * The sidecar opens the source before copying it, and refuses when it cannot: forking a
   * session the CLI is not holding empties the original rather than copying it (#196). So
   * this waits rather than guessing - the new session does not exist until it answers.
   */
  const forkSession = useCallback(
    (target: SessionSummary) => {
      setError(null);
      fork(target.sessionId)
        .then(async (made) => {
          await sessions.refresh();
          setSelectedId(made);
        })
        .catch((e: unknown) => setError(explain(e)));
    },
    [sessions],
  );

  /**
   * Write a session out as a bundle, somewhere the reader chooses (#63).
   *
   * The size is said in the dialog's own title rather than in a message afterwards: the
   * largest conversation here is 287 MB on disk, and that is worth knowing while choosing
   * where to put it rather than once it is already being written.
   */
  async function exportTo(session: SessionSummary) {
    try {
      const { files, bytes } = await exportSize(session.sessionId);
      if (files === 0) {
        setError('That session has nothing in it to export.');
        return;
      }

      const named = (session.title ?? 'session').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'session';
      const toPath = await saveFile({
        title: `Export session (${humanSize(bytes)} before compression)`,
        defaultPath: `${named}-${session.sessionId.slice(0, 8)}.copilot-session.zip`,
        filters: [{ name: 'Session bundle', extensions: ['zip'] }],
      });
      if (typeof toPath !== 'string') return;

      await exportSession(session.sessionId, toPath);
      // Shown rather than announced. A message saying it worked is a message to dismiss;
      // the file sitting selected in its folder is the same news and is already the thing
      // the reader was going to look for.
      await revealItemInDir(toPath).catch(() => undefined);
    } catch (e: unknown) {
      setError(explain(e));
    }
  }

  /**
   * Take a bundle in, and go to what arrived (#63).
   *
   * The list is read again afterwards rather than waiting to be told: an import writes into
   * the session directory, and the watcher that announces a changed list watches only the
   * database.
   */
  async function importFrom() {
    try {
      const picked = await pickFolder({
        title: 'Import a session bundle',
        multiple: false,
        filters: [{ name: 'Session bundle', extensions: ['zip'] }],
      });
      const fromPath = Array.isArray(picked) ? picked[0] : picked;
      if (typeof fromPath !== 'string') return;

      const { sessionId } = await importSession(fromPath);
      await sessions.refresh();
      // No cursor: an imported conversation is being arrived at whole rather than at some
      // particular moment in it.
      show(sessionId, null);
    } catch (e: unknown) {
      setError(explain(e));
    }
  }

  /**
   * What can be done to the marked set, wherever it is asked for (#63).
   *
   * One list for the menu and for the bar above the list, so the two can never offer
   * different things to the same selection.
   */
  const markedActions = useMemo(
    () =>
      bulkActions(
        sessions.all.filter((each) => marked.includes(each.sessionId)),
        {
          archived,
          toggleArchived,
          unload: (sessionId) => {
            evictSession(sessionId)
              .then(() => sessions.refresh())
              .catch((e: unknown) => setError(explain(e)));
          },
          load: (sessionId) => {
            loadSession(sessionId)
              .then(() => sessions.refresh())
              .catch((e: unknown) => setError(explain(e)));
          },
          remove: setDeletingMany,
          exportAll: exportMany,
          done: clearMarks,
        },
      ),
    [sessions, marked, archived, toggleArchived, exportMany, clearMarks],
  );

  const sessionMenu = useCallback(
    (session: SessionSummary) => {
      /**
       * Right-clicking inside a marked set acts on the set (#63).
       *
       * Outside it the marks are not what is being pointed at, so the menu is about the one
       * row as it always was - which also means a marked set is never acted on by accident
       * from somewhere else in the list.
       */
      if (marked.length > 1 && marked.includes(session.sessionId)) return markedActions;

      return sessionActions(session, {
        favourites,
        toggleFavourite,
        archived,
        rename: setNaming,
        tag: setTagging,
        exportTo,
        // Picking over the list rather than reading it: the row is marked and every row
        // grows a box, so the next click adds to the set instead of opening a session.
        select: startSelecting,
        // Archiving is a decision that the session is finished with, so it also stops paying
        // for it: keeping one resumed while hiding it from view is the memory cost this app
        // exists to avoid (#101).
        toggleArchived: (sessionId) => {
          const putting = !archived.includes(sessionId);
          toggleArchived(sessionId);
          if (putting) evictSession(sessionId).then(() => sessions.refresh()).catch(() => undefined);
        },
        working: sessions.working,
        // The session is not switched to. Asking what another session delegated is a
        // question about it rather than a request to go there, and going there would close
        // whatever was being read.
        showSubagents: setSubagentsFor,
        hasNoSubagents: hasSubagents.hasNone,
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
        fork: forkSession,
      });
    },
    [
      favourites,
      toggleFavourite,
      archived,
      toggleArchived,
      sessions,
      settings.confirmDelete,
      removeSession,
      forkSession,
      marked,
      exportMany,
      markedActions,
    ],
  );

  return (
    <div
      className={[
        'app',
        // A drag is on either edge, and both want the same caret everywhere while it runs.
        width.dragging || notesWidth.dragging ? 'resizing' : '',
        // Gives the notes their column. Set here rather than in a second grid rule per
        // branch, so the grid is written once and the class says whether it is in use.
        notes.open ? 'with-notes' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Sidebar
        sessions={sessions.all}
        selectedId={selectedId}
        onSelect={open}
        onCreate={() => void handleCreate()}
        onWiki={() => {
          setWikiScope(null);
          setShowWiki(true);
        }}
        onSettings={() => setSettingsOpen(true)}
        creating={creating}
        maxLoaded={sessions.maxLoaded}
        activity={activity}
        loading={sessions.loading}
        activeElsewhere={elsewhere.active}
        marked={marked}
        selecting={selecting}
        onMark={mark}
        onDoneSelecting={clearMarks}
        selectionActions={markedActions}
        onImport={() => void importFrom()}
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
        showTags={settings.sidebarTags}
        previews={previews}
        previewLines={settings.sidebarPreviewLines}
        onWatchRow={watchRow}
        onFavourite={toggleFavourite}
        actionsFor={sessionMenu}
        onMenuOpened={hasSubagents.check}
        onToggle={toggleSidebar}
        onDismissSubagent={(agentId) => {
          subagents.dismiss(agentId);
        }}
        onKeepSubagent={subagents.keep}
        keepableSubagent={subagents.keepable}
        isKeptSubagent={subagents.isKept}
        subagentActionsFor={(entry) => [
          {
            id: 'keep',
            label: subagents.isKept(entry.agentId) ? 'Stop keeping' : 'Keep',
            // Only once the log holds the work. Keeping one before that would mean holding
            // its events for ever and finding nothing behind it after a restart (#180).
            refused: subagents.keepable(entry.agentId)
              ? undefined
              : 'Not yet: this app is still the only copy of what it did',
            run: () => subagents.keep(entry.agentId),
          },
          {
            id: 'copy-id',
            label: 'Copy agent ID',
            run: () => void copyText(entry.agentId),
          },
          {
            id: 'delegation',
            label: 'Go to the turn that started it',
            // Without the moment it began there is nothing to aim at, and a task watched
            // starting always has one.
            refused: entry.startedAt ? undefined : 'Not known when this one began',
            run: () => void showDelegation(entry),
          },
          {
            id: 'dismiss',
            label: 'Hide',
            // Its work is in the session's log either way, so this loses nothing but the row.
            run: () => {
              subagents.dismiss(entry.agentId);
              if (subagents.openId === entry.agentId) subagents.close();
            },
          },
        ]}
      />

      <SidebarGrip
        hidden={width.hidden}
        dragging={width.dragging}
        onStart={width.start}
        onNudge={width.nudge}
        onReset={width.reset}
      />

      {/* The sidebar takes its own control with it, so the way back is drawn here instead,
          at the corner the reader was already looking at. */}
      {width.hidden && <SidebarToggle hidden waiting={waitingCount} onToggle={toggleSidebar} />}

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
            scope={wikiScope}
            onClearScope={() => setWikiScope(null)}
            onClose={() => setShowWiki(false)}
          />
        ) : subagents.open ? (
          /* A subagent's own transcript, in place of the session that delegated it.
             Read-only: whether one can be spoken to at all is an open question about the
             runtime rather than a decision this app has made (#179). */
          <>
            <header className="main-header">
              <h1>{subagents.open.name}</h1>
              <div className="header-row subagent-head">
                <button type="button" className="changes-action" onClick={subagents.close}>
                  Back to the session
                </button>
                <span className="subagent-state">
                  {subagents.open.outcome === undefined
                    ? 'working'
                    : subagents.open.outcome === 'failed'
                      ? 'failed'
                      : 'finished'}
                </span>
                {/* The same box the session's header puts its controls in, so they sit at
                    the far end rather than crowding the way back out, and in the same order:
                    the changes first and the model last. */}
                <div className="header-controls">
                  {/* Only where the run wrote something. Most never do, and an entry that
                      opens an empty panel is worse than no entry - the rule the session's
                      Todos button already follows (#261). */}
                  {agentWork.changes.length > 0 && (
                    <button
                      type="button"
                      className={showAgentChanges ? 'header-button on' : 'header-button'}
                      onClick={() => setShowAgentChanges((open) => !open)}
                      aria-pressed={showAgentChanges}
                      title="Show what this run changed"
                    >
                      Changes
                    </button>
                  )}
                  {/* Where the session carries its model picker, as a fact rather than a
                      control: the run has already happened, and there is no moving it to
                      another model now. Absent from a few older announcements, and a blank
                      space says that better than a word guessing at it would. */}
                  {subagents.open.model && <span className="subagent-model">{subagents.open.model}</span>}
                </div>
              </div>
            </header>

            {/* The row .main reserves for notices. Empty here, but present: the grid assigns
                its rows by position, and a branch one child short puts the transcript where
                the notices go and the footer where the transcript belongs. Unnamed, since
                nothing draws it - it is the space itself that matters. */}
            <div />

            {/* Paged like any other transcript, by what a screenful costs to draw. Read
                back from the log where it can be, so a delegating session is not holding
                every agent's work for as long as it stays open (#178). */}
            <Transcript
              events={agentEvents}
              sessionId={subagents.open.agentId}
              cwd={selected?.cwd ?? null}
              folds={folds}
              ofAgent={subagents.open.agentId}
              display={display}
              turnSummary={settings.turnSummary}
              onError={setError}
            />

            <div className="footer">
              {showAgentChanges && (
                <Changes
                  changes={agentWork.changes}
                  loading={false}
                  failed={null}
                  diffs={agentWork.diffs}
                  /* Nothing to fetch: the diffs came with the list, out of the same events. */
                  onDiff={() => undefined}
                  cwd={selected?.cwd ?? null}
                  onClose={() => setShowAgentChanges(false)}
                  /* No reviewing a run that has finished, and no span to narrow it to. */
                  reviewedAt={null}
                  showAll
                  onSpan={() => undefined}
                  whose="this run"
                />
              )}
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
                {/* The CLI's footer calls this the directory, and a reader who turned it
                    off there meant it here too (#130). */}
                {display.footer.showDirectory && (
                <SessionPath
          cwd={selected.cwd}
          state={tree.state}
          branches={repository.branches}
          readingBranches={repository.readingBranches}
          switching={repository.switching}
          busy={busy}
          onBranches={() => void repository.readBranches()}
          onSwitch={(name, create) => {
            void switchBranch(name, create).then((failure) => {
              if (failure && !panel.showing('repository')) setError(failure);
            });
          }}
        />
                )}
                <OpenIn
                  cwd={selected.cwd}
                  remote={tree.state?.remote ?? null}
                  branch={tree.state?.branch ?? selected.branch}
                  onError={setError}
                />
                <HeaderTags tags={tags[selected.sessionId] ?? []} onEdit={() => setTagging(selected)} />
                {/* What this session is about that is already written down, where anything
                    is (#35). Beside the tags because it is the same kind of claim about the
                    session - and partly built from them - and silent otherwise. */}
                <HeaderNotes
                  pages={wikiNotes}
                  open={notes.open}
                  onOpen={(page) => {
                    // Closing again from the same control, since it is now a thing that is
                    // open rather than somewhere to go.
                    if (notes.open) {
                      notes.hide();
                      return;
                    }

                    // Asked for before the column opens, which is what stops it landing on
                    // the wiki's front page instead of the page that was pressed.
                    wiki.go(page);
                    notes.show();
                  }}
                />
                <div className="header-controls">
                  {/* Reads files rather than starting a session, so it costs nothing until
                      it is asked for - and then costs enough to be worth asking for. */}
                  {display.footer.showCodeChanges && (
                  <button
                    type="button"
                    className={panel.showing('changes') ? 'header-button on' : 'header-button'}
                    onClick={() => (panel.showing('changes') ? closeChanges() : openChanges())}
                    aria-pressed={panel.showing('changes')}
                    title="Show what this session changed"
                  >
                    Changes
                  </button>
                  )}
                  {/* Only where there is one. Most sessions never make a todo list, and an
                      entry that opens an empty panel is worse than no entry (#172). */}
                  {todos.todos.length > 0 && (
                    <button
                      type="button"
                      className={panel.showing('todos') ? 'header-button on' : 'header-button'}
                      onClick={() => (panel.showing('todos') ? panel.hide('todos') : panel.show('todos'))}
                      aria-pressed={panel.showing('todos')}
                      title="Show what the agent says it is doing"
                    >
                      Todos
                    </button>
                  )}
                  <PromptPicker
                    prompts={promptList.prompts}
                    failed={promptList.failed}
                    at={promptList.at}
                    onOpen={promptList.load}
                    onChoose={goToPrompt}
                  />
                  {display.footer.showAgent && (
                  <AgentPicker
                    current={agent.current}
                    agents={agent.agents}
                    failed={agent.failed}
                    onOpen={agent.refresh}
                    onChoose={agent.choose}
                  />
                  )}
                  <ModelPicker
                    current={model.current}
                    shows={display.footer}
                    autoTier={model.autoTier}
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
              folds={folds}
              finding={finding}
              onFindClosed={() => setFinding(null)}
              cwd={selected.cwd}
              abandoned={transcript.abandoned}
              hasOlder={transcript.hasOlder}
              loadingOlder={transcript.loadingOlder}
              onLoadOlder={transcript.loadOlder}
              extraPages={transcript.extraPages}
              onDropOlder={transcript.dropOlder}
              display={display}
              turnSummary={settings.turnSummary}
              // Set only while a search result is being read, which is the one time the
              // transcript is not showing the end of the conversation.
              onLatest={jump?.sessionId === selected.sessionId ? () => setJump(null) : undefined}
              highlight={jump?.sessionId === selected.sessionId ? { words: jump.words, at: jump.at } : undefined}
              onError={setError}
            />

            <div className="footer">
              {/* Above the composer and below everything else, because that is where the
                  CLI puts it and where someone typing is already looking. */}
              {help && (
                <Shortcuts
                  commands={help === 'full' ? commands : undefined}
                  onClose={() => setHelp(null)}
                  bindings={bindings}
                />
              )}

              {/* In the order they were opened, so the newest is nearest the composer -
                  which is where somebody who has just opened one is already looking. */}
              {panel.open.map((which) => (
                <Fragment key={which}>
                  {which === 'changes' && (
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

                  {which === 'todos' && <Todos todos={todos.todos} onClose={() => panel.hide('todos')} />}

                  {which === 'repository' && (
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
                  readingBranches={repository.readingBranches}
                  onBranches={() => void repository.readBranches()}
                  onSwitch={(name, create) => void switchBranch(name, create)}
                  switching={repository.switching}
                  failed={repository.failed}
                  onRefresh={repository.refresh}
                  onClose={() => {
                    panel.hide('repository');
                    toComposer();
                  }}
                />
              )}

                  {which === 'environment' && (
                    <Environment
                      environment={environment.environment}
                      loading={environment.loading}
                      failed={environment.failed ?? skills.failed}
                      onReload={() => void environment.load()}
                      onClose={closeEnvironment}
                      disabledSkills={skills.disabled}
                      onToggleSkill={selectedId ? (name, enabled) => void skills.toggle(name, enabled) : undefined}
                      onToggleMcp={(name, enabled) => void mcp.toggle(name, enabled)}
                      onSaveMcp={(name, config) => void mcp.save(name, config)}
                      onRemoveMcp={(name) => void mcp.remove(name)}
                      mcpState={mcp.status}
                      onLoginMcp={(name) => void mcp.signIn(selected.sessionId, name)}
                      editingMcp={mcp.editing}
                      onEditMcp={mcp.edit}
                    />
                  )}
                </Fragment>
              ))}

              <Queue
                items={queue.queues[selected.sessionId] ?? []}
                editing={editingQueued[selected.sessionId]?.id ?? null}
                onRemove={(id) => void queue.remove(selected.sessionId, id)}
                // Into the composer, which is where it is rewritten. What was being written
                // is held aside and given back when the edit is finished or abandoned.
                onEdit={(item) => {
                  const displaced = drafts.textOf(selected.sessionId);
                  setEditingQueued((held) => ({
                    ...held,
                    [selected.sessionId]: {
                      id: item.id,
                      displaced,
                      // Where the caret was in what is being put aside, so it can be given
                      // back there rather than at the end of it.
                      caret: caretIn.current[selected.sessionId] ?? displaced.length,
                      // What the box was carrying, which is not this message's and has to
                      // be given back with the words.
                      files: attachments[selected.sessionId] ?? [],
                      // Whether its files can be changed at all. Only this app's own
                      // messages report any, and a message whose files are unknown would
                      // lose them by being taken apart and put back.
                      known: item.attachments !== undefined,
                    },
                  }));
                  drafts.write(selected.sessionId, item.text);
                  // The message's own files, so what is on screen is what it is carrying.
                  setAttachments((current) => ({ ...current, [selected.sessionId]: item.attachments ?? [] }));
                  // At the end of what is being rewritten, which is where somebody about to
                  // add to a sentence already wants to be.
                  caretIn.current[selected.sessionId] = item.text.length;
                  toComposer();
                }}
                onMove={(id, to) => void queue.move(selected.sessionId, id, to)}
                onClear={() => void queue.empty(selected.sessionId)}
                onSendNow={(id) => void queue.steer(selected.sessionId, id)}
                held={queue.held[selected.sessionId] ?? false}
                onHold={(paused) => void queue.hold(selected.sessionId, paused)}
              />

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
                  onAllowFolder={(path) => prompts.allowFolder(pending, path)}
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

              {/*
                * Stood down while the agent is waiting on an answer (#75).
                *
                * A permission request, a question and a plan all arrive mid-turn, and all three
                * draw in the place the composer had - which is where somebody about to type is
                * already looking. Leaving the box below them put a second thing to do under the
                * thing actually being asked.
                *
                * It costs queueing a message until the answer is given, since the runtime would
                * have held one. That is the trade, and it is deliberate: stopping the turn does
                * not go with it, because ctrl+c and escape twice are read from the document
                * rather than from this box.
                */}
              {!prompts.blocked && (
              <Composer
                disabled={!selectedId}
                busy={busy}
                busySince={busySince}
                resuming={resuming === selected.sessionId}
                attached={attachments[selected.sessionId] ?? []}
                onAttach={(files) => setAttachments((current) => ({ ...current, [selected.sessionId]: files }))}
                onPasteFiles={(files) => void handlePaste(selected.sessionId, files)}
                onPasteText={(text) => holdPaste(selected.sessionId, text)}
                onError={setError}
                // Taken as soon as the box comes back, which is the moment the last prompt is
                // answered: it is only drawn when nothing is waiting on anybody.
                focusOn={`${selectedId}:${focusAt}`}
                caretAt={caretIn.current[selected.sessionId]}
                onCaret={(at) => {
                  caretIn.current[selected.sessionId] = at;
                }}
                value={drafts.textOf(selected.sessionId)}
                onChange={(text) => drafts.write(selected.sessionId, text)}
                stashed={drafts.hasStash(selected.sessionId)}
                onSend={(prompt) => void handleSend(prompt)}
                onAbort={interrupt}
                history={history}
                commands={commands}
                cwd={selected.cwd}
                onCommandsNeeded={slash.open}
                onRewindNeeded={rewind.load}
                rewindNotice={rewindNotice}
                rewriting={
                  editingQueued[selected.sessionId]
                    ? {
                        onCancel: () => {
                          const held = editingQueued[selected.sessionId];
                          setEditingQueued(({ [selected.sessionId]: _gone, ...rest }) => rest);
                          drafts.write(selected.sessionId, held?.displaced ?? '');
                          setAttachments((current) => ({ ...current, [selected.sessionId]: held?.files ?? [] }));
                          caretIn.current[selected.sessionId] = held?.caret ?? 0;
                          toComposer();
                        },
                      }
                    : null
                }
                onTakeBack={
                  lastSent[selected.sessionId]
                    ? () => {
                        const held = lastSent[selected.sessionId];
                        if (!held) return;
                        void (async () => {
                          const removed = await queue.withdraw(selected.sessionId, held.messageId);
                          setLastSent(({ [selected.sessionId]: _gone, ...rest }) => rest);
                          // Only when it was actually withdrawn. Handing the words back for a
                          // message still going to be answered would be the worse mistake.
                          if (!removed) return;
                          drafts.write(selected.sessionId, held.prompt);
                          caretIn.current[selected.sessionId] = held.prompt.length;
                          toComposer();
                        })();
                      }
                    : undefined
                }
                mode={mode.mode}
                onCycleMode={mode.cycle}
                shortcuts={shortcutOverrides}
                intent={intent}
              />
              )}
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

      {/* A note from the wiki beside the session it is about, rather than in place of it
          (#35). After .main and outside it: it is a column of the app's own grid, so the
          transcript keeps its width rather than giving up part of it.

          Only where the session has notes at all. A column that opened empty would be a
          feature arguing with the header control that says there is nothing to show. */}
      {notes.open && (
        <>
          <NotesGrip            dragging={notesWidth.dragging}
            onStart={notesWidth.start}
            onNudge={notesWidth.nudge}
            onReset={notesWidth.reset}
          />
          <SessionNotes
            notes={wikiNotes}
            pages={wiki.pages}
            page={wiki.page}
            loading={wiki.loading}
            failed={wiki.failed}
            saving={wiki.saving}
            draft={wiki.draft}
            onOpen={wiki.go}
            onEdit={wiki.edit}
            onRevert={wiki.revert}
            onSave={(path) => void wiki.save(path)}
            onBrowse={() => {
              // Carrying the session's pages over, so the browser opens on what this column
              // was showing rather than on the whole wiki. The column is not closed, only
              // stood down while the browser is up, so coming back brings it with it.
              setWikiScope(wikiNotes.map((each) => each.path));
              setShowWiki(true);
            }}
            onClose={notes.hide}
          />
        </>
      )}

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
          wikiTags={offeredWikiTags}
          onToggle={(tag) => toggleTag(tagging.sessionId, tag)}
          onRetire={retireTag}
          onDismiss={dismissWikiTag}
          onClose={() => setTagging(null)}
        />
      )}

      {deletingMany && (
        <Confirm
          title={`Delete ${deletingMany.length} sessions?`}
          body={
            <>
              <p>
                These {deletingMany.length} conversations and everything they wrote will be removed: the
                transcripts, their checkpoints, and the snapshots that let their file changes be rewound.
              </p>
              {/* Named rather than counted. Four rows were marked by hand and the one worth
                  checking is whichever was marked by accident, which a number cannot show. */}
              <ul className="confirm-list">
                {deletingMany.map((session) => (
                  <li key={session.sessionId}>{session.title ?? 'Untitled session'}</li>
                ))}
              </ul>
              <p>Nothing they did to your files is undone, and this cannot be reversed.</p>
            </>
          }
          confirmLabel={`Delete ${deletingMany.length} sessions`}
          onConfirm={() => {
            // One after another rather than together: each is its own removal, and one that
            // fails must not take the rest with it.
            for (const session of deletingMany) void removeSession(session);
            setDeletingMany(null);
            clearMarks();
          }}
          onCancel={() => setDeletingMany(null)}
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

      {/* A window over the app rather than a panel inside the session, and so not one of
          the panels: it says what another session delegated without going there, and a
          panel closes itself the moment the session it describes is left. */}
      {subagentsFor && (
        <Subagents
          sessionId={subagentsFor}
          isShown={subagents.isShown}
          isKept={subagents.isKept}
          onToggleShown={(task) => subagents.toggleShown(task, subagentsFor)}
          onKeep={(task) => subagents.keepFound(task, subagentsFor)}
          onOpen={(task) => {
            // Reading one means going to the conversation that delegated it, which is the
            // one place its transcript is drawn.
            if (!subagents.isShown(task.agentId)) subagents.toggleShown(task, subagentsFor);
            setSelectedId(subagentsFor);
            subagents.setOpenId(task.agentId);
            setSubagentsFor(null);
          }}
          onClose={() => setSubagentsFor(null)}
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

      {/* Over everything, because the whole window is the target: a drop is aimed at the
          conversation rather than at some particular part of it (#231). */}
      {dropping && (
        <div className="drop-overlay">
          <div className="drop-note">
            <span className="drop-title">Drop to attach</span>
            <span className="drop-detail">The files are sent where they are, not copied</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What to say when a rewind did not simply work.
 *
 * Null when there is nothing to report, so the caller can treat "no trouble" as the quiet
 * case. The failures are kept apart because they differ in what they left on disk: a
 * reader whose files were put back but whose conversation was not needs to know which way
 * round it went, and "rewind failed" would tell them neither.
 */
function rewindTrouble(result: RewindResult): string | null {
  switch (result.outcome) {
    case 'success':
      return null;
    case 'busy':
      return 'This session is still working. Rewinding needs it to settle first, so try again in a moment.';
    case 'untracked':
      return 'This session did not record what it changed, so its files cannot be put back.';
    case 'remote':
      return 'A session running elsewhere cannot be rewound from here.';
    case 'rolled-back':
      return 'The files could not be put back, so the session was left exactly as it was.';
    case 'rollback-incomplete':
      return `The files could not be put back, and undoing that did not fully succeed. Check them before carrying on.${
        result.error ? ` ${result.error}` : ''
      }`;
    case 'truncation-failed':
      return `The conversation could not be discarded${
        result.restoredFiles.length > 0 ? ', but the files were put back' : ''
      }. The session and its files may now disagree.`;
    case 'partly-tidied':
      // It worked. What is left behind is the runtime's own bookkeeping, which costs disk
      // rather than correctness, so it is not worth stopping the reader over.
      return null;
  }
}

function describeError(event: TranscriptEvent): string {
  const data = event.data as { message?: unknown } | null;
  return typeof data?.message === 'string' ? explain(data.message) : 'Session error';
}












