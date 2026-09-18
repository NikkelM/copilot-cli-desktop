import { useEffect, useMemo, useState } from 'react';

import { useCompact } from '../lib/useCompact';

import { findSessions } from '../lib/sidecar';
import { describeActivity, type ActivityMark } from '../lib/activity';
import { useRelative } from '../lib/useRelative';
import { ChevronIcon } from './Icons';

import type { SessionSummary } from '../../shared/protocol';
import type { WatchedSubagent } from '../lib/useSubagents';

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
  /** Open the local knowledge base, which belongs to no session. */
  onWiki: () => void;
  creating: boolean;
  /** How many sessions may be resident at once; zero or absent means no cap. */
  maxLoaded?: number;
  /** What each session is doing, keyed by id. Absent means resident and idle (#115). */
  activity: Record<string, ActivityMark>;
  /**
   * The subagents watched starting, to nest under the sessions that delegated them.
   *
   * Only ones this app saw begin. Finding the rest means reading a whole session log, which
   * is seconds for a large one, and the sidebar is the part of this app that must cost
   * nothing (#178).
   */
  subagents?: WatchedSubagent[];
  /** Which subagent's transcript is open, so its row can say so. */
  selectedSubagentId?: string | null;
  onSelectSubagent?: (agentId: string) => void;
  /** Take one off the list before it ages out on its own. */
  onDismissSubagent?: (agentId: string) => void;
  /** Sessions pinned to the top. Absent is none, which is what a fresh install has. */
  favourites?: string[];
  /** Absent leaves the rows readable without offering a pin, as the subagent actions do. */
  onFavourite?: (sessionId: string) => void;
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

/** Where a folded group is remembered, so the sidebar opens as it was left. */
const FOLDED = 'copilot-desktop.folded';

function readFolded(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(FOLDED);
    return stored ? (JSON.parse(stored) as Record<string, boolean>) : {};
  } catch {
    // A store that cannot be read is one nobody can fix from here. Everything open is the
    // state the app had before this existed, so it is the safe answer.
    return {};
  }
}

/**
 * Which groups are folded, remembered across restarts.
 *
 * Worth remembering because the reason to fold is a list of two hundred, which is still
 * two hundred on the next launch. Folding it every time would be the same work again.
 */
