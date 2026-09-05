import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionSummary, TranscriptEvent } from '../shared/protocol';
import { Composer } from './components/Composer';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import {
  abortSession,
  getTranscript,
  listSessions,
  onSessionEvent,
  onSessionLoaded,
  sendMessage,
} from './lib/sidecar';
import './App.css';

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read inside event handlers without making them depend on the selected session.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const refreshSessions = useCallback(() => {
    listSessions()
      .then((result) => setSessions(result.sessions))
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

  useEffect(() => {
    const unlisten = onSessionEvent(({ sessionId, event }) => {
      if (sessionId !== selectedRef.current) return;

      if (event.type === 'assistant.turn_start') setBusy(true);
      if (event.type === 'session.idle' || event.type === 'assistant.turn_end') setBusy(false);
      if (event.type === 'session.error') setError(describeError(event));

      setEvents((current) => [...current, event]);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const unlisten = onSessionLoaded(({ sessionId, loaded }) => {
      setSessions((current) =>
        current.map((session) => (session.sessionId === sessionId ? { ...session, loaded } : session)),
      );
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  async function handleSend(prompt: string) {
    if (!selectedId) return;
    setError(null);

    // Show the prompt straight away; the echoed user.message arrives with the stream.
    setEvents((current) => [...current, { type: 'user.message', data: { content: prompt } }]);

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

  return (
    <div className="app">
      <Sidebar sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />

      <main className="main">
        {selected ? (
          <>
            <header className="main-header">
              <div className="main-title">
                <h1>{selected.title ?? 'Untitled session'}</h1>
                <p className="cwd">{selected.cwd}</p>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
                Raw events
              </label>
            </header>

            {error && <p className="error">{error}</p>}
            {resuming && <p className="notice">Resuming into the shared runtime. This takes a few seconds.</p>}

            <Transcript events={events} showRaw={showRaw} />

            <Composer
              disabled={!selectedId}
              busy={busy}
              onSend={(prompt) => void handleSend(prompt)}
              onAbort={() => selectedId && void abortSession(selectedId)}
            />
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
