import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { TranscriptEvent } from '../../shared/protocol';
import { sameEntry, toEntries, type Entry, type ReasoningEntry, type ToolEntry } from '../lib/transcriptEntries';
import { useBudgetedEntries } from '../lib/useBudgetedEntries';
import { fileBadge } from '../lib/fileBadge';
import { countChanges, parsePatch } from '../lib/patch';
import { formatClock, formatExact } from '../lib/time';
import { ASSUMED_DISPLAY, type CliDisplay } from '../lib/useCliDisplay';
import { CopyButton } from './CopyButton';
import { Diff } from './Diff';
import { Elapsed } from './Elapsed';
import { ChevronIcon } from './Icons';
import { Markdown } from './Markdown';

/**
 * How far from the bottom still counts as being at it.
 *
 * Small on purpose: scrolling away at all means the reader is looking at something, and
 * a reply arriving should not drag them off it. Not zero, because scroll metrics are
 * fractional and an exact comparison would come loose at some zoom levels.
 */
const BOTTOM_TOLERANCE_PX = 4;

/** How close to the top triggers loading the previous page. */
const LOAD_OLDER_THRESHOLD_PX = 120;

/**
 * How many times a page may extend itself to fill the view before the reader has to ask.
 *
 * A list that cannot scroll fires no scroll event, so a page drawing too few rows to fill
 * the window leaves no way to reach what is above it - and a page can draw very few: a
 * delegation whose call is further back than the page reaches collapses into one row
 * however much work is behind it. Capped rather than repeated until it fills, because a
 * session that is almost entirely delegated work would otherwise load all of itself.
 */
const AUTO_FILL_LIMIT = 4;

/**
 * How long the view has to stay at the bottom before history reached by scrolling up is
 * given back.
 *
 * Long enough that passing through the bottom does not count as having finished with what
 * is above it, and short enough that the reader is not still paying for it a conversation
 * later. Ten seconds is roughly the gap between reading something and typing about it.
 */
const DROP_OLDER_AFTER_MS = 10_000;

/**
 * How long a scroll this component caused goes on being its own rather than the reader's.
 *
 * A scroll event says nothing about who caused it, and `scrollIntoView` raises one like any
 * other - so without this, putting the reader on a match reads as them having scrolled there.
 */
const OWN_SCROLL_MS = 150;

/** Why a skill arrived, for the rows where that is not the reader's own doing. */
const SKILL_NOTE: Record<string, string> = {
  agent: 'skill invoked by the agent',
  context: 'skill loaded with the agent',
};

const STATUS_GLYPH: Record<ToolEntry['status'], string> = {
  running: '·',
  ok: '✓',
  failed: '✕',
  cancelled: '⊘',
};

/**
 * The model's thinking, folded away until asked for.
 *
 * Open while it is being written, because the wait before a reply is the longest the
 * window is ever silent and this is the only thing that fills it. Closed once read back
 * from a log: it is usually longer than the answer it produced, and a transcript where
 * every reply is preceded by paragraphs of reasoning is one nobody can scan.
 */
function ReasoningRow({ entry }: { entry: ReasoningEntry }) {
  const [open, setOpen] = useState(Boolean(entry.streaming));
  const words = entry.body.trim().split(/\s+/).length;

  return (
    <div className={`reasoning${open ? ' open' : ''}`}>
      <button type="button" className="reasoning-head" onClick={() => setOpen((was) => !was)}>
        <ChevronIcon open={open} />
        <span className="reasoning-label">Thinking</span>
        {/* Kept when open: it describes the row, not the fact that it is folded. */}
        <span className="reasoning-count">{words} words</span>
      </button>
      {open && (
        <div className="reasoning-body">
          <Markdown body={entry.body} anchor={entry.key} />
        </div>
      )}
    </div>
  );
}

/**
 * What the CLI's settings say this transcript should draw.
 *
 * A context rather than a prop, because the rows that answer to it are several levels down
 * and everything in between would be carrying an answer to a question it does not ask.
 */
const Shows = createContext<CliDisplay>(ASSUMED_DISPLAY);

/**
 * When a message was said.
 *
 * A clock, not "5m ago": the transcript is already in order, so a reader looking at a line
 * wants the time it happened at. Fixed text, so unlike the sidebar it needs no ticker.
 */
function Said({ at }: { at: string }) {
  return (
    <time dateTime={at} title={formatExact(at)}>
      {formatClock(at)}
    </time>
  );
}

