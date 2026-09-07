import { useEffect, useMemo, useState } from 'react';

import { findSessions } from '../lib/sidecar';
import { useRelative } from '../lib/useRelative';

import type { SessionSummary } from '../../shared/protocol';

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  /**
   * The summary comes back with the id because a session found by id may not be in the
   * list at all - the caller has nowhere else to look it up from.
   */
  onSelect: (sessionId: string, session?: SessionSummary) => void;
  /** Starting a session needs a directory to start it in, which only the reader knows. */
  onCreate: () => void;
  creating: boolean;
  /** How many sessions may be resident at once; zero or absent means no cap. */
  maxLoaded?: number;
}

/**
 * When a session was last used, kept current while that still changes.
 *
 * Its own component so a recent session's clock belongs to its row rather than to the list,
 * which would otherwise re-render every row in it.
 */
function Touched({ at }: { at: string }) {
  return <>{useRelative(at)}</>;
}

/**
 * The shortest id prefix worth a lookup.
 *
 * Below this a query is far more likely to be the start of a word than of an id, and every
 * such query would reach the database for nothing.
 */
const ID_PREFIX = 6;

/** Ids are hex and dashes, so anything else in the query rules out this being one. */
const LOOKS_LIKE_ID = /^[0-9a-f-]+$/i;

/**
 * Sessions the list left out, found by id when the reader asks for one directly.
 *
 * A session with no title and no turns is hidden on purpose - most are crashed starts - but
 * one whose id was typed in was asked for by name. Returning nothing for an id that is on
 * disk reads as data loss.
 *
 * Only asked for when the visible list has nothing, so the normal case never reaches the
 * database, and debounced so holding a key down does not queue a lookup per character.
 */
function useHiddenMatches(query: string, enabled: boolean): SessionSummary[] {
  const [found, setFound] = useState<SessionSummary[]>([]);
  const needle = query.trim().toLowerCase();
  const worth = enabled && needle.length >= ID_PREFIX && LOOKS_LIKE_ID.test(needle);

  useEffect(() => {
    if (!worth) {
      setFound([]);
      return;
    }

    let current = true;
    const timer = setTimeout(() => {
      findSessions(needle)
        .then((result) => current && setFound(result.sessions))
        .catch(() => current && setFound([]));
    }, 200);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [needle, worth]);

  return found;
}

/** Sessions ordered by last use. Rendering and filtering this list never loads a session. */
export function Sidebar({ sessions, selectedId, onSelect, onCreate, creating, maxLoaded }: SidebarProps) {
  const [query, setQuery] = useState('');

  // Filtering runs over the already-fetched list, so it costs nothing and needs no query.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;

    return sessions.filter(
      (session) =>
        [session.title, session.cwd, session.repository, session.branch].some((field) =>
          field?.toLowerCase().includes(needle),
        ) ||
        // An id is usually quoted by its first characters - in CLI output, in a state
        // directory name, in a commit trailer - so it matches from the start rather than
        // anywhere, which would turn a short query into a match against every session.
        session.sessionId.toLowerCase().startsWith(needle),
    );
  }, [sessions, query]);

  const hidden = useHiddenMatches(query, matches.length === 0);

  // The list is already ordered with the loaded ones first, so the boundary is simply how
  // many of them there are.
  const loadedCount = useMemo(() => matches.filter((session) => session.loaded).length, [matches]);

  return (
    <nav className="sidebar">
      <header className="sidebar-header">
        <span>Sessions</span>
        <span className="badge">
          {query ? `${matches.length + hidden.length}/${sessions.length}` : sessions.length}
        </span>
        <button
          type="button"
          className="new-session"
          onClick={onCreate}
          disabled={creating}
          title="Start a new session"
        >
          {creating ? 'Starting…' : 'New'}
        </button>
      </header>

      <div className="search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by title, folder or id"
          spellCheck={false}
        />
      </div>

      {matches.length === 0 && hidden.length === 0 ? (
        <p className="no-matches">No sessions match that filter.</p>
      ) : (
        <ul className="session-list">
          {matches.map((session, index) => (
            <li key={session.sessionId}>
              {/* The loaded ones are the only sessions that cost anything, which is the
                  whole idea of the app, and they sat at the top marked by a four-pixel dot
                  that explained neither why they were there nor what they were. */}
              {index === loadedCount && loadedCount > 0 && <p className="group">Not loaded</p>}
              {index === 0 && loadedCount > 0 && (
                <p className="group">
                  In memory
                  {/* The plain count, not "1 of 2": the cap is not a total, and reading it
                      as one made a session that had gone to sleep look deleted. The cap
                      only matters at it, where the next session opened evicts one. */}
                  <span
                    className="group-count"
                    title={
                      maxLoaded
                        ? `${loadedCount} of at most ${maxLoaded} sessions resident. The rest cost nothing until used.`
                        : `${loadedCount} sessions resident. The rest cost nothing until used.`
                    }
                  >
                    {maxLoaded && loadedCount >= maxLoaded ? `${loadedCount} · full` : loadedCount}
                  </span>
                </p>
              )}
              <Row session={session} selectedId={selectedId} onSelect={onSelect} />
            </li>
          ))}

          {hidden.length > 0 && (
            <li>
              {/* Named for why they were missing rather than for what they are: the reader
                  typed an id, got nothing, and needs to know these were found anyway. */}
              <p className="group" title="Found by id. Hidden from the list because they have no title and no turns.">
                Not in the list
              </p>
              <ul className="session-list">
                {hidden.map((session) => (
                  <li key={session.sessionId}>
                    <Row session={session} selectedId={selectedId} onSelect={onSelect} />
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      )}
    </nav>
  );
}

/** One session in the list. Shared so a found-by-id row reads exactly like a listed one. */
function Row({
  session,
  selectedId,
  onSelect,
}: {
  session: SessionSummary;
  selectedId: string | null;
  onSelect: (sessionId: string, session?: SessionSummary) => void;
}) {
  return (
    <button
      type="button"
      className={`session${session.sessionId === selectedId ? ' selected' : ''}`}
      onClick={() => onSelect(session.sessionId, session)}
    >
      <span className="session-title">
        {session.title ?? 'Untitled session'}
        {session.loaded && <span className="dot" title="Loaded in memory" />}
      </span>
      <span className="session-meta">
        <Touched at={session.updatedAt} />
        {session.repository ? ` · ${session.repository}` : ''}
      </span>
      {session.preview && <span className="session-preview">{session.preview}</span>}
    </button>
  );
}
