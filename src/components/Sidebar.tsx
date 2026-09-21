import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { findSessions } from '../lib/sidecar';
import { describeActivity, type ActivityMark } from '../lib/activity';
import { useRelative } from '../lib/useRelative';
import { ChevronIcon, GearIcon } from './Icons';
import { SessionMenu, type SessionAction } from './SessionMenu';
import { SidebarToggle } from './SidebarToggle';
import { Waiting } from './Waiting';
import { isEmpty, matchesQuery, parseQuery } from '../lib/sessionFilter';
import { TagFilter } from './TagFilter';
import { countTags } from '../lib/useTags';
import { read as readStore, save } from '../lib/store';
import type { Tags } from '../lib/useTags';

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
  /** Open the settings window. Absent leaves the control out. */
  onSettings?: () => void;
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
  /** Folds the sidebar away. Absent leaves the header without the control. */
  onToggle?: () => void;
  /** What right-clicking a session offers. Absent leaves the rows with no menu at all. */
  actionsFor?: (session: SessionSummary) => SessionAction[];
  /** What is true about each session right now, which the filter box can be asked about. */
  tags?: Tags;
  /** Sessions put away, which fold into a group of their own. */
  archived?: string[];
  /** Sessions kept among the favourites. Absent is none, which is what a fresh install has. */
  favourites?: string[];
  /** Absent leaves the rows readable without offering the mark, as the subagent actions do. */
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
    const stored = readStore('sessions', FOLDED);
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

  /**
   * Fold a group, or unfold it.
   *
   * Told what the group is doing now rather than working it out from what is stored. A group
   * that folds itself by default has nothing stored, so flipping the stored value would set
   * it to folded - which it already is - and the first press would do nothing at all.
   */
  const toggle = (key: string, shut: boolean) =>
    setFolded((current) => {
      const next = { ...current, [key]: !shut };
      try {
        save('sessions', FOLDED, JSON.stringify(next));
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
  onSettings,
  creating,
  maxLoaded,
  activity,
  subagents,
  selectedSubagentId,
  onSelectSubagent,
  onDismissSubagent,
  favourites = [],
  archived = [],
  tags = {},
  onFavourite,
  actionsFor,
  onToggle,
}: SidebarProps) {
  const [query, setQuery] = useState('');

  /** Tags chosen to filter by, from the menu or from a chip on a row. */
  const [chosen, setChosen] = useState<string[]>([]);
  const pickTag = useCallback(
    (tag: string) => setChosen((current) => (current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag])),
    [],
  );

  // Filtering runs over the already-fetched list, so it costs nothing and needs no query.
  const matches = useMemo(() => {
    const typed = parseQuery(query);
    // Chosen and typed tags are the same ask arriving two ways, so they join one list and
    // every one of them has to be present.
    const parsed = { ...typed, tags: [...new Set([...typed.tags, ...chosen])] };
    if (isEmpty(parsed)) return sessions;

    return sessions.filter((session) => matchesQuery(session, parsed, tags[session.sessionId] ?? []));
  }, [sessions, query, tags, chosen]);

  /** What the menu offers: how many sessions each tag would leave, given what is already chosen. */
  const known = useMemo(() => countTags(tags, chosen), [tags, chosen]);

  // A tag that no session carries at all cannot narrow anything, and leaving it chosen would
  // empty the list with nothing on screen explaining why. Asked of every session rather than
  // of `known`, which keeps a chosen tag listed however few sessions it would leave.
  useEffect(() => {
    const inUse = new Set(Object.values(tags).flat());
    setChosen((current) => (current.every((tag) => inUse.has(tag)) ? current : current.filter((tag) => inUse.has(tag))));
  }, [tags]);

  const hidden = useHiddenMatches(query, matches.length === 0);
  const { folded, toggle } = useFolded();
  /** The session a menu is open on, and where the pointer was when it opened. */
  const [menu, setMenu] = useState<{ sessionId: string; at: { x: number; y: number } } | null>(null);
  const openMenu = useCallback(
    (sessionId: string) => (event: ReactMouseEvent) => {
      event.preventDefault();
      setMenu({ sessionId, at: { x: event.clientX, y: event.clientY } });
    },
    [],
  );
  // Resolved against the current list rather than kept from the right-click, so an action
  // is offered for what the session is now. Sessions evict themselves while a menu is open.
  const menuSession = menu
    ? [...sessions, ...hidden].find((s) => s.sessionId === menu.sessionId)
    : undefined;

  /**
   * The list, split into the groups the sidebar draws.
   *
   * The two have always been groups in everything but name, and were drawn as headings
   * spliced into the middle of a flat list by index. Made explicit so they can fold, and
   * so a third group is a row in this array rather than another index comparison.
   */
  /** Sessions stopped on a question, which both the count and the top group read. */
  const waiting = useMemo(
    () => sessions.filter((session) => activity[session.sessionId]?.state === 'blocked'),
    [sessions, activity],
  );

  /**
   * Move to the next session waiting, so the count is actionable rather than only a number.
   *
   * Next rather than first: with several waiting, pressing it repeatedly should walk them
   * instead of returning to the same one.
   */
  const jump = useCallback(() => {
    if (waiting.length === 0) return;
    const at = waiting.findIndex((session) => session.sessionId === selectedId);
    const next = waiting[(at + 1) % waiting.length];
    if (next) onSelect(next.sessionId, next);
  }, [waiting, selectedId, onSelect]);

  const groups = useMemo(() => {
    // In memory first, and everything loaded is in it: what is resident is the one thing
    // this app is about, and a session's group should say what it costs rather than what
    // was once decided about it. So a favourite that is loaded sits here rather than under
    // Favourites, and a session stopped on a question sits here in its turn rather than
    // being lifted out - the count above the list is what makes that actionable, not a
    // group of its own.
    const loaded = matches.filter((session) => session.loaded);

    const rest = matches.filter((session) => !session.loaded);

    // Put away next. #101 warns that three overlapping reasons a session might not appear is
    // one more than can be reasoned about, so archiving hides nothing: it folds a group away.
    // Only cold sessions reach here, since loading one takes it out of the archive.
    const put = rest.filter((session) => archived.includes(session.sessionId));
    const around = rest.filter((session) => !archived.includes(session.sessionId));

    // Favourites are what is left of the choice once loadedness has had its say: the ones
    // kept within reach that are not currently costing anything.
    const favoured = around.filter((session) => favourites.includes(session.sessionId));
    const cold = around.filter((session) => !favourites.includes(session.sessionId));

    return [
      { key: 'loaded', label: 'In memory', sessions: loaded },
      { key: 'favourites', label: 'Favourites', sessions: favoured },
      // Only named when there is something above it to tell it apart from.
      {
        key: 'cold',
        label: loaded.length > 0 || favoured.length > 0 ? 'Not loaded' : null,
        sessions: cold,
      },
      { key: 'archived', label: 'Archived', sessions: put, foldedByDefault: true },
    ].filter((group) => group.sessions.length > 0);
  }, [matches, favourites, archived]);

  return (
    <nav className="sidebar">
      <header className="sidebar-header">
        {onToggle && <SidebarToggle hidden={false} onToggle={onToggle} />}
        <Waiting count={waiting.length} onJump={jump} />
        {/* Kept together and pushed right as a group, so the count on the left has the
            room it needs and these three stay next to each other however many there are.
            Settings first, because it is the one that is least often wanted. */}
        <div className="sidebar-actions">
          {onSettings && (
            <button type="button" className="icon-button" onClick={onSettings} title="Settings" aria-label="Settings">
              <GearIcon />
            </button>
          )}
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
        </div>
      </header>

      <div className="search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by title, tag, folder or id"
          spellCheck={false}
        />
        {/* Beside the box rather than in the header: it narrows the list, which is what the
            box does, and the two are read together. */}
        <TagFilter
          known={known}
          chosen={chosen}
          onToggle={pickTag}
          onClear={() => setChosen([])}
        />
      </div>

      {matches.length === 0 && hidden.length === 0 ? (
        <p className="no-matches">No sessions match that filter.</p>
      ) : (
        <ul className="session-list">
          {groups.map((group) => {
            const shut = group.label !== null && (folded[group.key] ?? group.foldedByDefault === true);
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
                    onClick={() => toggle(group.key, shut)}
                    title={shut ? `Show the ${group.sessions.length} sessions in this group` : 'Fold this group away'}
                  >
                    <ChevronIcon open={!shut} />
                    {group.label}
                    {/* Every group carries its count, open or folded. Folded it is what
                        stops the group hiding the fact that something is there; open it is
                        still the fastest answer to how much is in there, and a count that
                        appears only on folding reads as the number having changed. The
                        resident group adds the cap, because how many sessions cost memory is
                        the number this app exists to keep down. */}
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
                      <span className="group-count">{group.sessions.length}</span>
                    )}
                  </button>
                )}

                {shown.length > 0 && (
                  <ul className="session-list">
                    {shown.map((session) => (
                      <li key={session.sessionId}>
                        <div
                          className={`session-row${session.sessionId === selectedId ? ' selected' : ''}`}
                          onClick={() => onSelect(session.sessionId, session)}
                          onContextMenu={openMenu(session.sessionId)}
                        >
                          <div className="session-line">
                            <Row
                              session={session}
                              selectedId={selectedId}
                              activity={activity[session.sessionId]}
                            />
                            {onFavourite && (
                              <Favourite
                                on={favourites.includes(session.sessionId)}
                                title={session.title ?? 'Untitled session'}
                                onToggle={() => onFavourite(session.sessionId)}
                              />
                            )}
                          </div>
                          <SessionTags tags={tags[session.sessionId]} chosen={chosen} onPick={pickTag} />
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
                    <div
                      className={`session-row${session.sessionId === selectedId ? ' selected' : ''}`}
                      onClick={() => onSelect(session.sessionId, session)}
                      onContextMenu={openMenu(session.sessionId)}
                    >
                      <div className="session-line">
                        <Row session={session} selectedId={selectedId} activity={activity[session.sessionId]} />
                      </div>
                      <SessionTags tags={tags[session.sessionId]} chosen={chosen} onPick={pickTag} />
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      )}

      {menu && menuSession && actionsFor && (
        <SessionMenu
          at={menu.at}
          actions={actionsFor(menuSession)}
          onClose={() => setMenu(null)}
        />
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

/**
 * What is true about a session, under its row, and a way to see the rest like it.
 *
 * Pressing one narrows the list to sessions carrying it, which is the same thing the tag menu
 * does and shares its state. Outside the row's own button rather than inside it: a control
 * cannot be nested in one, and these have something of their own to do (#123).
 */
function SessionTags({
  tags = [],
  chosen,
  onPick,
}: {
  tags?: readonly string[];
  chosen: readonly string[];
  onPick: (tag: string) => void;
}) {
  if (tags.length === 0) return null;

  return (
    <span className="session-tags">
      {tags.map((tag) => (
        <button
          type="button"
          key={tag}
          className={chosen.includes(tag) ? 'tag on' : 'tag'}
          aria-pressed={chosen.includes(tag)}
          title={chosen.includes(tag) ? `Stop filtering by ${tag}` : `Show only sessions tagged ${tag}`}
          onClick={(event) => {
            // The row opens the session; this asks about every session like it.
            event.stopPropagation();
            onPick(tag);
          }}
        >
          {tag}
        </button>
      ))}
    </span>
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
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      aria-pressed={on}
      aria-label={on ? `Unfavourite ${title}` : `Favourite ${title}`}
      title={on ? 'Remove from favourites' : 'Keep among the favourites'}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

/**
 * Longest title drawn in a row, in characters.
 *
 * Well past any name the runtime generates - the longest on this machine is 44 - and past
 * most that anyone types, so this only bites on a title that is not really a title. A
 * session this app starts keeps its entire first prompt as its name, and one of those is
 * 303 characters, which fills thirteen lines of the sidebar on its own (#197).
 */
const MAX_TITLE = 90;

/** The title as a single line, cut if it is long enough to crowd out the list. */
function clipTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

function Row({
  session,
  selectedId,
  activity,
}: {
  session: SessionSummary;
  selectedId: string | null;
  activity?: ActivityMark;
}) {
  const mark: ActivityMark = activity ?? { state: 'idle', queued: 0 };

  // Selecting is the whole row's job, so this button does not also do it: the click it
  // raises, including the one Enter raises for a keyboard, reaches the row on the way up.
  return (
    <button type="button" className={`session${session.sessionId === selectedId ? ' selected' : ''}`}>
      <span className="session-title" title={session.title ?? undefined}>
        {session.title === null ? 'Untitled session' : clipTitle(session.title)}
        {/* Shape first, colour second: five states is more than a hue can carry, and a
            reader who cannot separate hues gets none of it at all.

            Kept when the row is short: it is the one thing on it that is not a reminder of
            what the session is, but a claim about what it is doing now (#187). */}
        {(session.loaded || mark.state === 'loading') && (
          <span className={`activity activity-${mark.state}`} role="img" aria-label={describeActivity(mark)} />
        )}
      </span>
      <span className="session-meta">
        <Touched at={session.updatedAt} />
        {session.repository ? ` · ${session.repository}` : ''}
      </span>
    </button>
  );
}