/** The first line with anything on it, for a header that has room for one. */
function firstLine(text: string | null): string | null {
  const line = text?.split('\n').find((candidate) => candidate.trim() !== '');
  return line ? line.trim() : null;
}

/** A single tool call, collapsed to one line until expanded. */
function ToolRow({ entry }: { entry: ToolEntry }) {
  const shows = useContext(Shows);
  // Collapsed like every other row, including a delegated task: its work is watched from
  // the sidebar entry, which is somewhere that survives the row scrolling away.
  const [open, setOpen] = useState(false);

  // The offered options say more than the tool's own "User responded: x", which only
  // repeats what the header already shows. They are worth seeing even unanswered.
  const choices = entry.choices?.length ? entry.choices : null;
  // A typed reply is not among the options, so it needs its own line to appear at all.
  const freeform = choices && entry.answer && !choices.includes(entry.answer) ? entry.answer : null;

  // What a file tool changed, which is the reason to open its row at all.
  const patch = entry.patch ? parsePatch(entry.patch) : null;
  const changed = patch ? countChanges(patch) : null;

  const expandable =
    Boolean(entry.output) ||
    Boolean(choices) ||
    Boolean(entry.command) ||
    Boolean(patch) ||
    Boolean(entry.children?.length);
  const lines = entry.output ? entry.output.split('\n').length : 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 'es'}`;

  // A failed tool's output is the error, and the header is where it is read. Only the
  // first line: an error that runs to a stack trace would otherwise push the row's own
  // content off the screen, and the rest is still there behind the expander.
  const failure = entry.status === 'failed' ? firstLine(entry.output) : null;

  // A file row wears its file type where a finished, unremarkable row would show a tick,
  // which is what the CLI does and costs nothing: a green tick beside a green +2 -5 says
  // the same thing twice. Only when settled and successful - the other three states have
  // something to report, and reporting it is worth more than naming the file's language.
  const badge = entry.status === 'ok' && entry.path ? fileBadge(entry.path) : null;

  // Finding nothing is a result worth stating, and it is the one case with no output to
  // count, so a search says how it went rather than how much came back.
  const count = choices
    ? `${choices.length} ${choices.length === 1 ? 'option' : 'options'}`
    : changed
      ? null
      : entry.search && entry.status === 'ok'
        ? lines > 0
          ? plural(lines, 'match')
          : 'no matches'
        : lines > 0
          ? `${lines} ${lines === 1 ? 'line' : 'lines'}`
          : null;

  return (
    <div className={`tool ${entry.status}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((value) => !value)}
        disabled={!expandable}
        title={entry.status === 'cancelled' ? 'Interrupted before it finished' : undefined}
      >
        {badge ? (
          <span className="tool-badge" data-tone={badge.tone}>
            {badge.label}
          </span>
        ) : (
          <span className="tool-status">{entry.skill ? '◈' : STATUS_GLYPH[entry.status]}</span>
        )}
        <span className="tool-name">{entry.name}</span>
        <span className="tool-subject">
          <span className="tool-summary">{entry.summary}</span>
          {/* What the change came to, in the shape a diff is always summarised. Beside the
              file rather than at the right edge: it is read as part of the file's line. */}
          {changed && (changed.added > 0 || changed.removed > 0) && (
            <span className="tool-counts">
              {changed.added > 0 && <span className="added">+{changed.added}</span>}
              {changed.removed > 0 && <span className="removed">−{changed.removed}</span>}
            </span>
          )}
          {/* Why it failed, on the row itself. A failure is the one outcome worth reading
              without opening anything, and the row otherwise says only that it happened. */}
          {failure && (
            <span className="tool-error" title={entry.output ?? undefined}>
              {failure}
            </span>
          )}
          {entry.answer && <span className="tool-answer">{entry.answer}</span>}
        </span>
        {/* Who took the task, and what it cost. The subagent's own work is not in this
            conversation - it is another agent's, and it is most of a delegating session's
            transcript - so this row is the whole account of it the parent gets (#11). */}
        {entry.delegated && (
          <span className="tool-note delegated">
            {entry.delegated.agent}
            {entry.delegated.outcome === 'failed' && ' failed'}
            {entry.delegated.toolCalls !== undefined && `, ${plural(entry.delegated.toolCalls, 'tool call')}`}
          </span>
        )}
        {entry.status === 'cancelled' && <span className="tool-note">interrupted</span>}
        {/* Why a skill is here, next to its name. Silent when the reader invoked it: they
            know, and the row would be saying it back to them. */}
        {entry.skill && entry.skill !== 'user' && (
          <span className="tool-note skill">{SKILL_NOTE[entry.skill]}</span>
        )}
        {/* Says how much is behind the row, and stays once it is opened: it describes the
            row rather than the fact that it is folded. Right-aligned, so it reads as a
            separate column without needing punctuation. */}
        {count && <span className="tool-lines">{count}</span>}
        {/* How long it has been going, which is what makes a slow command feel like
            progress rather than a hang. Kept once it finishes: knowing a command took two
            minutes is worth as much afterwards. */}
        {shows.showToolDurations && <Elapsed since={entry.startedAt} until={entry.endedAt} />}
      </button>
      {open &&
        (entry.children?.length ? (
          /* The subagent's own timeline, drawn by the same rows the parent uses: its
             messages, thinking and tool calls read as they would anywhere else, and one
             that delegates in turn nests again without this knowing how deep it goes. */
          <ul className="tool-children">
            {entry.children.map((child) => (
              <EntryRow key={child.key} entry={child} />
            ))}
          </ul>
        ) : choices ? (
          <ul className="tool-choices">
            {choices.map((choice) => {
              const chosen = choice === entry.answer;
              return (
                <li key={choice} className={chosen ? 'chosen' : undefined}>
                  <span className="choice-mark">{chosen ? '●' : '○'}</span>
                  <span className="choice-label">{choice}</span>
                </li>
              );
            })}
            {freeform && (
              <li className="chosen">
                <span className="choice-mark">●</span>
                <span className="choice-label">{freeform}</span>
                <span className="choice-note">typed</span>
              </li>
            )}
          </ul>
        ) : patch ? (
          <Diff lines={patch} />
        ) : (
          <>
            {entry.output && <pre className="tool-output">{entry.output}</pre>}
            {/* Last, as in the CLI: what came back is read more often than what ran, and
                the header only had room for a description of it. */}
            {entry.command && <pre className="tool-command">{entry.command}</pre>}
          </>
        ))}
    </div>
  );
}

