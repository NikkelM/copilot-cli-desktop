import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  Attachment,
  ElicitationAction,
  ElicitationFieldValue,
  PendingElicitation,
  PendingPermission,
  PermissionChoice,
  SessionSummary,
  SlashCommand,
  TranscriptEvent,
} from '../shared/protocol';

import { toPreview } from '../shared/preview';
import { Changes } from './components/Changes';
import { Composer } from './components/Composer';
import { ElicitationPrompt } from './components/ElicitationPrompt';
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

  listSessions,
  onElicitationRequested,
  onElicitationResolved,
  onPermissionRequested,
  onPermissionResolved,
  onSessionEvent,
  onSessionChanges,
  onSessionLoaded,
  onSessionsChanged,
  onSidecarRestarted,
  onSidecarStopped,
  resolveElicitation,
  resolvePermission,
  runtimeStatus,
  invokeCommand,
  sendMessage,
} from './lib/sidecar';
import { orderSessions } from './lib/ordering';
import { mergeLivePreviews } from './lib/livePreviews';
import { CHANGES } from './lib/localCommands';
import { contentOf } from './lib/timeline';
import { useChanges } from './lib/useChanges';
import { useModel } from './lib/useModel';
import { useCommands } from './lib/useCommands';
import { dispatch } from './lib/slash';
import { useQueue } from './lib/useQueue';
import { useShortcuts } from './lib/useShortcuts';
import { useTranscript } from './lib/useTranscript';
import { useTreeState } from './lib/useTreeState';
import { useTauriEvent } from './lib/useTauriEvent';
import './App.css';

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Unsent text, per session. An unsent message belongs to the session it was written
   * for: kept in the composer it would follow the user to whichever session they opened
   * next, and be sent there instead.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Files waiting to go with a draft, kept per session for the same reason the text is. */
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const [busy, setBusy] = useState(false);
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
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [elicitations, setElicitations] = useState<PendingElicitation[]>([]);
  /** Session ids in activation order, most recent first. Fixes the active group's order. */
  const [activeOrder, setActiveOrder] = useState<string[]>([]);
  const [maxLoaded, setMaxLoaded] = useState<number | undefined>(undefined);
  /**
   * A session opened by id that the list does not carry.
   *
   * The sidebar hides sessions with no title and no turns, but one can still be found by
   * id and opened. Without somewhere to put its summary the header would have no path, no
   * branch and no title for a session that is plainly open.
   */
  const [offList, setOffList] = useState<SessionSummary | null>(null);

  const selected =
    sessions.find((session) => session.sessionId === selectedId) ??
    (offList?.sessionId === selectedId ? offList : null);

  const open = useCallback((sessionId: string, session?: SessionSummary) => {
    setSelectedId(sessionId);
    setOffList(session ?? null);
  }, []);

  const transcript = useTranscript(selectedId, setError);
  const tree = useTreeState(selected?.cwd ?? null);
  const queue = useQueue();
  const model = useModel(selectedId, setError);
  const slash = useCommands(selectedId);
  const changes = useChanges(selectedId);
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
      await refreshSessions();
      setSelectedId(sessionId);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  // Selecting a session cannot leave the composer disabled by a turn that was running in
  // whichever session was open before.
  useEffect(() => setBusy(false), [selectedId]);

  // Nor a help list open over a session nobody asked to read it in. Not remembered per
  // session: it is a reference, so wanting it back is a keypress away.
  useEffect(() => setHelp(null), [selectedId]);

  // The same for the list of changes, which is about the session that was open, not this one.
  useEffect(() => setShowChanges(false), [selectedId]);
  /**
   * Previews derived from live events, which are ahead of the database.
   * A ref rather than state: refetches read it, but it never needs to trigger a render
   * on its own, since the render always follows a setSessions in the same handler.
   */
  const livePreviews = useRef(new Map<string, string | null>());

  // Read inside event handlers without making them depend on the selected session.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  /** Read by a shortcut handler registered once, which would otherwise hold the first render's answer. */
  const busyRef = useRef(false);
  busyRef.current = busy;
  const draftsRef = useRef<Record<string, string>>({});
  draftsRef.current = drafts;

  const refreshSessions = useCallback(() => {
    // Returned so a caller that needs the list to contain something can wait for it.
    return listSessions()
      // The fetched previews come from the lagging turns table, so anything already
      // learned from live events wins until the database catches up.
      .then((result) => setSessions(mergeLivePreviews(result.sessions, livePreviews.current)))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => void refreshSessions(), [refreshSessions]);

  // How many sessions may be resident at once, so the sidebar can say what the cap is.
  // Asked once: it is a setting rather than a reading, and asking costs no process.
  useEffect(() => {
    runtimeStatus()
      .then((status) => setMaxLoaded(status.maxLoadedSessions))
      .catch(() => undefined);
  }, []);

  useTauriEvent(() =>
    onSessionEvent(({ sessionId, event }) => {
      // The sidebar preview comes from the turns table, which is flushed well after the
      // fact, so a loaded session would keep showing an older reply. Its own events are
      // already streaming here, so use them and skip the wait entirely. This applies to
      // every loaded session, not just the one on screen.
      const spoken = event.type === 'assistant.message' ? contentOf(event) : null;
      if (spoken) {
        const preview = toPreview(spoken);
        livePreviews.current.set(sessionId, preview);

        setSessions((current) =>
          current.map((session) => (session.sessionId === sessionId ? { ...session, preview } : session)),
        );
      }

      // Like the preview above, the queue belongs to whichever session owns it rather than
      // to the one on screen: a session left running keeps its queue while the reader is
      // elsewhere, and it must be right when they come back.
      if (event.type === 'user.message') {
        const messageId = (event.data as { messageId?: string } | undefined)?.messageId;
        if (messageId) queue.taken(sessionId, messageId);
      }
      // Stopping a turn discards everything behind it, so what was waiting will never run.
      if (event.type === 'abort') queue.clear(sessionId);

      if (sessionId !== selectedRef.current) return;

      if (event.type === 'assistant.turn_start') {
        setBusy(true);
      }
      if (event.type === 'session.idle' || event.type === 'assistant.turn_end') setBusy(false);
      if (event.type === 'session.error') setError(describeError(event));
      // The agent working is what changes the working tree, so this is the moment the
      // branch line is worth asking about again.
      if (event.type === 'assistant.turn_end') tree.refresh();
      // Every resume reports the model as well as every switch, including one made from a
      // terminal, so the header follows rather than trusting what it read from the log.
      model.observe(event);

      transcript.push(event);
    }),
  );

  useTauriEvent(() =>
    onSessionLoaded(({ sessionId, loaded }) => {
      setSessions((current) =>
        current.map((session) => (session.sessionId === sessionId ? { ...session, loaded } : session)),
      );

      // A session entering the active group goes to its top; leaving drops it entirely.
      // Sessions already active keep their position, so the list does not shuffle when
      // messages are sent.
      setActiveOrder((current) =>
        loaded
          ? current.includes(sessionId)
            ? current
            : [sessionId, ...current]
          : current.filter((id) => id !== sessionId),
      );

      // Once unloaded the app no longer sees this session's events, so its own preview
      // must stop overriding whatever the database reports.
      if (!loaded) {
        livePreviews.current.delete(sessionId);
        // The queue lives in the session that was let go, so nothing is waiting any more.
        queue.clear(sessionId);
      }

      // A session that is awake knows about a few commands the runtime at large does not,
      // and a server is already running to ask, so this costs nothing to take.
      slash.observe(loaded, sessionId);
    }),
  );

  // The store changes on every turn of every running session, including ones started in
  // a terminal, so this keeps the sidebar current without polling.
  useTauriEvent(() => onSessionsChanged(() => refreshSessions()), [refreshSessions]);

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
      setPermissions([]);
      setElicitations([]);
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
        setPermissions([]);
        setElicitations([]);
        refreshSessions();
      }),
    [refreshSessions],
  );

  useTauriEvent(() =>
    onPermissionRequested((pending) => {
      setPermissions((current) =>
        // Guard against the same request arriving twice.
        current.some((p) => p.requestId === pending.requestId) ? current : [...current, pending],
      );
    }),
  );

  useTauriEvent(() =>
    onPermissionResolved(({ requestId }) => {
      setPermissions((current) => current.filter((p) => p.requestId !== requestId));
    }),
  );

  useTauriEvent(() =>
    onElicitationRequested((pending) => {
      setElicitations((current) =>
        current.some((e) => e.requestId === pending.requestId) ? current : [...current, pending],
      );
    }),
  );

  useTauriEvent(() =>
    onElicitationResolved(({ requestId }) => {
      setElicitations((current) => current.filter((e) => e.requestId !== requestId));
    }),
  );

  /** Stop the turn, saying so rather than leaving the press looking unnoticed. */
  const interrupt = useCallback(() => {
    const forSession = selectedRef.current;
    if (forSession) abortSession(forSession).catch((e: unknown) => setError(String(e)));
  }, []);

  useShortcuts(
    useCallback(
      (shortcut) => {
        if (shortcut === 'help') {
          setHelp((showing) => (showing ? null : 'keys'));
          return;
        }

        if (shortcut === 'interrupt') {
          interrupt();
          return;
        }

        // Escape twice means "undo what I was about to do": stopping the turn while one is
        // running, and otherwise throwing away what was written but not sent.
        if (busyRef.current) interrupt();
        else if (selectedRef.current) setDrafts((current) => ({ ...current, [selectedRef.current!]: '' }));
      },
      [interrupt],
    ),
    // The composer's own text, rather than what a key event can be asked about the field it
    // landed in: this is where it is actually kept.
    useCallback(() => draftsRef.current[selectedRef.current ?? ''] ?? '', []),
  );

  function handleElicitation(
    pending: PendingElicitation,
    action: ElicitationAction,
    content?: Record<string, ElicitationFieldValue>,
  ) {
    // Drop it immediately so the form cannot be submitted twice.
    setElicitations((current) => current.filter((e) => e.requestId !== pending.requestId));
    void resolveElicitation(pending.requestId, action, content).catch((e: unknown) =>
      setError(String(e)),
    );
  }

  function handlePermission(pending: PendingPermission, choice: PermissionChoice) {
    // Drop it immediately so the prompt cannot be answered twice.
    setPermissions((current) => current.filter((p) => p.requestId !== pending.requestId));
    void resolvePermission(pending.sessionId, pending.requestId, choice).catch((e: unknown) =>
      setError(String(e)),
    );
  }

  /** Open the panel and read the list, from wherever the request came from. */
  function openChanges() {
    setShowChanges(true);
    changes.load();
  }

  async function handleSend(prompt: string) {
    if (!selectedId) return;

    // A leading slash naming a command is a command, not a message. Anything else that
    // starts with one - a path, a fraction, a sentence - is text, and is sent as text.
    const what = dispatch(prompt, slash.commands);

    if (what.kind === 'local') {
      setDrafts((current) => ({ ...current, [selectedId]: '' }));
      setError(null);
      // Which one it is decides what opens. There is no default: an unhandled local
      // command would silently do whatever the last branch happened to do.
      if (what.command.name === CHANGES.name) openChanges();
      else setHelp('full');
      return;
    }

    if (what.kind === 'command') return runCommand(selectedId, what.command, what.input);

    if (what.kind === 'unknown') {
      const near = what.near.map((each) => `/${each.name}`);
      setDrafts((current) => ({ ...current, [selectedId]: '' }));
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
   */
  async function runCommand(sessionId: string, command: SlashCommand, input: string) {
    setError(null);

    if (busy && !command.allowDuringTurn) {
      setError(`/${command.name} cannot run while the agent is working. Stop the turn first.`);
      return;
    }

    setDrafts((current) => ({ ...current, [sessionId]: '' }));
    // Echoed as typed, so the transcript says what was asked for as well as what came back.
    transcript.showSent(input ? `/${command.name} ${input}` : `/${command.name}`);

    const wasCold = !sessions.find((s) => s.sessionId === sessionId)?.loaded;
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
          setError(`/${command.name} needs a ${outcome.what} view, which this app does not have yet.`);
          break;
      }
    } catch (e: unknown) {
      setError(String(e));
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
    setDrafts((current) => ({ ...current, [sessionId]: '' }));
    // Taken before the send so a file picked while it is in flight belongs to the next
    // message rather than this one.
    const sent = attachments[sessionId] ?? [];
    setAttachments((current) => ({ ...current, [sessionId]: [] }));

    const wasCold = !sessions.find((s) => s.sessionId === sessionId)?.loaded;
    setResuming(wasCold ? sessionId : null);

    // Show the prompt straight away when nothing is running; resuming a cold session takes
    // seconds, and a prompt that appears only afterwards looks like it was not sent. While
    // a turn is running the message will queue, and showing it in the conversation would
    // claim the agent had already been given it.
    const expectQueued = busy;
    if (!expectQueued && display !== null) transcript.showSent(display);
    setBusy(true);

    try {
      const { messageId, queued } = await sendMessage({ sessionId, prompt, attachments: sent });

      // The runtime decides, and a turn can end while the message is on its way, so the
      // guess above is reconciled with what actually happened.
      if (queued) queue.add(sessionId, { id: messageId, prompt: display ?? prompt });
      else if (expectQueued && display !== null) transcript.showSent(display);
    } catch (e: unknown) {
      setError(String(e));
      setBusy(false);
    } finally {
      setResuming(null);
    }
  }

  const sessionPermissions = permissions.filter((p) => p.sessionId === selectedId);
  const sessionElicitations = elicitations.filter((e) => e.sessionId === selectedId);
  const ordered = useMemo(() => orderSessions(sessions, activeOrder), [sessions, activeOrder]);

  return (
    <div className="app">
      <Sidebar
        sessions={ordered}
        selectedId={selectedId}
        onSelect={open}
        onCreate={() => void handleCreate()}
        creating={creating}
        maxLoaded={maxLoaded}
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
                    onClick={() => (showChanges ? setShowChanges(false) : openChanges())}
                    aria-pressed={showChanges}
                    title="What this session changed, and the diff for any of it"
                  >
                    Changes
                  </button>
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
                  onClose={() => setShowChanges(false)}
                  onReview={changes.review}
                  reviewedAt={changes.reviewedAt}
                  showAll={changes.showAll}
                  onSpan={changes.setSpan}
                />
              )}

              <Queue messages={queue.queues[selected.sessionId] ?? []} />

              {sessionElicitations.map((pending) => (
                <ElicitationPrompt
                  key={pending.requestId}
                  pending={pending}
                  onResolve={(action, content) => handleElicitation(pending, action, content)}
                />
              ))}

              {sessionPermissions.map((pending) => (
                <PermissionPrompt
                  key={pending.requestId}
                  pending={pending}
                  cwd={selected.cwd}
                  onResolve={(choice) => handlePermission(pending, choice)}
                />
              ))}

              <Composer
                disabled={!selectedId}
                busy={busy}
                resuming={resuming === selected.sessionId}
                attached={attachments[selected.sessionId] ?? []}
                onAttach={(files) => setAttachments((current) => ({ ...current, [selected.sessionId]: files }))}
                onError={setError}
                // A question or a permission request blocks the agent until answered, so
                // it keeps the keyboard; the composer takes it back once nothing is waiting.
                focusOn={sessionElicitations.length + sessionPermissions.length > 0 ? null : selectedId}
                value={drafts[selected.sessionId] ?? ''}
                onChange={(text) => setDrafts((current) => ({ ...current, [selected.sessionId]: text }))}
                onSend={(prompt) => void handleSend(prompt)}
                onAbort={interrupt}
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
          </div>
        )}
      </main>
    </div>
  );
}

function describeError(event: TranscriptEvent): string {
  const data = event.data as { message?: unknown } | null;
  return typeof data?.message === 'string' ? data.message : 'Session error';
}
