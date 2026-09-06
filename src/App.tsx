import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ElicitationAction,
  ElicitationFieldValue,
  PendingElicitation,
  PendingPermission,
  PermissionChoice,
  SessionSummary,
  TranscriptEvent,
} from '../shared/protocol';

import { toPreview } from '../shared/preview';
import { Composer } from './components/Composer';
import { ElicitationPrompt } from './components/ElicitationPrompt';
import { PermissionPrompt } from './components/PermissionPrompt';
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
  onSessionLoaded,
  onSessionsChanged,
  onSidecarRestarted,
  onSidecarStopped,
  resolveElicitation,
  resolvePermission,
  sendMessage,
  setApprovalPolicy,
} from './lib/sidecar';
import { orderSessions } from './lib/ordering';
import { mergeLivePreviews } from './lib/livePreviews';
import { contentOf } from './lib/timeline';
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
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the sidecar exits: nothing works afterwards, so it outranks any other message. */
  const [stopped, setStopped] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [elicitations, setElicitations] = useState<PendingElicitation[]>([]);
  const [allowAll, setAllowAll] = useState<Record<string, boolean>>({});
  /** Session ids in activation order, most recent first. Fixes the active group's order. */
  const [activeOrder, setActiveOrder] = useState<string[]>([]);

  const selected = sessions.find((session) => session.sessionId === selectedId) ?? null;

  const transcript = useTranscript(selectedId, setError);
  const tree = useTreeState(selected?.cwd ?? null);
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
  /**
   * Previews derived from live events, which are ahead of the database.
   * A ref rather than state: refetches read it, but it never needs to trigger a render
   * on its own, since the render always follows a setSessions in the same handler.
   */
  const livePreviews = useRef(new Map<string, string | null>());

  // Read inside event handlers without making them depend on the selected session.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const refreshSessions = useCallback(() => {
    // Returned so a caller that needs the list to contain something can wait for it.
    return listSessions()
      // The fetched previews come from the lagging turns table, so anything already
      // learned from live events wins until the database catches up.
      .then((result) => setSessions(mergeLivePreviews(result.sessions, livePreviews.current)))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => void refreshSessions(), [refreshSessions]);

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

      if (sessionId !== selectedRef.current) return;

      if (event.type === 'assistant.turn_start') setBusy(true);
      if (event.type === 'session.idle' || event.type === 'assistant.turn_end') setBusy(false);
      if (event.type === 'session.error') setError(describeError(event));
      // The agent working is what changes the working tree, so this is the moment the
      // branch line is worth asking about again.
      if (event.type === 'assistant.turn_end') tree.refresh();

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
      if (!loaded) livePreviews.current.delete(sessionId);
    }),
  );

  // The store changes on every turn of every running session, including ones started in
  // a terminal, so this keeps the sidebar current without polling.
  useTauriEvent(() => onSessionsChanged(() => refreshSessions()), [refreshSessions]);

  // Losing the sidecar takes every session with it, and a request that will never be
  // answered otherwise shows as the app quietly doing nothing.
  useTauriEvent(() =>
    onSidecarStopped((reason) => {
      setStopped(reason);
      setBusy(false);
      setResuming(false);
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
        setResuming(false);
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

  function toggleAllowAll(sessionId: string, enabled: boolean) {
    setAllowAll((current) => ({ ...current, [sessionId]: enabled }));
    void setApprovalPolicy(sessionId, enabled ? 'approve-all' : 'prompt').catch((e: unknown) =>
      setError(String(e)),
    );
  }

  async function handleSend(prompt: string) {
    if (!selectedId) return;
    setError(null);
    setDrafts((current) => ({ ...current, [selectedId]: '' }));

    // Show the prompt straight away; resuming a cold session takes seconds, and the
    // runtime's own echo replaces this entry when it arrives.
    transcript.showSent(prompt);

    const wasCold = !sessions.find((s) => s.sessionId === selectedId)?.loaded;
    setResuming(wasCold);
    setBusy(true);

    try {
      await sendMessage({ sessionId: selectedId, prompt });
    } catch (e: unknown) {
      setError(String(e));
      setBusy(false);
    } finally {
      setResuming(false);
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
        onSelect={setSelectedId}
        onCreate={() => void handleCreate()}
        creating={creating}
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
              <div className="main-title">
                <h1>{selected.title ?? 'Untitled session'}</h1>
                <SessionPath cwd={selected.cwd} state={tree.state} />
              </div>
              <div className="header-controls">
                <label className="toggle" title="Approve every tool call in this session without asking">
                  <input
                    type="checkbox"
                    checked={allowAll[selected.sessionId] ?? false}
                    onChange={(e) => toggleAllowAll(selected.sessionId, e.target.checked)}
                  />
                  Allow all
                </label>
              </div>
            </header>

            {/* Always rendered, even when empty: .main assigns rows by position, so a
                child that comes and goes moves the transcript into another row. */}
            <div className="notices">
              {error && <p className="error">{error}</p>}
              {resuming && <p className="notice">Resuming into the shared runtime. This takes a few seconds.</p>}
            </div>

            <Transcript
              events={transcript.events}
              sessionId={selected.sessionId}
              cwd={selected.cwd}
              hasOlder={transcript.hasOlder}
              loadingOlder={transcript.loadingOlder}
              onLoadOlder={transcript.loadOlder}
            />

            <div className="footer">
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
                // A question or a permission request blocks the agent until answered, so
                // it keeps the keyboard; the composer takes it back once nothing is waiting.
                focusOn={sessionElicitations.length + sessionPermissions.length > 0 ? null : selectedId}
                value={drafts[selected.sessionId] ?? ''}
                onChange={(text) => setDrafts((current) => ({ ...current, [selected.sessionId]: text }))}
                onSend={(prompt) => void handleSend(prompt)}
                onAbort={() => selectedId && void abortSession(selectedId)}
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