function useFolded() {
  const [folded, setFolded] = useState<Record<string, boolean>>(readFolded);

  const toggle = (key: string) =>
    setFolded((current) => {
      const next = { ...current, [key]: !current[key] };
      try {
        localStorage.setItem(FOLDED, JSON.stringify(next));
      } catch {
        // Folding still works for this run; only remembering it does not.
      }
      return next;
    });

  return { folded, toggle };
}

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
export function Sidebar({
  sessions,
  selectedId,
  onSelect,
  onCreate,
  onWiki,
  creating,
  maxLoaded,
  activity,
  subagents,
  selectedSubagentId,
  onSelectSubagent,
  onDismissSubagent,
  favourites = [],
  onFavourite,
}: SidebarProps) {
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
  const { folded, toggle } = useFolded();
  const rows = useCompact();

  /**
   * The list, split into the groups the sidebar draws.
   *
   * The two have always been groups in everything but name, and were drawn as headings
   * spliced into the middle of a flat list by index. Made explicit so they can fold, and
   * so a third group is a row in this array rather than another index comparison.
   */
  const groups = useMemo(() => {
    // Pinned first and only once: a favourite that is also loaded belongs to the group
    // someone chose it for, not to both. Each group keeps the order it was given, which is
    // by activity, so pinning changes where a session sits and nothing else about it.
    const pinned = matches.filter((session) => favourites.includes(session.sessionId));
    const rest = matches.filter((session) => !favourites.includes(session.sessionId));
    const loaded = rest.filter((session) => session.loaded);
    const cold = rest.filter((session) => !session.loaded);

    return [
      { key: 'pinned', label: 'Pinned', sessions: pinned },
      { key: 'loaded', label: 'In memory', sessions: loaded },
      // Only named when there is something above it to tell it apart from.
      { key: 'cold', label: loaded.length > 0 || pinned.length > 0 ? 'Not loaded' : null, sessions: cold },
    ].filter((group) => group.sessions.length > 0);
  }, [matches, favourites]);

  return (
    <nav className="sidebar">
      <header className="sidebar-header">
        <button
          type="button"
          className={rows.compact ? 'sidebar-compact on' : 'sidebar-compact'}
          onClick={rows.toggleAll}
          aria-pressed={rows.compact}
          title={rows.compact ? 'Show what each session last said' : 'Show titles only'}
          aria-label={rows.compact ? 'Show session details' : 'Show titles only'}
        >
          {rows.compact ? '☰' : '≡'}
        </button>
        {/* The wiki is a destination rather than something about a session, so it is
            reached from the app's own chrome rather than from a session's header. */}
        <button
          type="button"
          className="new-session"
          onClick={onWiki}
          title="Browse your local knowledge base"
        >
          Wiki
        </button>
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
          {groups.map((group) => {
            const shut = group.label !== null && (folded[group.key] ?? false);
            // A folded group holding the open session still shows it, or the reader loses
            // where they are for the sake of a tidier list.
            const shown = shut ? group.sessions.filter((s) => s.sessionId === selectedId) : group.sessions;

            return (
              <li key={group.key}>
                {group.label !== null && (
                  <button
                    type="button"
                    className="group"
                    aria-expanded={!shut}
                    onClick={() => toggle(group.key)}
                    title={shut ? `Show the ${group.sessions.length} sessions in this group` : 'Fold this group away'}
                  >
                    <ChevronIcon open={!shut} />
                    {group.label}
                    {/* The count is what stops folding from hiding the fact that something
                        is there. The resident group carries it either way, because how many
                        sessions cost memory is the number this app exists to keep down. */}
                    {group.key === 'loaded' ? (
                      <span
                        className="group-count"
                        title={
                          maxLoaded
                            ? `${group.sessions.length} of at most ${maxLoaded} sessions resident. The rest cost nothing until used.`
                            : `${group.sessions.length} ${group.sessions.length === 1 ? 'session' : 'sessions'} resident. The rest cost nothing until used.`
                        }
                      >
                        {maxLoaded && group.sessions.length >= maxLoaded
                          ? `${group.sessions.length} · full`
                          : group.sessions.length}
                      </span>
                    ) : (
                      shut && <span className="group-count">{group.sessions.length}</span>
                    )}
                  </button>
                )}

                {shown.length > 0 && (
                  <ul className="session-list">
                    {shown.map((session) => (
                      <li key={session.sessionId}>
                        <div className="session-row">
                          <Row
                            session={session}
                            selectedId={selectedId}
                            onSelect={onSelect}
                            activity={activity[session.sessionId]}
                            collapsed={rows.collapsed(session.sessionId)}
                          />
                          <button
                            type="button"
                            className="session-fold"
                            onClick={() => rows.toggleOne(session.sessionId)}
                            aria-expanded={!rows.collapsed(session.sessionId)}
                            aria-label={`${rows.collapsed(session.sessionId) ? 'Expand' : 'Collapse'} ${session.title ?? 'Untitled session'}`}
                          >
                            <ChevronIcon open={!rows.collapsed(session.sessionId)} />
                          </button>
                          {onFavourite && (
                          <Favourite
                            on={favourites.includes(session.sessionId)}
                            title={session.title ?? 'Untitled session'}
                            onToggle={() => onFavourite(session.sessionId)}
                          />
                          )}
                        </div>
                        <Delegated
                          subagents={subagents}
                          sessionId={session.sessionId}
                          selectedSubagentId={selectedSubagentId}
                          onSelectSubagent={onSelectSubagent}
                          onDismissSubagent={onDismissSubagent}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}

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
                    <Row session={session} selectedId={selectedId} onSelect={onSelect} activity={activity[session.sessionId]} />
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

/**
 * The subagents a session delegated, under the row that delegated them.
 *
 * Only the ones watched starting, so this is a list of what is happening rather than of
 * everything that ever did - which is also what keeps it affordable, since the alternative
 * is reading the session's whole log (#178).
 */
function Delegated({
  subagents,
  sessionId,
  selectedSubagentId,
  onSelectSubagent,
  onDismissSubagent,
}: {
  subagents?: WatchedSubagent[];
  sessionId: string;
  selectedSubagentId?: string | null;
  onSelectSubagent?: (agentId: string) => void;
  onDismissSubagent?: (agentId: string) => void;
}) {
  const mine = subagents?.filter((entry) => entry.sessionId === sessionId) ?? [];
  if (mine.length === 0 || !onSelectSubagent) return null;

  return (
    <ul className="subagent-list">
      {mine.map((entry) => (
        <li key={entry.agentId} className="subagent-item">
          <button
            type="button"
            className={`subagent${entry.agentId === selectedSubagentId ? ' selected' : ''}`}
            onClick={() => onSelectSubagent(entry.agentId)}
            title={`Open what ${entry.name} did`}
          >
            {/* Running, finished or failed, in the shape the session rows already use for
                the same question - a reader who can read one can read the other. */}
            <span className={`activity activity-${entry.outcome === undefined ? 'working' : 'idle'}`} aria-hidden />
            <span className="subagent-name">{entry.name}</span>
            {entry.outcome === 'failed' && <span className="subagent-failed">failed</span>}
          </button>
          {onDismissSubagent && (
            <button
              type="button"
              className="subagent-dismiss"
              onClick={() => onDismissSubagent(entry.agentId)}
              title={`Take ${entry.name} off this list`}
              aria-label={`Take ${entry.name} off this list`}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One session in the list. Shared so a found-by-id row reads exactly like a listed one. */
/**
 * The mark that keeps a session within reach.
 *
 * Beside the row rather than inside it, because the row is itself a button and a control
 * cannot be nested in one. Only drawn when it is set or the row is under the pointer: two
 * hundred stars down the side of the list would be noise, and the one that is set is the
 * only one saying anything.
 */
function Favourite({ on, title, onToggle }: { on: boolean; title: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={on ? 'favourite on' : 'favourite'}
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? `Unpin ${title}` : `Pin ${title}`}
      title={on ? 'Unpin from the top' : 'Pin to the top'}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

function Row({
  session,
  selectedId,
  onSelect,
  activity,
  collapsed,
}: {
  session: SessionSummary;
  selectedId: string | null;
  onSelect: (sessionId: string, session?: SessionSummary) => void;
  activity?: ActivityMark;
  /** Drawn as its title alone, for a reader who already knows which session they want. */
  collapsed?: boolean;
}) {
  const mark: ActivityMark = activity ?? { state: 'idle', queued: 0 };

  return (
    <button
      type="button"
      className={`session${session.sessionId === selectedId ? ' selected' : ''}`}
      onClick={() => onSelect(session.sessionId, session)}
    >
      <span className="session-title">
        {session.title ?? 'Untitled session'}
        {/* Shape first, colour second: five states is more than a hue can carry, and a
            reader who cannot separate hues gets none of it at all.

            Kept when the row is short: it is the one thing on it that is not a reminder of
            what the session is, but a claim about what it is doing now (#187). */}
        {session.loaded && (
          <span className={`activity activity-${mark.state}`} role="img" aria-label={describeActivity(mark)} />
        )}
      </span>
      {!collapsed && (
        <>
          <span className="session-meta">
            <Touched at={session.updatedAt} />
            {session.repository ? ` · ${session.repository}` : ''}
          </span>
          {session.preview && <span className="session-preview">{session.preview}</span>}
        </>
      )}
    </button>
  );
}