interface TranscriptProps {
  events: TranscriptEvent[];
  /** Changing this jumps to the newest message rather than preserving scroll. */
  sessionId: string;
  /** Used to shorten file paths in tool summaries. */
  cwd: string | null;
  /** What a stopped turn had already said, by the abort that ended it. */
  abandoned?: ReadonlyMap<string, string>;
  /** Whether older history exists before the events supplied. Absent means this is all of it. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  /** Fetch the page before the events supplied. Absent where they are already all held. */
  onLoadOlder?: () => void;
  /** Whether anything was reached by scrolling up, and so whether there is anything to give back. */
  extraPages?: boolean;
  /** Give back the pages reached by scrolling up. Absent leaves them held for as long as the session is open. */
  onDropOlder?: () => void;
  /**
   * Return to the end of the conversation, when a search result opened it partway back.
   *
   * Absent when the transcript is already showing the end, which is every other time. A
   * jump with no way back is a door that only opens one way, and the reader who followed a
   * match usually wants to see what the session came to in the end (#30).
   */
  onLatest?: () => void;
  /**
   * What was searched for, so the part of the page that answers it can be pointed at.
   *
   * A page of conversation is a lot to arrive in front of, and the reason for arriving is a
   * few words somewhere in it. Set only while a search result is being read.
   */
  /**
   * What was searched for, and which arrival at it this is.
   *
   * The words say which row answers it. `at` says that this is a fresh request rather than
   * the one already being shown: asking for the same result again, in the session already
   * open, is a reader saying "take me back there" - and without something to tell the two
   * apart it was read as them already being there and answered with nothing.
   */
  highlight?: { words: string; at: number };
  /** Whether the model's thinking is shown at all, which ctrl+t turns off (#72). */
  /**
   * Whose timeline this is, when it belongs to a subagent rather than the session.
   *
   * Without it a subagent's own events are all read as somebody else's work and set aside,
   * leaving the view empty - which is what a subagent's transcript looked like (#178).
   */
  ofAgent?: string;
  display: CliDisplay;
}

