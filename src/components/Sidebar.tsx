import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

import { findSessions } from '../lib/sidecar';
import { describeActivity, type ActivityMark } from '../lib/activity';
import { useRelative } from '../lib/useRelative';
import { ChevronIcon, GearIcon } from './Icons';
import { SessionMenu, type SessionAction } from './SessionMenu';
import { SidebarToggle } from './SidebarToggle';
import { Waiting } from './Waiting';
import { hiddenReason, isEmpty, matchesQuery, parseQuery } from '../lib/sessionFilter';
import { useSessionSearch } from '../lib/useSessionSearch';
import { TagFilter } from './TagFilter';
import { Excerpt } from './Excerpt';
import { countTags } from '../lib/useTags';
import { read as readStore, save } from '../lib/store';
import type { Tags } from '../lib/useTags';

import type { SessionMatch, SessionSummary } from '../../shared/protocol';
import type { WatchedSubagent } from '../lib/useSubagents';

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  /**
   * The summary comes back with the id because a session found by id may not be in the
   * list at all - the caller has nowhere else to look it up from.
   */
  /** `found` sends the transcript to where a search match was said, rather than to the end. */
  onSelect: (sessionId: string, session?: SessionSummary, found?: SessionMatch, words?: string) => void;
  /** Starting a session needs a directory to start it in, which only the reader knows. */
  onCreate: () => void;
  /** Open the local knowledge base, which belongs to no session. */
  onWiki: () => void;
  /** Open the settings window. Absent leaves the control out. */
  onSettings?: () => void;
  /** Bring in a session exported elsewhere. Absent leaves the control out (#63). */
  onImport?: () => void;
  creating: boolean;
  /** How many sessions may be resident at once; zero or absent means no cap. */
  maxLoaded?: number;
  /** What each session is doing, keyed by id. Absent means resident and idle (#115). */
  activity: Record<string, ActivityMark>;
  /**
   * Sessions being resumed, which group with the resident ones.
   *
   * Read from here rather than from `activity`, where a resume is the lowest rank and is
   * hidden the moment the session does anything - a resume that has already produced a
   * question reads as blocked, and would otherwise fall back into Not loaded.
   */
  loading?: ReadonlySet<string>;
  /**
   * Sessions some other Copilot has open, which this app cannot stop (#63).
   *
   * Separate from `loaded`, which is this app holding one. Both write to the same log and
   * the same database, so saying which is which is the only thing the app can usefully do
   * about it.
   */
  activeElsewhere?: string[];
  /** The sessions picked out to be acted on together, which is not the one being read (#63). */
  marked?: readonly string[];
  /**
   * Whether the list is being picked over rather than read (#63).
   *
   * Changes what a plain click means, so the rows say so: each grows a box, and a bar above
   * them says how many are picked and how to stop.
   */
  selecting?: boolean;
  /** Done picking. Absent leaves the bar without its way out. */
  onDoneSelecting?: () => void;
  /**
   * What can be done to the picked set, offered as buttons in the bar.
   *
   * The same list the menu shows, so the two can never offer different things to the same
   * selection. Absent leaves the bar counting and nothing else.
   */
  selectionActions?: SessionAction[];
  /**
   * A row was clicked, with whatever modifiers it carried.
   *
   * Answers whether the click was taken as marking. True means it was, and the row should
   * not also be opened - adding a session to a set is not asking to read it.
   */
  onMark?: (sessionId: string, keys: { toggle: boolean; range: boolean }, order: readonly string[]) => boolean;
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
  /** Hide one, for a reader who is done with it before this app decides. Deletes nothing. */
  onDismissSubagent?: (agentId: string) => void;
  /** Ask for one to be kept, or let a kept one go (#180). */
  onKeepSubagent?: (agentId: string) => void;
  /** Whether a task can be kept, which is true once the log has been shown to hold it. */
  keepableSubagent?: (agentId: string) => boolean;
  isKeptSubagent?: (agentId: string) => boolean;
  /** What right-clicking a delegated task offers. Absent leaves those rows with no menu. */
  subagentActionsFor?: (entry: WatchedSubagent) => SessionAction[];
  /** Folds the sidebar away. Absent leaves the header without the control. */
  onToggle?: () => void;
  /** Said when a session's menu opens, for anything worth finding out only then. */
  onMenuOpened?: (sessionId: string) => void;
  /** What right-clicking a session offers. Absent leaves the rows with no menu at all. */
  actionsFor?: (session: SessionSummary) => SessionAction[];
  /** What is true about each session right now, which the filter box can be asked about. */
  tags?: Tags;
  /**
   * Whether those tags are drawn on the rows.
   *
   * Off is for a reader who tags sessions to filter by them rather than to read them: the
   * chips are a second line under every row that carries any, and a narrow sidebar has no
   * line to spare. The filter box and the picker are unaffected.
   */
  showTags?: boolean;
  /**
   * What each session last said, for the rows that have an answer yet (#240).
   *
   * Only the rows on screen are ever asked about, so most of this map is missing most of
   * the time, and a row without an entry simply draws no preview.
   */
  previews?: Record<string, string>;
  /** How many lines of that to draw. Zero draws none and asks for none. */
  previewLines?: number;
  /** Told which rows are drawn where a reader could read them, so previews follow the eye. */
  onWatchRow?: (sessionId: string, node: Element | null) => void;
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

