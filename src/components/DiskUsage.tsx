import { useState } from 'react';

import { bytes } from '../lib/units';
import { totalBytes } from '../lib/useDiskUsage';
import { formatRelative } from '../lib/time';
import type { SessionDisk } from '../../shared/protocol';

/** How many of the largest are listed before the rest are summed into one line. */
const LISTED = 10;

/**
 * What the sessions on this machine are costing, largest first.
 *
 * `~/.copilot/session-state` grows and nothing takes anything out of it, and the shape of
 * what accumulates is extreme: measured here, the ten largest sessions hold 78% of 3.6GB and
 * the median session holds nothing at all. So this lists the few that matter and sums the
 * rest, rather than printing a zero beside seven hundred rows.
 *
 * Read on asking rather than on opening the category. The walk covers every session
 * directory there has ever been, and the reader who came here to change how long the bin
 * keeps things did not ask for it.
 */
export function DiskUsage({
  usage,
  reading,
  onRead,
  onOpen,
  onDetails,
  onDelete,
  protectedIds = [],
  deleting = false,
}: {
  /** What was measured, or null before anybody has asked. */
  usage: SessionDisk[] | null;
  reading: boolean;
  onRead?: () => void;
  /** Go to a session, which is where anything can actually be done about it. */
  onOpen?: (sessionId: string) => void;
  onDetails?: (session: SessionDisk) => void;
  onDelete?: (sessions: SessionDisk[]) => void;
  protectedIds?: readonly string[];
  deleting?: boolean;
}) {
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  if (usage === null) {
    return (
      <button type="button" className="disk-action" onClick={onRead} disabled={reading}>
        {reading ? 'Measuring…' : 'Measure disk usage'}
      </button>
    );
  }

  if (usage.length === 0) {
    return <p className="settings-note">Nothing on disk yet.</p>;
  }

  const shown = all ? usage : usage.slice(0, LISTED);
  const rest = usage.length - shown.length;
  const restBytes = totalBytes(usage) - totalBytes(shown);
  const picked = shown.filter((session) => selected.includes(session.sessionId) && !protectedIds.includes(session.sessionId));

  return (
    <>
      <p className="settings-note">
        Sessions: {usage.length} · Disk usage: {bytes(totalBytes(usage))}
      </p>

      {picked.length > 0 && (
        <div className="disk-selection">
          <span>{picked.length} selected · {bytes(totalBytes(picked))}</span>
          <button
            type="button"
            className="disk-action destructive"
            disabled={deleting || reading || !onDelete}
            onClick={() => onDelete?.(picked)}
          >
            Delete selected
          </button>
          <button type="button" className="disk-action" disabled={deleting} onClick={() => setSelected([])}>
            Clear selection
          </button>
        </div>
      )}

      {shown.map((session) => (
        <div className="settings-row bin-row disk-row" key={session.sessionId}>
          <input
            type="checkbox"
            className="disk-select"
            aria-label={`Select ${session.title ?? 'Untitled session'}`}
            checked={selected.includes(session.sessionId)}
            disabled={deleting || reading || protectedIds.includes(session.sessionId) || !onDelete}
            title={protectedIds.includes(session.sessionId) ? 'This session is working or open in another CLI.' : undefined}
            onChange={(event) => {
              const checked = event.target.checked;
              setSelected((current) => checked ? [...current, session.sessionId] : current.filter((id) => id !== session.sessionId));
            }}
          />
          <span className="bin-what">
            <span className="bin-title">{session.title ?? 'Untitled session'}</span>
            <span className="settings-hint">
              {session.updatedAt ? `Last used ${formatRelative(session.updatedAt)}` : 'Never used'}
              {/* A directory the session store has no row for. Worth saying, because it is
                  taking up room and nothing else in the app will ever mention it. */}
              {!session.listed && ' · not in the session list'}
            </span>
          </span>
          <span className="bin-actions disk-actions">
            <span className="disk-size">{bytes(session.bytes)}</span>
            <button type="button" className="disk-action" onClick={() => onDetails?.(session)}>
              Details
            </button>
            {session.listed && (
              <button type="button" className="disk-action" onClick={() => onOpen?.(session.sessionId)}>
                Open
              </button>
            )}
            <button
              type="button"
              className="disk-action destructive"
              disabled={deleting || reading || protectedIds.includes(session.sessionId) || !onDelete}
              title={protectedIds.includes(session.sessionId) ? 'This session is working or open in another CLI.' : undefined}
              onClick={() => onDelete?.([session])}
            >
              Delete
            </button>
          </span>
        </div>
      ))}

      {rest > 0 && (
        <p className="settings-note">
          {rest} more · {bytes(restBytes)}{' '}
          <button type="button" className="settings-link" onClick={() => setAll(true)}>
            Show all
          </button>
        </p>
      )}
    </>
  );
}