export function Transcript({
  events,
  sessionId,
  cwd,
  abandoned,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  extraPages = false,
  onLatest,
  highlight,
  onDropOlder,
  ofAgent,
  display,
}: TranscriptProps) {
  // Rebuilt only when the events are, rather than on every render: a streamed reply
  // re-renders this component once per chunk, and the walk costs more the more history is
  // on screen.
  const all = useMemo(() => toEntries(events, cwd, abandoned, ofAgent), [events, cwd, abandoned, ofAgent]);
  // Dropped rather than hidden with CSS: thinking is usually longer than the answer it
  // produced, and the point of turning it off is to stop paying to lay it out.
  const entries = useMemo(
    () => (display.showReasoning ? all : all.filter((entry) => entry.kind !== 'reasoning')),
    [all, display.showReasoning],
  );
  /**
   * What is actually drawn, budgeted by how much text it comes to.
   *
   * The events a page holds are a poor guide to what it costs: the same hundred and fifty
   * come to 14 KB on one session here and 207 KB on another. Reaching back through this
   * window costs nothing - the entries are already built - so it is tried before asking the
   * caller for an older page.
   */
  const budgeted = useBudgetedEntries(sessionId, entries);
  const shown = budgeted.entries;
  const more = budgeted.hasMore || hasOlder;
  const listRef = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  /** Scroll height before older events were prepended, so the view can be held still. */
  const restoreFrom = useRef<number | null>(null);
  /** Counting down to giving back the pages reached by scrolling up, or null when not. */
  const dropAfter = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** How many times this session's page has already extended itself to fill the view. */
  const filled = useRef(0);
  /**
   * Until when a scroll event is this component's own doing rather than the reader's.
   *
   * A clock rather than a flag: the flag was cleared by a timer, and the effect that set it
   * cancelled that timer on the very next render - so it stayed set for the rest of the run
   * and every scroll after the first was ignored.
   */
  const ignoreScrollsUntil = useRef(0);

  const cancelDrop = () => {
    if (dropAfter.current === null) return;
    clearTimeout(dropAfter.current);
    dropAfter.current = null;
  };

  // Nothing to give back in another session, and the timer must not outlive this one.
  useEffect(() => cancelDrop, [sessionId]);

  // Selecting a session re-pins to the bottom. The transcript itself arrives a moment
  // later, so the actual scroll happens in the effect below once content exists.
  //
  // Not when a search result sent the reader here: that is a request to look at one place,
  // and following the end instead is how a jump landed correctly and was then thrown to the
  // bottom a frame later, as the budgeted renderer added the rest of the page.
  useLayoutEffect(() => {
    pinned.current = !highlight;
    restoreFrom.current = null;
    filled.current = 0;
  }, [sessionId, highlight]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    // Older events were prepended: keep the reader where they were rather than letting
    // the added height push their position away. Both ways of reaching back do it - a page
    // fetched from disk changes how many entries there are, and widening the drawn window
    // changes only how many are shown, so this has to watch for both.
    if (restoreFrom.current !== null) {
      list.scrollTop += list.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
      return;
    }

    // Otherwise follow the newest entry while the user is at the bottom, for both the
    // initial load and streamed events. useLayoutEffect runs before paint, so a long
    // history never flashes at the top before jumping down.
    if (pinned.current) list.scrollTop = list.scrollHeight;
  }, [entries.length, shown.length, sessionId]);

  /**
   * Point at the part of the page that was being looked for.
   *
   * A page of conversation is a lot to arrive in front of when the reason for arriving is a
   * few words somewhere in it. The last row containing them is marked rather than the first,
   * because the page ends at the match and anything earlier is an older mention of the same
   * thing.
   *
   * It fades by itself. A mark that stayed would become part of how the session looks and
   * would still be there, meaning nothing, on the next visit.
   */
  /**
   * Which row answers the search that sent the reader here.
   *
   * Worked out from the entries rather than hunted for in the document, and drawn as part of
   * the row rather than pinned onto it afterwards. Everything before this was an effect that
   * queried the page, added a class by hand, and set timers to undo both - which meant it
   * had to be right about *when* it ran, against a page that is still arriving, a window
   * that is still widening and markdown that is still laying out. It never reliably was.
   *
   * Only questions and replies, which is what the index holds: it is built from each turn's
   * `user_message` and `assistant_response`, so tool output was never searchable and
   * pointing at it here would point at something the search could not have found.
   *
   * The last one rather than the first: the page ends at the matched turn, so anything
   * earlier is an older mention of the same thing.
   */
  const wanted = highlight?.words.trim().toLowerCase() ?? '';
  const target = useMemo(() => {
    if (!wanted) return -1;

    let last = -1;
    for (const [index, entry] of entries.entries()) {
      if (entry.kind === 'message' && entry.body.toLowerCase().includes(wanted)) last = index;
    }
    return last;
  }, [entries, wanted]);

  /**
   * Whether the reader has moved the transcript themselves since arriving.
   *
   * Two things turn on it. Landing on a match puts them at the top of the page, and being at
   * the top is what asks for the page before it - so arriving would otherwise fetch history
   * nobody wanted and prepend it above the match. And the mark stays until they act rather
   * than fading on a timer: a highlight they have to catch within two seconds is one they
   * will miss, and this one has been missed.
   */
  const [tookOver, setTookOver] = useState(false);
  const release = useCallback(() => setTookOver(true), []);

  /**
   * Arriving somewhere new is arriving.
   *
   * Done while rendering rather than in an effect, which runs after the effects that act on
   * it and would undo what they had just done - a mistake this has already made twice.
   */
  const lastArrival = useRef<string | null>(null);
  const arrival = `${sessionId}:${highlight?.at ?? ''}`;
  if (lastArrival.current !== arrival) {
    lastArrival.current = arrival;
    if (tookOver) setTookOver(false);
  }

  /** Where the drawn window starts, so an index into the entries can be found among the rows. */
  const from = entries.length - shown.length;
  const pointingAt = target >= 0 && !tookOver ? target - from : -1;

  /**
   * Drawn far enough back to include it, when the budget stopped short of it.
   *
   * The window is measured in text from the end of the page, so on a page whose last entries
   * are long the match can be outside it - measured on real sessions at five of ten matches,
   * one of them 39 kB behind a 16 kB window. A row that is not drawn cannot be pointed at.
   */
  useEffect(() => {
    if (target >= 0 && target < from) budgeted.showAtLeast(entries.length - target);
  }, [target, from, entries.length, budgeted]);

  /**
   * Put it in view, and again while the page around it is still arriving.
   *
   * Reaching back draws rows above it, and each one pushes it down as its markdown lays out,
   * so once is not enough. Bounded by the reader rather than by a clock: as soon as they
   * move the transcript themselves this stops, which is what `tookOver` is for.
   */
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(':scope > li.entry.found');
    if (!row) return;

    ignoreScrollsUntil.current = Date.now() + OWN_SCROLL_MS;
    row.scrollIntoView({ block: 'center' });
  }, [pointingAt, shown.length, entries.length]);


  /**
   * Keep up with a reply as it is written.
   *
   * A streamed reply grows one row rather than adding rows, so nothing about the entry
   * list changes to react to. Watching the rendered text instead covers that, and covers
   * a row being expanded while at the bottom, without either needing to be anticipated.
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const follow = new MutationObserver(() => {
      if (pinned.current && restoreFrom.current === null) list.scrollTop = list.scrollHeight;
    });
    follow.observe(list, { childList: true, subtree: true, characterData: true });
    return () => follow.disconnect();
  }, []);

  /**
   * Fill the view when a page does not, so what is above it stays reachable.
   *
   * Reaching back is driven by scrolling, and a list shorter than its own box never
   * scrolls. What is already held is extended first, since that costs nothing.
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list || loadingOlder || !more || filled.current >= AUTO_FILL_LIMIT) return;
    // Nothing measured yet, which is a list that has not been laid out rather than one
    // that is too short.
    if (list.scrollHeight === 0 || list.scrollHeight > list.clientHeight) return;

    filled.current += 1;
    if (budgeted.hasMore) budgeted.showMore();
    else onLoadOlder?.();
  });

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    // This component's own scrolling is not the reader saying where they want to be. Read
    // from a clock rather than a flag cleared by a timer: the effect that set the flag also
    // cancelled its own timer on the next render, and left it set for the rest of the run.
    if (Date.now() < ignoreScrollsUntil.current) return;

    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    pinned.current = distance <= BOTTOM_TOLERANCE_PX;

    // Back at the bottom and following the reply again, rather than reading somewhere of
    // their own choosing: what is above is no longer being looked at, only paid for.
    // Waiting rather than acting at once, because touching the bottom on the way past is
    // not the same as having finished with what is above it.
    if (pinned.current && !loadingOlder) {
      if (dropAfter.current === null) {
        dropAfter.current = setTimeout(() => {
          dropAfter.current = null;
          // The pages fetched by reaching back, and then the window over whatever is left.
          // Reaching back is not the only way to end up drawing too much: a session worked
          // in for long enough arrives at the same place without ever scrolling (#184).
          if (extraPages) onDropOlder?.();
          budgeted.settle();
        }, DROP_OLDER_AFTER_MS);
      }
    } else {
      cancelDrop();
    }

    // Where this app put somebody is not them asking to go further back: landing on a search
    // result lands at the top, which would otherwise fetch the page before it and prepend a
    // different day above the match.
    if (highlight && !tookOver) return;

    if (list.scrollTop <= LOAD_OLDER_THRESHOLD_PX && more && !loadingOlder) {
      restoreFrom.current = list.scrollHeight;
      // The entries already built come first: they cost nothing to show, where an older
      // page costs a read and a parse.
      if (budgeted.hasMore) budgeted.showMore();
      else onLoadOlder?.();
    }
  }

  return (
    <Shows.Provider value={display}>
      <ol
        className="transcript"
        ref={listRef}
        onScroll={onScroll}
        // Unambiguous ways of taking over, none of which `scrollIntoView` raises - unlike a
        // scroll event, which says nothing about who caused it.
        onWheel={release}
        onPointerDown={release}
        onKeyDown={release}
      >
        <li className="history-edge">
          {loadingOlder ? 'Loading earlier messages…' : more ? 'Scroll up for earlier messages' : 'Start of session'}
        </li>
        {shown.map((entry, index) => (
          <EntryRow key={entry.key} entry={entry} found={index === pointingAt} />
        ))}
        {/* The bottom of this page is not the bottom of the conversation, which is the one
            thing a reader who followed a search result cannot tell by looking. */}
        {onLatest && (
          <li className="history-edge">
            Showing where this was said.{' '}
            <button type="button" className="settings-reset" onClick={onLatest}>
              Go to the end of the session
            </button>
          </li>
        )}
      </ol>
    </Shows.Provider>
  );
}

