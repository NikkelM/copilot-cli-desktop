import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  PendingPermission,
  PermissionChoice,
  SessionSummary,
  TranscriptEvent,
} from '../shared/protocol';
import { toPreview } from '../shared/preview';

/**
 * A transcript entry, possibly one shown optimistically before the runtime echoes it.
 * Sending is slow on a cold session, so the prompt appears immediately and is then
 * replaced by the authoritative event rather than duplicated.
 */
type TimelineEvent = TranscriptEvent & { local?: boolean };
import { Composer } from './components/Composer';
import { PermissionPrompt } from './components/PermissionPrompt';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import {
  abortSession,
  getTranscript,
  listSessions,
  onPermissionRequested,
  onPermissionResolved,
  onSessionEvent,
  onSessionLoaded,
  onSessionsChanged,
  resolvePermission,
  sendMessage,
  setApprovalPolicy,
} from './lib/sidecar';
import { orderSessions } from './lib/ordering';
import { mergeLivePreviews } from './lib/livePreviews';
import { useTauriEvent } from './lib/useTauriEvent';
import './App.css';

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [allowAll, setAllowAll] = useState<Record<string, boolean>>({});
  /** Session ids in activation order, most recent first. Fixes the active group's order. */
  const [activeOrder, setActiveOrder] = useState<string[]>([]);
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
    listSessions()
      // The fetched previews come from the lagging turns table, so anything already
      // learned from live events wins until the database catches up.
      .then((result) => setSessions(mergeLivePreviews(result.sessions, livePreviews.current)))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => refreshSessions(), [refreshSessions]);

  // Selecting a session only replays its log from disk; nothing is resumed until the
  // user sends a message, which is what keeps idle sessions free.
  useEffect(() => {
    if (!selectedId) return;
    setEvents([]);
    setBusy(false);
    getTranscript(selectedId)
      .then((result) => setEvents(result.events))
      .catch((e: unknown) => setError(String(e)));
  }, [selectedId]);

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

      setEvents((current) => {
        // Replace the optimistic prompt with the runtime's own echo, rather than
        // showing the same message twice.
        if (event.type === 'user.message') {
          const index = current.findIndex(
            (entry) => entry.local && entry.type === 'user.message' && contentOf(entry) === contentOf(event),
          );
          if (index !== -1) {
            const next = [...current];
            next[index] = event;
            return next;
          }
        }
        return [...current, event];
      });
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

    // Show the prompt straight away; resuming a cold session takes seconds, and the
    // runtime's own echo replaces this entry when it arrives.
    setEvents((current) => [...current, { type: 'user.message', data: { content: prompt }, local: true }]);

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

  const selected = sessions.find((session) => session.sessionId === selectedId) ?? null;
  const sessionPermissions = permissions.filter((p) => p.sessionId === selectedId);
  const ordered = useMemo(() => orderSessions(sessions, activeOrder), [sessions, activeOrder]);

  return (
    <div className="app">
      <Sidebar sessions={ordered} selectedId={selectedId} onSelect={setSelectedId} />

      <main className="main">
        {selected ? (
          <>
            <header className="main-header">
              <div className="main-title">
                <h1>{selected.title ?? 'Untitled session'}</h1>
                <p className="cwd">{selected.cwd}</p>
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

            {error && <p className="error">{error}</p>}
            {resuming && <p className="notice">Resuming into the shared runtime. This takes a few seconds.</p>}

            <Transcript events={events} sessionId={selected.sessionId} cwd={selected.cwd} />

            <div className="footer">
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

function contentOf(event: TranscriptEvent): string | null {
  const data = event.data as { content?: unknown } | null;
  return typeof data?.content === 'string' ? data.content : null;
}
