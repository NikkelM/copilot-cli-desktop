import { useEffect, useState } from 'react';

import type { SessionSummary, TranscriptEvent } from '../shared/protocol';
import { Sidebar } from './components/Sidebar';
import { getTranscript, listSessions } from './lib/sidecar';
import './App.css';

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSessions()
      .then((result) => setSessions(result.sessions))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  // Selecting a session only replays its log from disk; nothing is resumed until the
  // user sends a message, which is what keeps idle sessions free.
  useEffect(() => {
    if (!selectedId) return;
    setEvents([]);
    getTranscript(selectedId)
      .then((result) => setEvents(result.events))
      .catch((e: unknown) => setError(String(e)));
  }, [selectedId]);

  const selected = sessions.find((session) => session.sessionId === selectedId) ?? null;

  return (
    <div className="app">
      <Sidebar sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />

      <main className="main">
        {error && <p className="error">{error}</p>}

        {!selected && !error && <p className="empty">Select a session to view its transcript.</p>}

        {selected && (
          <>
            <header className="main-header">
              <h1>{selected.title ?? 'Untitled session'}</h1>
              <p className="cwd">{selected.cwd}</p>
            </header>

            <ol className="transcript">
              {events.map((event, index) => (
                <li key={index} className={`event ${event.type.replace('.', '-')}`}>
                  <span className="event-type">{event.type}</span>
                </li>
              ))}
            </ol>

            {/* TODO(phase2): composer that calls resumeSession() on first send. */}
          </>
        )}
      </main>
    </div>
  );
}
