import { useEffect, useState } from 'react';

import type { SessionChange } from '../../shared/protocol';
import { getChanges, getDiff } from '../lib/sidecar';
import { countChanges, parsePatch } from '../lib/patch';

interface ChangesProps {
  sessionId: string;
  /** Bumped when a turn ends, so the list follows the work without a timer. */
  revision: number;
  cwd: string | null;
}

/** The part of a path worth reading, given most of it repeats. */
function shorten(path: string, cwd: string | null): string {
  if (cwd && path.toLowerCase().startsWith(cwd.toLowerCase())) {
    return path.slice(cwd.length).replace(/^[\\/]+/, '');
  }
  return path;
}

const MARK: Record<SessionChange['status'], string> = {
  added: '+',
  modified: '~',
  deleted: '−',
  renamed: '→',
};

/**
 * What the agent changed on disk, and what each change was.
 *
 * Only the agent's work: anything already in progress when the session was picked up is
 * inside the snapshot it is compared against, so it does not appear here. Files outside a
 * repository are listed alongside ones inside it, since what matters is that the agent
 * wrote them rather than whether they happen to be tracked.
 */
export function Changes({ sessionId, revision, cwd }: ChangesProps) {
  const [changes, setChanges] = useState<SessionChange[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let current = true;
    getChanges(sessionId)
      .then((result) => current && setChanges(result.changes))
      .catch(() => current && setChanges([]));

    return () => {
      current = false;
    };
  }, [sessionId, revision]);

  // Nothing to say rather than an empty panel taking up room in every session.
  if (changes.length === 0) return null;

  return (
    <section className="changes">
      <button type="button" className="changes-head" onClick={() => setOpen((was) => !was)}>
        <span className="changes-caret">{open ? '▾' : '▸'}</span>
        <span>
          {changes.length} {changes.length === 1 ? 'file changed' : 'files changed'}
        </span>
      </button>

      {open && (
        <ul className="changes-list">
          {changes.map((change) => (
            <ChangedFile key={change.path} sessionId={sessionId} change={change} cwd={cwd} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChangedFile({
  sessionId,
  change,
  cwd,
}: {
  sessionId: string;
  change: SessionChange;
  cwd: string | null;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Fetched when the file is opened rather than with the list: a session can touch many
  // files, and a patch is far larger than the line naming it.
  useEffect(() => {
    if (!open || patch !== null) return;

    let current = true;
    getDiff(sessionId, change.path)
      .then((result) => current && setPatch(result.patch))
      .catch(() => current && setPatch(''));

    return () => {
      current = false;
    };
  }, [open, patch, sessionId, change.path]);

  const lines = patch ? parsePatch(patch) : [];
  const counts = countChanges(lines);

  return (
    <li className={`change ${change.status}`}>
      <button type="button" className="change-head" onClick={() => setOpen((was) => !was)}>
        <span className="change-mark">{MARK[change.status]}</span>
        <span className="change-path" title={change.path}>
          {shorten(change.path, cwd)}
        </span>
        {patch && (counts.added > 0 || counts.removed > 0) && (
          <span className="change-counts">
            {counts.added > 0 && <span className="added">+{counts.added}</span>}
            {counts.removed > 0 && <span className="removed">−{counts.removed}</span>}
          </span>
        )}
      </button>

      {open && (
        <div className="change-diff">
          {patch === null ? (
            <p className="change-note">Reading the change…</p>
          ) : lines.length === 0 ? (
            <p className="change-note">No patch is available for this file.</p>
          ) : (
            <table>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index} className={line.kind}>
                    <td className="gutter">{line.before ?? ''}</td>
                    <td className="gutter">{line.after ?? ''}</td>
                    <td className="code">{line.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </li>
  );
}
