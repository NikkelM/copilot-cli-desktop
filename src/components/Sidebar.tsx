import type { SessionSummary } from '../../shared/protocol';

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}

/** Sessions ordered by last use. Rendering this list never loads a session. */
export function Sidebar({ sessions, selectedId, onSelect }: SidebarProps) {
  return (
    <nav className="sidebar">
      <header className="sidebar-header">
        <span>Sessions</span>
        <span className="badge">{sessions.length}</span>
      </header>

      <ul className="session-list">
        {sessions.map((session) => (
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