/**
 * One row, skipped on re-render unless something about it actually changed.
 *
 * The entry list is rebuilt from scratch on every render, so each row arrives as a new
 * object and nothing is reference-equal. Without this, a single streamed event re-renders
 * the whole transcript, and the cost of receiving one grows with how much history is on
 * screen - measured at 2000 rows, it was several times the cost at 200.
 *
 * The list item is inside the boundary rather than around it. Outside, React reconciled
 * every one of them for each chunk of a streamed reply, which is the cost this exists to
 * avoid.
 */
const EntryRow = memo(
  function EntryRow({ entry, found }: { entry: Entry; found?: boolean }) {
    const kind = entry.kind === 'tool' ? 'entry tool-entry' : 'entry';
    return (
      <li className={found ? `${kind} found` : kind}>
        <EntryBody entry={entry} />
      </li>
    );
  },
  // The mark is part of the row, so a row that has just become the answer to a search is a
  // row that changed. Left out, it would be skipped exactly when it needed redrawing.
  (before, after) => before.found === after.found && sameEntry(before.entry, after.entry),
);

function EntryBody({ entry }: { entry: Entry }) {
  const shows = useContext(Shows);

  if (entry.kind === 'tool') return <ToolRow entry={entry} />;
  if (entry.kind === 'reasoning') return <ReasoningRow entry={entry} />;
  // Not markdown: the app wrote this line, and it belongs to the transcript rather than
  // to anyone in the conversation.
  if (entry.variant === 'stopped') return <p className="message stopped">{entry.body}</p>;

  return (
    <div className={`message ${entry.variant}`}>
      <div className="message-meta">
        {/* The whole reply, since selecting a long one by hand is not really possible. */}
        {entry.variant === 'assistant' && <CopyButton text={entry.body} what="reply" />}
        {/* Coarse on the face of it, exact on hover: "2h ago" covers an hour of moments. */}
        {entry.at && shows.showTimestamps && <Said at={entry.at} />}
      </div>
      {entry.preformatted ? (
        <pre className="plain">{entry.body}</pre>
      ) : (
        <Markdown body={entry.body} anchor={entry.key} streaming={entry.streaming} />
      )}
    </div>
  );
}
