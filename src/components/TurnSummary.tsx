import { useState } from 'react';

import { ChevronIcon } from './Icons';
import { fileBadge } from '../lib/fileBadge';
import type { TurnChanges } from '../lib/turnChanges';

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
 * Closed to a line. Open, it is the files and what each of them came to - which is the
 * question this answers, rather than the diffs themselves: those are on the rows that made
 * them, where the reader can see what was being done at the time.
 */
export function TurnSummary({ changes }: { changes: TurnChanges }) {
  const [open, setOpen] = useState(false);
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
          {files.map((file) => {
            const { name, within } = nameOf(file.path);
            const badge = fileBadge(file.path);
            return (
              <li key={file.path}>
                {badge && (
                  <span className="tool-badge" data-tone={badge.tone}>
                    {badge.label}
                  </span>
                )}
                <span className="turn-changes-name">{name}</span>
                {within && <span className="turn-changes-where">{within}</span>}
                {/* Only when it was written more than once: on most rows it would be a 1
                    beside every file, saying nothing. */}
                {file.edits > 1 && <span className="turn-changes-edits">{file.edits} edits</span>}
                <span className="tool-counts">
                  {file.added > 0 && <span className="added">+{file.added}</span>}
                  {file.removed > 0 && <span className="removed">−{file.removed}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
