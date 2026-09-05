import { useLayoutEffect, useRef, useState } from 'react';

import type { TranscriptEvent } from '../../shared/protocol';
import { toEntries, type ToolEntry } from '../lib/transcriptEntries';

/** Distance from the bottom still treated as "following along". */
const PIN_THRESHOLD_PX = 80;

/** How close to the top triggers loading the previous page. */
const LOAD_OLDER_THRESHOLD_PX = 120;

const STATUS_GLYPH: Record<ToolEntry['status'], string> = {
  running: '·',
  ok: '✓',
  failed: '✕',
  cancelled: '⊘',
};

/** A single tool call, collapsed to one line until expanded. */
function ToolRow({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);

  // The offered options say more than the tool's own "User responded: x", which only
  // repeats what the header already shows. They are worth seeing even unanswered.
  const choices = entry.choices?.length ? entry.choices : null;
  // A typed reply is not among the options, so it needs its own line to appear at all.
  const freeform = choices && entry.answer && !choices.includes(entry.answer) ? entry.answer : null;

  const expandable = Boolean(entry.output) || Boolean(choices);
  const lines = entry.output ? entry.output.split('\n').length : 0;
  const count = choices
    ? `${choices.length} ${choices.length === 1 ? 'option' : 'options'}`
    : `${lines} ${lines === 1 ? 'line' : 'lines'}`;

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
        {/* Doubles as the affordance that the row opens, and says how much is behind it.
            Right-aligned, so it reads as a separate column without needing punctuation. */}
        {expandable && !open && <span className="tool-lines">{count}</span>}
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
        ) : (
          entry.output && <pre className="tool-output">{entry.output}</pre>
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

  function onScroll() {
    const list = listRef.current;
    if (!list) return;

    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    pinned.current = distance <= PIN_THRESHOLD_PX;

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
      {entries.map((entry, index) => (
        <li key={index} className="entry">
          {entry.kind === 'tool' ? (
            <ToolRow entry={entry} />
          ) : (
            <div className={`message ${entry.variant}`}>{entry.body}</div>
          )}
        </li>
      ))}
    </ol>
  );
}
