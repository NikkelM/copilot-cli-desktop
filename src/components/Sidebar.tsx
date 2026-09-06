import { useMemo, useState } from 'react';

import type { SessionSummary } from '../../shared/protocol';

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** Starting a session needs a directory to start it in, which only the reader knows. */
  onCreate: () => void;
  creating: boolean;
}

/** Sessions ordered by last use. Rendering and filtering this list never loads a session. */
export function Sidebar({ sessions, selectedId, onSelect, onCreate, creating }: SidebarProps) {
  const [query, setQuery] = useState('');

  // Filtering runs over the already-fetched list, so it costs nothing and needs no query.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;

    return sessions.filter((session) =>
      [session.title, session.cwd, session.repository, session.branch].some((field) =>
        field?.toLowerCase().includes(needle),
      ),
    );
  }, [sessions, query]);

  return (
    <nav className="sidebar">
      <header className="sidebar-header">
        <span>Sessions</span>
        <span className="badge">
          {query ? `${matches.length}/${sessions.length}` : sessions.length}
        </span>
        <button
          type="button"
          className="new-session"
          onClick={onCreate}
          disabled={creating}
          title="Start a session in a folder you choose"
        >
          {creating ? 'Starting…' : 'New'}
        </button>
      </header>

      <div className="search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by title or folder"
          spellCheck={false}
        />
      </div>

      {matches.length === 0 ? (
        <p className="no-matches">No sessions match that filter.</p>
      ) : (
        <ul className="session-list">
          {matches.map((session) => (
            <li key={session.sessionId}>
              <button
                type="button"
                className={`session${session.sessionId === selectedId ? ' selected' : ''}`}
                onClick={() => onSelect(session.sessionId)}
              >
                <span className="session-title">
                  {session.title ?? 'Untitled session'}
                  {session.loaded && <span className="dot" title="Loaded in memory" />}
                </span>
                <span className="session-meta">
                  {formatRelative(session.updatedAt)}
                  {session.repository ? ` · ${session.repository}` : ''}
                </span>
                {session.preview && <span className="session-preview">{session.preview}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

const UNITS: [limit: number, divisor: number, label: string][] = [
  [60_000, 1000, 's'],
  [3_600_000, 60_000, 'm'],
  [86_400_000, 3_600_000, 'h'],
];

function formatRelative(iso: string): string {
  // SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC without a zone marker, so make it explicit.
  const normalised = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const elapsed = Date.now() - new Date(normalised).getTime();
  if (!Number.isFinite(elapsed)) return '';
  if (elapsed < 0) return 'just now';

  for (const [limit, divisor, label] of UNITS) {
    if (elapsed < limit) return `${Math.max(1, Math.floor(elapsed / divisor))}${label} ago`;
  }
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
