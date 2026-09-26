import { useState } from 'react';

import { ChevronIcon } from './Icons';
import { Diff } from './Diff';
import { fileBadge } from '../lib/fileBadge';
import { parsePatch } from '../lib/patch';
import type { ChangedFile, TurnChanges } from '../lib/turnChanges';

/** The file's own name, which is what a reader recognises, with the rest of the path after it. */
function nameOf(path: string): { name: string; within: string } {
  const parts = path.split(/[\\/]/);
  const name = parts.pop() ?? path;
  return { name, within: parts.join('/') };
}

/**
 * What a turn changed, gathered where the turn ends.
 *
 * A turn's edits are scattered through it, often with a long reply between them, so what a
 * turn came to is not readable from any one row. This is where somebody looks to find out
 * what happened, which is why it sits at the end rather than beside the first edit (#40).
 *
 * Closed to a line. Open, it is the files and what each of them came to, and any of those
 * opens again onto the change itself - drawn by the same component the session's list of
 * changes uses, so the two never answer the same question differently (#40).
 */
export function TurnSummary({ changes }: { changes: TurnChanges }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const { files, added, removed } = changes;

  return (
    <div className={open ? 'turn-changes open' : 'turn-changes'}>
      <button type="button" className="turn-changes-head" onClick={() => setOpen((was) => !was)}>
        <ChevronIcon open={open} />
        <span className="turn-changes-label">
          {files.length === 1 ? '1 file changed' : `${files.length} files changed`}
        </span>
        <span className="tool-counts">
          {added > 0 && <span className="added">+{added}</span>}
          {removed > 0 && <span className="removed">−{removed}</span>}
        </span>
      </button>

      {open && (
        <ul className="turn-changes-files">
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              open={shown === file.path}
              onToggle={() => setShown(shown === file.path ? null : file.path)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function FileRow({ file, open, onToggle }: { file: ChangedFile; open: boolean; onToggle: () => void }) {
  const { name, within } = nameOf(file.path);
  const badge = fileBadge(file.path);
  const edits = file.patches.length;

  return (
    <li>
      <button
        type="button"
        className={open ? 'turn-changes-file open' : 'turn-changes-file'}
        onClick={onToggle}
        aria-expanded={open}
        title={file.path}
      >
        <ChevronIcon open={open} />
        {badge && (
          <span className="tool-badge" data-tone={badge.tone}>
            {badge.label}
          </span>
        )}
        <span className="turn-changes-name">{name}</span>
        {/* Always drawn, blank for a file that sits at the root of the working directory:
            this is the part that takes the leftover room, so without it the counts would
            stop beside the name instead of at the right edge. */}
        <span className="turn-changes-where">{within}</span>
        {/* Only when it was written more than once: on most rows it would be a 1 beside
            every file, saying nothing. */}
        {edits > 1 && <span className="turn-changes-edits">{edits} edits</span>}
        <span className="tool-counts">
          {file.added > 0 && <span className="added">+{file.added}</span>}
          {file.removed > 0 && <span className="removed">−{file.removed}</span>}
        </span>
      </button>

      {open && (
        <div className="turn-changes-diffs">
          {file.patches.map((patch, at) => (
            <div key={at}>
              {/* Which edit this is, because each one's line numbers count the file as the
                  edit before it left it, not as it started. */}
              {edits > 1 && (
                <p className="turn-changes-step">
                  Edit {at + 1} of {edits}
                </p>
              )}
              <Diff lines={parsePatch(patch)} />
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