/** One set rather than a new one per render, which would remake the groups every time. */
const EMPTY: ReadonlySet<string> = new Set();

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
  onImport,
  creating,
  maxLoaded,
  activity,
  loading = EMPTY,
  activeElsewhere,
  marked,
  selecting = false,
  onDoneSelecting,
  selectionActions,
  onMark,
  subagents,
  selectedSubagentId,
  onSelectSubagent,
  onDismissSubagent,
  onKeepSubagent,
  keepableSubagent,
  isKeptSubagent,
  subagentActionsFor,
  onMenuOpened,
  favourites = [],
  archived = [],
  tags = {},
  showTags = true,
  previews,
  previewLines = 0,
  onWatchRow,
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

  /**
   * What the sessions themselves said, which the list in memory cannot answer.
   *
   * Asked of the free text only. A `tag:` term narrows what is already here and has nothing
   * to look for in a transcript, so a query of only tags asks nothing.
   */
  const said = useSessionSearch(parseQuery(query).text);

  // The name half runs over the already-fetched list, so it costs nothing and needs no query.
  const { matches, named } = useMemo(() => {
    const typed = parseQuery(query);
    // Chosen and typed tags are the same ask arriving two ways, so they join one list and
    // every one of them has to be present.
    const parsed = { ...typed, tags: [...new Set([...typed.tags, ...chosen])] };
    if (isEmpty(parsed)) return { matches: sessions, named: null };

    const byName = sessions.filter((session) => matchesQuery(session, parsed, tags[session.sessionId] ?? []));
    const already = new Set(byName.map((session) => session.sessionId));
    if (said.size === 0) return { matches: byName, named: already };

    /**
     * Named first, then the ones that only said it.
     *
     * Somebody who types a word that is also a session's title means that session, and
     * burying it among thirty that mentioned the word in passing would be the wrong answer
     * to the right query. Both halves keep the list's own order, which is by last use: two
     * orderings interleaved in one list is harder to read than one, and the excerpt on a
     * row already says why it is there.
     *
     * A `tag:` term still has to hold. It narrows what is being looked at rather than
     * describing what to look for, so it applies to a session that said the word as much as
     * to one named after it.
     */
    const spoke = sessions.filter(
      (session) =>
        said.has(session.sessionId) &&
        !already.has(session.sessionId) &&
        parsed.tags.every((tag) => (tags[session.sessionId] ?? []).includes(tag)),
    );

    return { matches: [...byName, ...spoke], named: already };
  }, [sessions, query, tags, chosen, said]);

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
  /**
   * Every drawn row, by session, so the cursor has something to move focus to.
   *
   * Outside the callback that fills it: that one is rebuilt whenever the watcher changes
   * identity, and a map rebuilt with it would lose every row already on screen.
   */
  const nodes = useRef(new Map<string, HTMLElement>());

  /** The session a menu is open on, where it was opened, and whether a key opened it. */
  const [menu, setMenu] = useState<{ sessionId: string; at: { x: number; y: number }; byKey?: boolean } | null>(null);
  const openMenu = useCallback(
    (sessionId: string) => (event: ReactMouseEvent) => {
      event.preventDefault();
      // Asked as the menu opens rather than for every session in the list: this reads a
      // log, and the sidebar draws hundreds of rows nobody right-clicks.
      onMenuOpened?.(sessionId);

      // Shift+F10 and the Menu key raise this too, and what they put in the coordinates is
      // the browser's business - Chromium answers with the focused element's corner, others
      // with nothing at all. A press with no pointer behind it is placed against the row
      // instead, so the menu cannot open in the corner of the window.
      const byKey = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
      const row = byKey ? (event.currentTarget as HTMLElement).getBoundingClientRect() : null;

      setMenu({
        sessionId,
        at: row ? { x: row.left + 12, y: row.top + 12 } : { x: event.clientX, y: event.clientY },
        byKey: byKey || undefined,
      });
    },
    [onMenuOpened],
  );

  /**
   * The same menu, asked for by a key rather than by a pointer.
   *
   * Placed against the row that has the keyboard, since there is no pointer to place it at
   * and the row is what the menu is about. Inset a little so it overlaps the row the way a
   * right-click near its corner would, rather than sitting exactly on the edge.
   */
  const menuForRow = useCallback(
    (sessionId: string) => {
      const row = nodes.current.get(sessionId);
      if (!row) return;

      onMenuOpened?.(sessionId);
      const box = row.getBoundingClientRect();
      setMenu({ sessionId, at: { x: box.left + 12, y: box.top + 12 }, byKey: true });
    },
    [onMenuOpened],
  );

  /**
   * Give the row back the keyboard, for a menu that took it from there in the first place.
   *
   * On the next frame, and looked up again rather than held: an action taken from the menu
   * is usually an action on the row it was opened from, and favouriting or archiving one
   * moves it to another group - so the element focused in this tick is replaced by the
   * render that follows and the keyboard ends up on nothing.
   *
   * A session that is gone entirely leaves nothing to go back to, so the keyboard goes to
   * the top of the list instead of being dropped.
   */
  const closeMenu = useCallback(() => {
    setMenu((open) => {
      if (open?.byKey) {
        const was = open.sessionId;
        requestAnimationFrame(() => {
          const row = nodes.current.get(was);
          if (row?.isConnected) row.focus();
          else nodes.current.get(stopsRef.current[0] ?? '')?.focus();
        });
      }
      return null;
    });
  }, []);
  // Resolved against the current list rather than kept from the right-click, so an action
  // is offered for what the session is now. Sessions evict themselves while a menu is open.
  const menuSession = menu
    ? [...sessions, ...hidden].find((s) => s.sessionId === menu.sessionId)
    : undefined;

  /** The delegated task a menu is open on, which is a different list from the sessions (#225). */
  const [agentMenu, setAgentMenu] = useState<{ agentId: string; at: { x: number; y: number }; byKey?: boolean } | null>(
    null,
  );
  const openAgentMenu = useCallback(
    (agentId: string) => (event: ReactMouseEvent) => {
      event.preventDefault();
      // Stops the session row underneath opening its own menu for the session this belongs
      // to, which is a different thing being right-clicked.
      event.stopPropagation();
      // Shift+F10 and the Menu key raise this too, with nothing useful in the coordinates,
      // so a press with no pointer behind it is placed against the row - as the session
      // rows' own menu is.
      const byKey = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
      const row = byKey ? (event.currentTarget as HTMLElement).getBoundingClientRect() : null;

      setAgentMenu({
        agentId,
        at: row ? { x: row.left + 12, y: row.top + 12 } : { x: event.clientX, y: event.clientY },
        byKey: byKey || undefined,
      });
    },
    [],
  );

  /** The same menu, asked for by a key: placed against the task it is about. */
  const menuForAgent = useCallback((agentId: string) => {
    const row = nodes.current.get(`agent:${agentId}`);
    if (!row) return;

    const box = row.getBoundingClientRect();
    setAgentMenu({ agentId, at: { x: box.left + 12, y: box.top + 12 }, byKey: true });
  }, []);

  /** Give the task back the keyboard, for a menu that took it from there. */
  const closeAgentMenu = useCallback(() => {
    setAgentMenu((open) => {
      if (open?.byKey) {
        const was = `agent:${open.agentId}`;
        // A frame later and looked up again: keeping or hiding a task redraws the list, so
        // the element focused in this tick is replaced by the render that follows.
        requestAnimationFrame(() => {
          const row = nodes.current.get(was);
          if (row?.isConnected) row.focus();
          else nodes.current.get(stopsRef.current[0] ?? '')?.focus();
        });
      }
      return null;
    });
  }, []);
  // Read from the list as it is now, for the same reason the session above is: a task can
  // finish, be kept, or age out while its menu is open.
  const menuAgent = agentMenu ? subagents?.find((entry) => entry.agentId === agentMenu.agentId) : undefined;

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
    // Being resumed counts as resident. The row moves the moment it is asked for rather
    // than when the process finishes answering: a session is already costing memory while
    // it arrives, and leaving it under Not loaded for the seconds that takes says the
    // opposite of what is happening - the reader presses Load and nothing moves.
    const resident = (session: SessionSummary) => session.loaded || loading.has(session.sessionId);

    // In memory first, and everything loaded is in it: what is resident is the one thing
    // this app is about, and a session's group should say what it costs rather than what
    // was once decided about it. So a favourite that is loaded sits here rather than under
    // Favourites, and a session stopped on a question sits here in its turn rather than
    // being lifted out - the count above the list is what makes that actionable, not a
    // group of its own.
    const loaded = matches.filter(resident);

    const rest = matches.filter((session) => !resident(session));

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
  }, [matches, favourites, archived, loading]);

  /**
   * The rows as they are drawn, top to bottom, for what a Shift range means (#63).
   *
   * Only this knows it. The list arrives in one order and is drawn in another - favourites
   * first, then what is in memory, then the rest - and a folded group draws nothing but the
   * open session. A range taken over the list as handed in marked rows from a group further
   * down that were nowhere near the ones being dragged across.
   */
  const drawn = useMemo(
    () =>
      groups.flatMap((group) => {
        const shut = group.label !== null && (folded[group.key] ?? group.foldedByDefault === true);
        const shown = shut ? group.sessions.filter((s) => s.sessionId === selectedId) : group.sessions;
        return shown.map((session) => session.sessionId);
      }),
    [groups, folded, selectedId],
  );

  /** A row was clicked: marking first, since gathering rows is not going to one. */
  const clicked = useCallback(
    (sessionId: string, event: ReactMouseEvent) =>
      onMark?.(sessionId, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }, drawn) ?? false,
    [onMark, drawn],
  );

  /** The filter box, which is both where the list is narrowed and what sits above the rows. */
  const searchRef = useRef<HTMLInputElement>(null);

  /** The row of controls along the top, for the arrows that move between them. */
  const headerRef = useRef<HTMLElement>(null);

  /**
   * Whether the top row has run out of room for everything on it.
   *
   * Measured rather than set at a width somebody picked: which buttons are there varies,
   * every size in the row follows the text scale, and the sidebar is dragged to whatever
   * width suits - so a breakpoint in pixels would be wrong for most of what can be chosen.
   *
   * Summed from the children rather than read off `scrollWidth`, which stops reporting an
   * overflow the moment the row is allowed to wrap: a measure that disagrees with itself
   * once the answer has been applied flips back and forth forever. Nothing in the row
   * shrinks, so each child comes to the same width whether it has wrapped or not.
   */
  const [crowded, setCrowded] = useState(false);

  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const style = getComputedStyle(header);
      const gap = Number.parseFloat(style.columnGap) || 0;
      const inset = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      const children = [...header.children];
      const needed =
        children.reduce((total, child) => total + child.getBoundingClientRect().width, 0) +
        gap * Math.max(0, children.length - 1);

      setCrowded(needed > header.clientWidth - inset);
    };

    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(header);
    return () => resized.disconnect();
    // What is in the row, since a button arriving changes what it needs without changing
    // the size of anything the observer is watching.
  }, [waiting.length, Boolean(onSettings), Boolean(onImport), Boolean(onToggle)]);

  /** Up out of the filter row is the row of buttons above it, starting at the fold control. */
  const toHeader = useCallback(() => {
    headerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  /**
   * What an arrow means among the buttons along the top.
   *
   * Left and right walk them, which is what a row of controls does everywhere else, and down
   * carries on into the filter box and then the list - so the whole sidebar is one column to
   * walk down rather than three places that each have to be found. Tab still steps through
   * them one at a time; these are the shorter way, not the only way.
   */
  const onHeaderKey = useCallback((event: ReactKeyboardEvent) => {
    const buttons = [...(headerRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }

    const by = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (by === 0) return;

    event.preventDefault();
    // Wraps, because a row this short is quicker to reach round the end than back through
    // the middle - the same reasoning the menus already use.
    buttons[(at + by + buttons.length) % buttons.length]?.focus();
  }, []);

  /**
   * Hand a row to whoever is watching which of them are on screen.
   *
   * One callback per session, kept and handed back again, because React detaches a ref
   * whose identity changed and attaches it anew. An arrow built in the row would therefore
   * unwatch and rewatch every row on every render, and since a detached row is how the
   * watcher is told a row has gone, the list of what is on screen would empty itself.
   */
  const rowRef = useMemo(() => {
    const held = new Map<string, (node: Element | null) => void>();
    return (sessionId: string) => {
      let ref = held.get(sessionId);
      if (!ref) {
        ref = (node: Element | null) => {
          // Kept here as well as handed on, because moving the cursor has to focus a row
          // and a row is only reachable through the ref that drew it.
          if (node) nodes.current.set(sessionId, node as HTMLElement);
          else nodes.current.delete(sessionId);
          onWatchRow?.(sessionId, node);
        };
        held.set(sessionId, ref);
      }
      return ref;
    };
  }, [onWatchRow]);

  /**
   * Everything the arrows stop on, top to bottom: each group's own header, then its rows.
   *
   * Headers are stops of their own so a group can be folded on the way past rather than
   * walked through - which is the only way a long list is skippable at all. Written as
   * `group:key` so one map of nodes and one cursor can hold both kinds.
   *
   * `drawn` answers a narrower question and stays as it is: a Shift range is measured over
   * the rows it was dragged across, and a header is not one of them.
   */
  const stops = useMemo(() => {
    const list: string[] = [];
    const withTasks = (sessionId: string) => {
      list.push(sessionId);
      // Drawn under their session and reachable the same way, so the arrows walk the column
      // as it reads rather than stepping over whatever a session delegated.
      for (const { entry } of delegatedOrder(subagents, sessionId)) list.push(`agent:${entry.agentId}`);
    };

    for (const group of groups) {
      const shut = group.label !== null && (folded[group.key] ?? group.foldedByDefault === true);
      if (group.label !== null) list.push(`group:${group.key}`);
      // A folded group still shows the open session, and a row on screen is a row the
      // arrows have to reach.
      for (const session of shut ? group.sessions.filter((s) => s.sessionId === selectedId) : group.sessions) {
        withTasks(session.sessionId);
      }
    }
    // Found by id, drawn below every group and under a heading that is not a control.
    for (const session of hidden) withTasks(session.sessionId);
    return list;
  }, [groups, folded, selectedId, hidden, subagents]);

  /**
   * The same list, readable from a callback that must not be rebuilt when it changes.
   *
   * The menu's own close runs a frame later and needs somewhere to send the keyboard if the
   * session it was opened on has gone; depending on the list directly would rebuild the
   * handler on every keystroke in the filter box.
   */
  const stopsRef = useRef<readonly string[]>(stops);
  stopsRef.current = stops;

  /**
   * Which stop carries the tab stop.
   *
   * A list of hundreds that each took a stop of their own would bury everything after it, so
   * one holds it and the arrows move it - the roving tabindex every list on the machine
   * uses. Worked out rather than only stored, because what it was left on can be filtered
   * away, archived or deleted while the cursor sits there, and a tab stop on a row that is
   * gone is no tab stop at all.
   */
  const [cursor, setCursor] = useState<string | null>(null);
  const at =
    (cursor !== null && stops.includes(cursor) && cursor) ||
    (selectedId !== null && stops.includes(selectedId) && selectedId) ||
    stops[0] ||
    null;

  /** Move the cursor to a stop and take the focus there with it. */
  const goTo = useCallback((stop: string | undefined) => {
    if (!stop) return;
    setCursor(stop);
    nodes.current.get(stop)?.focus();
  }, []);

  /**
   * Moving from one stop to the next, which both kinds of stop do the same way.
   *
   * Shift extends the range as it moves, so a run of rows is gathered by holding it down
   * rather than by marking each one on the way. A header is not a session and so is not
   * something a range can include, which is why the mark is asked for only when the stop
   * landed on is a row.
   */
  const stepTo = useCallback(
    (leaving: string, to: number, event: ReactKeyboardEvent) => {
      event.preventDefault();
      // Above the first stop is the box that narrowed the list down to it. Going back up
      // into it is how a search is changed without reaching for the mouse, and it makes the
      // way in and the way out the same pair of keys.
      if (to < 0) {
        searchRef.current?.focus();
        return;
      }

      // Off the bottom is nothing rather than the top: a list that wraps takes the reader
      // somewhere they did not ask to go, and `stops[length]` is already undefined.
      const next = stops[to];
      // A range is a range of sessions. A group heading is not one, and neither is a task a
      // session delegated - both are stepped over rather than gathered.
      const gatherable = next !== undefined && !next.startsWith('group:') && !next.startsWith('agent:');
      if (event.shiftKey && gatherable) {
        // A range with nothing marked yet is measured from the session being read, which is
        // what a Shift-click after opening one means - but an arrow is pressed on a row the
        // cursor is already on, and that row may be the length of the list away from the
        // open one. Marking where it is leaving from says where this range starts.
        if (!marked?.length && !leaving.startsWith('group:') && !leaving.startsWith('agent:')) {
          onMark?.(leaving, { toggle: true, range: false }, drawn);
        }
        onMark?.(next, { toggle: false, range: true }, drawn);
      }
      goTo(next);
    },
    [stops, drawn, goTo, onMark, marked],
  );

  /**
   * What a key pressed on a group's header means.
   *
   * Only the arrows. Enter and Space belong to the button, which folds the group - the one
   * thing a header is for, and the reason it is worth stopping on at all.
   */
  const onGroupKey = useCallback(
    (key: string, event: ReactKeyboardEvent) => {
      const me = `group:${key}`;
      const from = stops.indexOf(me);
      switch (event.key) {
        case 'ArrowDown':
          return stepTo(me, from + 1, event);
        case 'ArrowUp':
          return stepTo(me, from - 1, event);
        case 'Home':
          return stepTo(me, 0, event);
        case 'End':
          return stepTo(me, stops.length - 1, event);
        default:
          return;
      }
    },
    [stops, stepTo],
  );

  /**
   * What a key pressed on a delegated task means.
   *
   * The arrows, and Enter to open what it did. Not Space: marking is about sessions, and a
   * task is not one of those - it has no part in a set something is going to be done to.
   */
  const onAgentKey = useCallback(
    (stop: string, open: () => void, event: ReactKeyboardEvent) => {
      const from = stops.indexOf(stop);
      switch (event.key) {
        case 'ArrowDown':
          return stepTo(stop, from + 1, event);
        case 'ArrowUp':
          return stepTo(stop, from - 1, event);
        case 'Home':
          return stepTo(stop, 0, event);
        case 'End':
          return stepTo(stop, stops.length - 1, event);
        case 'Enter':
          event.preventDefault();
          return open();
        case 'ContextMenu':
          event.preventDefault();
          return menuForAgent(stop.slice('agent:'.length));
        case 'F10':
          // Claimed whether shifted or not, for the reason the session rows claim it: the
          // window has no menu bar for the plain one to reach, so all it did was take the
          // keyboard away.
          event.preventDefault();
          if (event.shiftKey) menuForAgent(stop.slice('agent:'.length));
          return;
        default:
          return;
      }
    },
    [stops, stepTo, menuForAgent],
  );

  /**
   * What a key pressed on a row means.
   *
   * Enter opens, which is what the row is for. Space marks, as it does in every multi-select
   * list, routed through the same `onMark` the mouse uses so the two cannot drift apart.
   *
   * Opening is handed in rather than worked out here, because the two lists open a row on
   * different terms: a row the name found carries the search term and the words it matched,
   * and a row found by its id has neither.
   */
  const onRowKey = useCallback(
    (sessionId: string, open: () => void, event: ReactKeyboardEvent) => {
      const from = stops.indexOf(sessionId);

      switch (event.key) {
        case 'ArrowDown':
          return stepTo(sessionId, from + 1, event);
        case 'ArrowUp':
          return stepTo(sessionId, from - 1, event);
        case 'Home':
          return stepTo(sessionId, 0, event);
        case 'End':
          return stepTo(sessionId, stops.length - 1, event);
        case 'Enter':
          event.preventDefault();
          return open();
        case ' ':
          // Claimed, or the list would scroll a page down underneath the row being marked.
          event.preventDefault();
          onMark?.(sessionId, { toggle: true, range: false }, drawn);
          return;
        case 'ContextMenu':
          // Claimed so the browser does not raise its own menu event behind this one, which
          // would open the same menu a second time wherever it decided to put it.
          event.preventDefault();
          return menuForRow(sessionId);
        case 'F10':
          // Claimed either way. The window has no menu bar for the unshifted one to reach -
          // nothing in this app draws one - so all it did was take the keyboard off the row
          // and leave the next Shift+F10 pressing against nothing.
          event.preventDefault();
          if (event.shiftKey) menuForRow(sessionId);
          return;
        default:
          return;
      }
    },
    [stops, drawn, stepTo, onMark, menuForRow],
  );

  /** Built once so it is the same element wherever the row has room to put it. */
  const notice = <Waiting count={waiting.length} onJump={jump} />;

  return (
    <nav className="sidebar" data-region="sidebar">
      <header className={`sidebar-header${crowded ? ' crowded' : ''}`} ref={headerRef} onKeyDown={onHeaderKey}>
        {onToggle && <SidebarToggle hidden={false} onToggle={onToggle} />}
        {/* On the left with the fold control: both are about the app rather than about any
            session, and neither is something you reach for often enough to want it under
            the hand that is starting sessions. */}
        {onSettings && (
          <button type="button" className="icon-button" onClick={onSettings} data-tip="Settings" aria-label="Settings">
            <GearIcon />
          </button>
        )}
        {/* Moved below the buttons rather than drawn in place and reordered, so the order
            the keyboard walks stays the order the eye reads. Reordering with CSS alone
            cannot do this anyway: a flex row wraps its last item, and this one is first. */}
        {!crowded && notice}
        {/* Kept together and pushed right as a group, so the count on the left has the room
            it needs and these two stay next to each other however many there are. */}
        <div className="sidebar-actions">
          {/* The wiki is a destination rather than something about a session, so it is
              reached from the app's own chrome rather than from a session's header. */}
          <button
            type="button"
            className="new-session"
            onClick={onWiki}
            data-tip="Browse your local knowledge base (Ctrl+Shift+K)"
          >
            Wiki
          </button>
          {/* Import is about the list rather than about any session in it, so it belongs
              here beside New rather than in a session's own menu - where Export sits,
              since that one is about a particular session (#63). */}
          {onImport && (
            <button
              type="button"
              className="new-session"
              onClick={onImport}
              data-tip="Import a .zip file containing a Copilot session (Ctrl+Shift+O)"
            >
              Import
            </button>
          )}
          <button
            type="button"
            className="new-session"
            onClick={onCreate}
            disabled={creating}
            data-tip="Start a new session (Ctrl+N)"
          >
            {creating ? 'Starting…' : 'New'}
          </button>
        </div>
        {crowded && notice}
      </header>

      <div
        className="search"
        // Up out of either control here is the row of buttons above, which makes the sidebar
        // one column to walk rather than three places that each have to be found.
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp') return;
          // Not from inside the open tag list, where an arrow belongs to the list itself.
          if ((event.target as HTMLElement).closest('.tag-filter-menu')) return;

          event.preventDefault();
          toHeader();
        }}
      >
        <input
          type="search"
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by title, tag, folder or id"
          spellCheck={false}
          data-region="sidebar-search"
          // The way out of the box and into what it found. Without it the filter could be
          // typed but never acted on: the rows it narrowed down to were unreachable.
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            goTo(stops[0]);
          }}
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

      {/* Only while picking: a bar that is always there is a bar nobody reads, and the
          count is the one thing a reader cannot work out from rows they have scrolled past. */}
      {selecting && (
        <div className="selecting-bar">
          <div className="selecting-count">
            <span>{marked?.length ?? 0} selected</span>
            {onDoneSelecting && (
              <button type="button" className="selecting-cancel" onClick={onDoneSelecting}>
                Cancel
              </button>
            )}
          </div>
          {selectionActions && selectionActions.length > 0 && (
            <div className="selecting-actions">
              {selectionActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={`selecting-action${action.tone ? ` ${action.tone}` : ''}`}
                  disabled={action.refused !== undefined}
                  // The full name, since the button is wearing the short one: what the set
                  // is and how many of them, or why this cannot be done to it.
                  title={action.refused ?? action.label}
                  onClick={action.run}
                >
                  {action.brief ?? action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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
                    id={`sessions-${group.key}`}
                    aria-expanded={!shut}
                    // A stop of its own, so a group can be folded on the way past rather
                    // than walked through - which is the only thing that makes a long list
                    // skippable. Enter and Space are left to the button, which folds it.
                    ref={(node) => {
                      if (node) nodes.current.set(`group:${group.key}`, node);
                      else nodes.current.delete(`group:${group.key}`);
                    }}
                    tabIndex={`group:${group.key}` === at ? 0 : -1}
                    onKeyDown={(event) => onGroupKey(group.key, event)}
                    onFocus={() => setCursor(`group:${group.key}`)}
                    onClick={() => toggle(group.key, shut)}
                    title={
                      shut
                        ? `Show the ${group.sessions.length} ${group.sessions.length === 1 ? 'session' : 'sessions'} in this group`
                        : 'Collapse this group'
                    }
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

                {/* A listbox per group rather than one over the whole sidebar: the group
                    headers are real buttons, and a button is not something a listbox is
                    allowed to contain. Labelled by its own header, so what is being
                    stepped through is still named. */}
                {shown.length > 0 && (
                  <ul
                    className="session-list"
                    role="listbox"
                    aria-multiselectable
                    {...(group.label === null
                      ? { 'aria-label': 'Sessions' }
                      : { 'aria-labelledby': `sessions-${group.key}` })}
                  >
                    {shown.map((session) => (
                      <li key={session.sessionId} role="presentation">
                        <div
                          // Watched so the app can ask what this session last said only
                          // while the row is somewhere a reader could read it (#240).
                          ref={rowRef(session.sessionId)}
                          role="option"
                          aria-selected={session.sessionId === selectedId}
                          // One stop for the whole list, moved by the arrows (#247).
                          tabIndex={session.sessionId === at ? 0 : -1}
                          onKeyDown={(event) =>
                            onRowKey(
                              session.sessionId,
                              () =>
                                onSelect(
                                  session.sessionId,
                                  session,
                                  named?.has(session.sessionId) ? undefined : said.get(session.sessionId),
                                  parseQuery(query).text,
                                ),
                              event,
                            )
                          }
                          // Reached by Tab or by a click rather than by an arrow, so the
                          // cursor follows: leaving it behind would send the next arrow
                          // press back to wherever it used to be.
                          onFocus={() => setCursor(session.sessionId)}
                          className={`session-row${session.sessionId === selectedId ? ' selected' : ''}${marked?.includes(session.sessionId) ? ' marked' : ''}`}
                          // A row the name did not find was found by something said in it,
                          // so opening it means opening it there rather than at the end.
                          onClick={(event) => {
                            // Marking first: a ctrl or shift click is about gathering rows
                            // rather than going to one, and acting on both would open a
                            // session every time somebody added one to the set (#63).
                            if (clicked(session.sessionId, event)) return;
                            onSelect(
                              session.sessionId,
                              session,
                              named?.has(session.sessionId) ? undefined : said.get(session.sessionId),
                              parseQuery(query).text,
                            );
                          }}
                          onContextMenu={openMenu(session.sessionId)}
                        >
                          <div className="session-line">
                            {selecting && (
                              <Check
                                on={marked?.includes(session.sessionId) ?? false}
                                title={session.title ?? 'Untitled session'}
                                onPick={(event) => clicked(session.sessionId, event)}
                              />
                            )}
                            <Row
                              session={session}
                              selectedId={selectedId}
                              activity={activity[session.sessionId]}
                              elsewhere={activeElsewhere?.includes(session.sessionId)}
                            />
                            {onFavourite && (
                              <Favourite
                                on={favourites.includes(session.sessionId)}
                                title={session.title ?? 'Untitled session'}
                                onToggle={() => onFavourite(session.sessionId)}
                              />
                            )}
                          </div>
                          <SessionTags
                            tags={tags[session.sessionId]}
                            chosen={chosen}
                            onPick={pickTag}
                            shown={showTags}
                          />
                          {/* What this session last said, where that is being drawn at all.
                              Under the tags rather than above them: a tag is a fact about
                              the session, and this is the session talking (#240). */}
                          <LastSaid text={previews?.[session.sessionId]} lines={previewLines} />
                          {/* Only on a row the name did not find, which is the row whose
                              presence needs explaining. */}
                          {/* Why the row is here, when that is not already on it: the words
                              it said, or the folder or branch its name does not show. */}
                          <Excerpt
                            excerpt={
                              named?.has(session.sessionId)
                                ? (hiddenReason(session, parseQuery(query)) ?? undefined)
                                : said.get(session.sessionId)?.excerpt
                            }
                          />
                        </div>
                        <Delegated
                          subagents={subagents}
                          sessionId={session.sessionId}
                          selectedSubagentId={selectedSubagentId}
                          onSelectSubagent={onSelectSubagent}
                          onDismissSubagent={onDismissSubagent}
                          onKeepSubagent={onKeepSubagent}
                          keepable={keepableSubagent}
                          isKept={isKeptSubagent}
                          onMenu={openAgentMenu}
                          at={at}
                          onStopKey={onAgentKey}
                          onStopFocus={setCursor}
                          hold={(stop, node) => {
                            if (node) nodes.current.set(stop, node);
                            else nodes.current.delete(stop);
                          }}
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
              <p
                className="group"
                id="sessions-not-listed"
                title="Found by id. These sessions have no title and no turns."
              >
                Not in the list
              </p>
              <ul className="session-list" role="listbox" aria-multiselectable aria-labelledby="sessions-not-listed">
                {hidden.map((session) => (
                  <li key={session.sessionId} role="presentation">
                    <div
                      // Watched like the rows above it: a session found by id has no title,
                      // so what it last said is the only thing identifying it (#240).
                      ref={rowRef(session.sessionId)}
                      role="option"
                      aria-selected={session.sessionId === selectedId}
                      tabIndex={session.sessionId === at ? 0 : -1}
                      onKeyDown={(event) =>
                        onRowKey(session.sessionId, () => onSelect(session.sessionId, session), event)
                      }
                      onFocus={() => setCursor(session.sessionId)}
                      className={`session-row${session.sessionId === selectedId ? ' selected' : ''}${marked?.includes(session.sessionId) ? ' marked' : ''}`}
                      onClick={(event) => {
                        if (clicked(session.sessionId, event)) return;
                        onSelect(session.sessionId, session);
                      }}
                      onContextMenu={openMenu(session.sessionId)}
                    >
                      <div className="session-line">
                        {selecting && (
                          <Check
                            on={marked?.includes(session.sessionId) ?? false}
                            title={session.title ?? 'Untitled session'}
                            onPick={(event) => clicked(session.sessionId, event)}
                          />
                        )}
                        <Row
                          session={session}
                          selectedId={selectedId}
                          activity={activity[session.sessionId]}
                          elsewhere={activeElsewhere?.includes(session.sessionId)}
                        />
                      </div>
                      <SessionTags tags={tags[session.sessionId]} chosen={chosen} onPick={pickTag} shown={showTags} />
                      <LastSaid text={previews?.[session.sessionId]} lines={previewLines} />
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
          focusFirst={menu.byKey}
          onClose={closeMenu}
        />
      )}

      {agentMenu && menuAgent && subagentActionsFor && (
        <SessionMenu
          at={agentMenu.at}
          actions={subagentActionsFor(menuAgent)}
          focusFirst={agentMenu.byKey}
          onClose={closeAgentMenu}
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
/**
 * A session's delegated tasks, flattened into the order they are drawn.
 *
 * Depth-first, each task followed by whatever it delegated in turn, which is how the list
 * reads - the indent is what says who sent what. A task whose parent is not in the list is
 * drawn at the top rather than hidden: the parent may have aged out, been hidden, or never
 * been watched, and a task that exists with nowhere to sit is still a task somebody wants.
 *
 * Shared by the rows and by the cursor that walks them, so what is on screen and what the
 * arrows step through cannot drift apart.
 */
export function delegatedOrder(
  subagents: readonly WatchedSubagent[] | undefined,
  sessionId: string,
): { entry: WatchedSubagent; depth: number }[] {
  const mine = subagents?.filter((entry) => entry.sessionId === sessionId) ?? [];
  const held = new Set(mine.map((entry) => entry.agentId));
  const out: { entry: WatchedSubagent; depth: number }[] = [];

  const walk = (parent: string | undefined, depth: number) => {
    const under = mine.filter((entry) =>
      parent === undefined ? !entry.parentAgentId || !held.has(entry.parentAgentId) : entry.parentAgentId === parent,
    );
    for (const entry of under) {
      out.push({ entry, depth });
      walk(entry.agentId, depth + 1);
    }
  };

  walk(undefined, 0);
  return out;
}

function Delegated({
  subagents,
  sessionId,
  selectedSubagentId,
  onSelectSubagent,
  onDismissSubagent,
  onKeepSubagent,
  keepable,
  isKept,
  onMenu,
  at,
  onStopKey,
  onStopFocus,
  hold,
}: {
  subagents?: WatchedSubagent[];
  sessionId: string;
  selectedSubagentId?: string | null;
  onSelectSubagent?: (agentId: string) => void;
  onDismissSubagent?: (agentId: string) => void;
  onKeepSubagent?: (agentId: string) => void;
  /** Whether a task can be kept, which is true once the log has been shown to hold it. */
  keepable?: (agentId: string) => boolean;
  isKept?: (agentId: string) => boolean;
  /** Opens this row's own menu, so a right-click is answered by the app rather than the webview. */
  onMenu?: (agentId: string) => (event: ReactMouseEvent) => void;
  /** Which stop the sidebar's cursor is on, so one row of the whole list carries the tab stop. */
  at?: string | null;
  onStopKey?: (stop: string, open: () => void, event: ReactKeyboardEvent) => void;
  onStopFocus?: (stop: string) => void;
  /** Holds each row, so the cursor has somewhere to send the keyboard. */
  hold?: (stop: string, node: HTMLElement | null) => void;
}) {
  const drawn = delegatedOrder(subagents, sessionId);
  if (drawn.length === 0 || !onSelectSubagent) return null;

  return (
    /* A group of the sessions listbox rather than a list of its own. A listbox may hold
       options and groups of them, and these buttons used to sit inside it belonging to
       neither - the same thing #247 fixed one level up.

       Flat, with the indent carrying the nesting. A task that delegated others cannot hold
       them as a list inside its own option, and the indent was already what said who sent
       what, so nothing is lost by drawing them in one run. */
    <ul className="subagent-list" role="group" aria-label="Delegated tasks">
      {drawn.map(({ entry, depth }) => {
        const stop = `agent:${entry.agentId}`;
        const open = () => onSelectSubagent(entry.agentId);

        return (
          <li
            key={entry.agentId}
            className="subagent-item"
            role="option"
            aria-selected={entry.agentId === selectedSubagentId}
            aria-label={entry.name}
            tabIndex={stop === at ? 0 : -1}
            ref={(node) => hold?.(stop, node)}
            onKeyDown={(event) => onStopKey?.(stop, open, event)}
            onFocus={() => onStopFocus?.(stop)}
            onContextMenu={onMenu?.(entry.agentId)}
            // Indented by how far down it sits, since that is what says who sent it.
            style={depth > 0 ? { paddingLeft: `${depth * 12}px` } : undefined}
          >
            <button
              type="button"
              className="subagent"
              tabIndex={-1}
              onClick={open}
              title={`Open what ${entry.name} did`}
            >
              {/* Running, finished or failed, in the shape the session rows already use for
                  the same question - a reader who can read one can read the other. */}
              <span className={`activity activity-${entry.outcome === undefined ? 'working' : 'idle'}`} aria-hidden />
              <span className="subagent-name">{entry.name}</span>
              {entry.outcome === 'failed' && (
                <span className="subagent-failed" title={entry.error}>
                  failed
                </span>
              )}
            </button>

            {/* Kept tasks stop ageing out, which is the whole point: the long audit worth
                coming back to is the first one the conversation leaves behind (#180). Only
                offered once the log holds its work, since that is what makes keeping it cost
                a name rather than its megabytes.

                Out of the tab order like the session rows' own controls, and on the row's
                menu for a reader without a pointer. */}
            {onKeepSubagent && keepable?.(entry.agentId) && (
              <button
                type="button"
                className={`subagent-keep${isKept?.(entry.agentId) ? ' kept' : ''}`}
                tabIndex={-1}
                onClick={() => onKeepSubagent(entry.agentId)}
                title={isKept?.(entry.agentId) ? `Stop keeping ${entry.name}` : `Keep ${entry.name}`}
                aria-label={isKept?.(entry.agentId) ? `Stop keeping ${entry.name}` : `Keep ${entry.name}`}
                aria-pressed={isKept?.(entry.agentId) ?? false}
              >
                ★
              </button>
            )}
            {onDismissSubagent && (
              <button
                type="button"
                className="subagent-dismiss"
                tabIndex={-1}
                onClick={() => onDismissSubagent(entry.agentId)}
                title={`Hide ${entry.name}`}
                aria-label={`Hide ${entry.name}`}
              >
                {/* The cross, not the multiplication sign. That one is a maths operator: it
                    draws at 6x7px where the star beside it draws at 15x15, and sits six
                    pixels lower because it is centred on the maths axis rather than the cap
                    height - so the pair read as a star next to a smudge. */}
                ✕
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What a session last said, under its name (#240).
 *
 * Clamped to however many lines the reader asked for, and absent entirely at zero: that is
 * a feature switched off rather than a narrower row.
 *
 * The clamp is set here rather than through a custom property in the stylesheet. Chromium
 * takes `-webkit-line-clamp` as a plain number and not as a `var()` that resolves to one,
 * and the difference between those two is a row that clamps and a row that does not.
 */
function LastSaid({ text, lines }: { text?: string; lines: number }) {
  if (!text || lines <= 0) return null;

  return (
    <p className="session-said" style={{ WebkitLineClamp: lines }}>
      {text}
    </p>
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
  shown = true,
}: {
  tags?: readonly string[];
  chosen: readonly string[];
  onPick: (tag: string) => void;
  /**
   * Whether tags are drawn on a row at all.
   *
   * Decided here rather than at each of the two places that draw a row, so the answer is in
   * one place and a row added later cannot forget to ask it.
   *
   * No exception for a tag that is currently filtering. It was worth considering - a list
   * narrowed with nothing saying why is a bad place to be - but the control that narrowed
   * it says so itself, in its own label and its count, and the exception would have covered
   * only tags picked there rather than ones typed into the box.
   */
  shown?: boolean;
}) {
  if (!shown || tags.length === 0) return null;

  return (
    <span className="session-tags">
      {tags.map((tag) => (
        <button
          type="button"
          key={tag}
          className={chosen.includes(tag) ? 'tag on' : 'tag'}
          aria-pressed={chosen.includes(tag)}
          // Not a stop: the row is one option of a list, and these would be several more
          // stops apiece. Filtering by a tag is what the control beside the search box is
          // for, which is where the keyboard reaches it.
          tabIndex={-1}
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
/**
 * The box that says whether a row is picked (#63).
 *
 * Drawn only while picking. A box on every row the rest of the time would take width from
 * the titles for a gesture used on a handful of days, and the titles are already as narrow
 * as they read.
 *
 * It is a control of its own rather than a mark on the row, so the keyboard can reach it
 * and a reader who aims at it gets what they aimed at. Clicking anywhere else on the row
 * does the same thing, which is why the click stops here: handled twice it would toggle and
 * toggle back.
 */
function Check({
  on,
  title,
  onPick,
}: {
  on: boolean;
  title: string;
  onPick: (event: ReactMouseEvent) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={on ? `Deselect ${title}` : `Select ${title}`}
      className={on ? 'session-check on' : 'session-check'}
      // Space on the row does this, and the row is the one stop the list holds.
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onPick(event);
      }}
    >
      {on ? '✓' : ''}
    </button>
  );
}

function Favourite({ on, title, onToggle }: { on: boolean; title: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={on ? 'favourite on' : 'favourite'}
      // Not a stop of its own. The row around it is one option of a list, and an option is
      // not allowed to hold controls - Tab stopped three times on every row before this.
      // Favouriting is on the row's own menu, so nothing here is only a click target (#247).
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      aria-pressed={on}
      aria-label={on ? `Unfavourite ${title}` : `Favourite ${title}`}
      title={on ? 'Remove from favourites' : 'Add to favourites'}
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
  elsewhere,
}: {
  session: SessionSummary;
  selectedId: string | null;
  activity?: ActivityMark;
  /** Some other Copilot has this session open, which this app cannot stop (#63). */
  elsewhere?: boolean;
}) {
  const mark: ActivityMark = activity ?? { state: 'idle', queued: 0 };
  const shown = session.title === null ? 'Untitled session' : clipTitle(session.title);
  /**
   * The whole name, only where the one on screen is not it.
   *
   * The row is inside a scrolling list, which clips anything the page draws beyond it, so a
   * name the browser draws is the one label here that still earns its keep. It is worth
   * nothing at all when it only repeats the row, which is almost always.
   */
  const full = session.title !== null && shown !== session.title ? session.title : undefined;

  // Selecting is the whole row's job, so this button does not also do it: the click it
  // raises, including the one Enter raises for a keyboard, reaches the row on the way up.
  return (
    <button
      type="button"
      className={`session${session.sessionId === selectedId ? ' selected' : ''}`}
      // The row itself is the option the keyboard lands on, and Enter there opens the
      // session - which is all this would do.
      tabIndex={-1}
      // A pointer should not leave a focus ring behind. Chromium counts a Ctrl or Shift
      // click as keyboard-ish and draws one, so marking a range left a box around the last
      // row touched - while the row itself was already saying it was marked (#63). Focus
      // still follows Tab, which is the case the ring is for.
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="session-title" title={full}>
        {shown}
        {/* A word rather than another dot. The dot beside it is this app saying what it is
            doing, and this is the opposite - a session being worked in somewhere this app
            has no say over, which is a different kind of thing and must not read as a
            louder version of the same one (#63). */}
        {elsewhere && (
          <span
            className="session-elsewhere"
            title="Open in a terminal as well. Both write to the same conversation, so the last one to write wins."
          >
            CLI
          </span>
        )}
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








