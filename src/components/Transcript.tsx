import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { TranscriptEvent } from '../../shared/protocol';
import { sameEntry, toEntries, type Entry, type ReasoningEntry, type ToolEntry } from '../lib/transcriptEntries';
import { countChanges, parsePatch, type PatchLine } from '../lib/patch';
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
        <span className="reasoning-caret">{open ? '▾' : '▸'}</span>
        <span className="reasoning-label">Thinking</span>
        {/* Kept when open: it describes the row, not the fact that it is folded. */}
        <span className="reasoning-count">{words} words</span>
      </button>
      {open && (
        <div className="reasoning-body">
          <Markdown body={entry.body} />
        </div>
      )}
    </div>
  );
}

/** A single tool call, collapsed to one line until expanded. */
function ToolRow({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);

  // The offered options say more than the tool's own "User responded: x", which only
  // repeats what the header already shows. They are worth seeing even unanswered.
  const choices = entry.choices?.length ? entry.choices : null;
  // A typed reply is not among the options, so it needs its own line to appear at all.
  const freeform = choices && entry.answer && !choices.includes(entry.answer) ? entry.answer : null;

  // What a file tool changed, which is the reason to open its row at all.
  const patch = entry.patch ? parsePatch(entry.patch) : null;
  const changed = patch ? countChanges(patch) : null;

  const expandable = Boolean(entry.output) || Boolean(choices) || Boolean(entry.command) || Boolean(patch);
  const lines = entry.output ? entry.output.split('\n').length : 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 'es'}`;

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
        <span className="tool-status">{STATUS_GLYPH[entry.status]}</span>
        <span className="tool-name">{entry.name}</span>
        <span className="tool-subject">
          <span className="tool-summary">{entry.summary}</span>
          {entry.answer && <span className="tool-answer">{entry.answer}</span>}
        </span>
        {entry.status === 'cancelled' && <span className="tool-note">interrupted</span>}
        {/* What the change came to, in the shape a diff is always summarised. */}
        {changed && (changed.added > 0 || changed.removed > 0) && (
          <span className="tool-counts">
            {changed.added > 0 && <span className="added">+{changed.added}</span>}
            {changed.removed > 0 && <span className="removed">−{changed.removed}</span>}
          </span>
        )}
        {/* Says how much is behind the row, and stays once it is opened: it describes the
            row rather than the fact that it is folded. Right-aligned, so it reads as a
            separate column without needing punctuation. */}
        {count && <span className="tool-lines">{count}</span>}
      </button>
      {open &&
        (choices ? (
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

/** A change, with the line numbers that say where in the file to look. */
function Diff({ lines }: { lines: PatchLine[] }) {
  return (
    <div className="tool-diff">
      <table>
        <tbody>
          {lines.map((line, index) =>
            line.kind === 'skip' ? (
              <tr key={index} className="skip">
                <td className="gutter" colSpan={3}>
                  {line.hidden ? `${line.hidden} unchanged lines` : ''}
                </td>
              </tr>
            ) : (
              <tr key={index} className={line.kind}>
                <td className="gutter">{line.before ?? ''}</td>
                <td className="gutter">{line.after ?? ''}</td>
                <td className="mark">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</td>
                <td className="code">
                  {/* Marked in two tones: the line is changed, and within it this is the
                      part that changed. Colouring the whole line only says something
                      happened somewhere in it. */}
                  {line.segments
                    ? line.segments.map((segment, at) =>
                        segment.changed ? (
                          <mark key={at}>{segment.text}</mark>
                        ) : (
                          <span key={at}>{segment.text}</span>
                        ),
                      )
                    : line.text}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

interface TranscriptProps {
  events: TranscriptEvent[];
  /** Changing this jumps to the newest message rather than preserving scroll. */
  sessionId: string;
  /** Used to shorten file paths in tool summaries. */
  cwd: string | null;
  /** Whether older history exists before the events supplied. */
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

export function Transcript({
  events,
  sessionId,
  cwd,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: TranscriptProps) {
  const entries = toEntries(events, cwd);
  const listRef = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  /** Scroll height before older events were prepended, so the view can be held still. */
  const restoreFrom = useRef<number | null>(null);

  // Selecting a session re-pins to the bottom. The transcript itself arrives a moment
  // later, so the actual scroll happens in the effect below once content exists.
  useLayoutEffect(() => {
    pinned.current = true;
    restoreFrom.current = null;
  }, [sessionId]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    // Older events were prepended: keep the reader where they were rather than letting
    // the added height push their position away.
    if (restoreFrom.current !== null) {
      list.scrollTop += list.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
      return;
    }

    // Otherwise follow the newest entry while the user is at the bottom, for both the
    // initial load and streamed events. useLayoutEffect runs before paint, so a long
    // history never flashes at the top before jumping down.
    if (pinned.current) list.scrollTop = list.scrollHeight;
  }, [entries.length, sessionId]);

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

  function onScroll() {
    const list = listRef.current;
    if (!list) return;

    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    pinned.current = distance <= BOTTOM_TOLERANCE_PX;

    if (list.scrollTop <= LOAD_OLDER_THRESHOLD_PX && hasOlder && !loadingOlder) {
      restoreFrom.current = list.scrollHeight;
      onLoadOlder();
    }
  }

  return (
    <ol className="transcript" ref={listRef} onScroll={onScroll}>
      <li className="history-edge">
        {loadingOlder ? 'Loading earlier messages…' : hasOlder ? 'Scroll up for earlier messages' : 'Start of session'}
      </li>
      {entries.map((entry) => (
        <li key={entry.key} className="entry">
          <EntryRow entry={entry} />
        </li>
      ))}
    </ol>
  );
}

/**
 * One row, skipped on re-render unless something about it actually changed.
 *
 * The entry list is rebuilt from scratch on every render, so each row arrives as a new
 * object and nothing is reference-equal. Without this, a single streamed event re-renders
 * the whole transcript, and the cost of receiving one grows with how much history is on
 * screen - measured at 2000 rows, it was several times the cost at 200.
 */
const EntryRow = memo(
  function EntryRow({ entry }: { entry: Entry }) {
    if (entry.kind === 'tool') return <ToolRow entry={entry} />;
    if (entry.kind === 'reasoning') return <ReasoningRow entry={entry} />;

    return (
      <div className={`message ${entry.variant}`}>
        <Markdown body={entry.body} />
      </div>
    );
  },
  (before, after) => sameEntry(before.entry, after.entry),
);
