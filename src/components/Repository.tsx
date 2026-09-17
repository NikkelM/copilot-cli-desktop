import { useState } from 'react';

import type { FileDiff, RepoFile, RepoStatus } from '../../shared/protocol';
import { fileBadge } from '../lib/fileBadge';
import { parsePatch } from '../lib/patch';
import { diffKey } from '../lib/useRepoStatus';
import { Diff } from './Diff';

interface RepositoryProps {
  status: RepoStatus | null;
  loading: boolean;
  /** Absent when the session has no working directory at all. */
  cwd: string | null;
  /** Diffs already fetched, by side and path. */
  diffs: Record<string, FileDiff>;
  /** Fetch one, when a row is opened. */
  onDiff: (path: string, staged: boolean) => void;
  onRefresh: () => void;
  onClose: () => void;
}

/**
 * What happened to a file, in one letter.
 *
 * The letters git uses, because anyone who has read a `git status` already knows them, and
 * because a word per row would push the paths off a narrow panel.
 */
const MARK: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
  unmerged: '!',
};

/** One path, shown under whichever heading it belongs to, opening to its diff. */
function FileRow({
  file,
  change,
  staged,
  open,
  diff,
  onToggle,
}: {
  file: RepoFile;
  change: string;
  staged: boolean;
  open: boolean;
  diff: FileDiff | undefined;
  onToggle: () => void;
}) {
  const badge = fileBadge(file.path);
  const name = file.path.split('/').pop() ?? file.path;
  const folder = file.path.slice(0, file.path.length - name.length);

  return (
    <li>
      <button
        type="button"
        className={open ? 'changes-row open' : 'changes-row'}
        onClick={onToggle}
        aria-expanded={open}
        title={file.from ? `${file.path} (was ${file.from})` : file.path}
      >
        <span className={`repo-mark ${change}`}>{MARK[change] ?? '?'}</span>
        {badge ? (
          <span className="changes-badge" data-tone={badge.tone}>
            {badge.label}
          </span>
        ) : (
          <span className="changes-badge" />
        )}
        <span className="repo-path">
          <span className="repo-name">{name}</span>
          {/* The folder after the name and quieter: a list of paths is read by filename, and
              the leading directories are the part every row has in common. */}
          {folder && <span className="repo-folder">{folder}</span>}
        </span>
      </button>

      {open && <Expanded diff={diff} staged={staged} />}
    </li>
  );
}

/**
 * What opening a row shows.
 *
 * The same three states the changes panel has - still reading, nothing to show, or the
 * diff - because a reader who has learnt one of these panels should not have to learn the
 * other.
 */
function Expanded({ diff, staged }: { diff: FileDiff | undefined; staged: boolean }) {
  if (!diff) return <p className="changes-note">Reading the diff.</p>;
  if (!diff.patch) {
    return (
      <p className="changes-note">
        {diff.reason === 'binary'
          ? 'Not a text file.'
          : diff.reason === 'gone'
            ? 'This file is not on disk any more.'
            : staged
              ? 'Nothing staged for this file.'
              : 'No difference to show.'}
      </p>
    );
  }

  return <Diff lines={parsePatch(diff.patch)} />;
}

/**
 * The state of the session's repository: branch, upstream, and what has changed.
 *
 * Read-only. Staging, committing and pushing are the rest of this epic (#41), and this
 * landing first means the panel that shows the tree cannot be the thing that damages it.
 *
 * Deliberately separate from the changes panel, which shows only what the agent edited. This
 * one shows the real working tree including the reader's own edits, and conflating the two
 * would suggest that acting here is scoped to the agent's work when it is not.
 */
export function Repository({ status, loading, cwd, diffs, onDiff, onRefresh, onClose }: RepositoryProps) {
  const staged = status?.files.filter((file) => file.staged) ?? [];
  const unstaged = status?.files.filter((file) => file.unstaged) ?? [];
  /** Which row is open, by side and path, since one file can appear under both headings. */
  const [open, setOpen] = useState<string | null>(null);

  const toggle = (path: string, isStaged: boolean) => {
    const key = diffKey(path, isStaged);
    if (open === key) {
      setOpen(null);
      return;
    }

    setOpen(key);
    onDiff(path, isStaged);
  };

  return (
    <div className="changes repository">
      <div className="changes-head">
        <span className="changes-title">
          Source control
          {status && (
            <span className="repo-branch" title={status.detached ? 'No branch: HEAD is detached' : undefined}>
              {status.branch}
              {status.upstream && <span className="repo-upstream">→ {status.upstream}</span>}
              {/* Only when there is something to say. A pair of zeroes on every clean
                  repository is punctuation. */}
              {status.ahead > 0 && <span className="repo-count">↑{status.ahead}</span>}
              {status.behind > 0 && <span className="repo-count">↓{status.behind}</span>}
            </span>
          )}
        </span>
        <div className="changes-actions">
          <button type="button" className="changes-action" onClick={onRefresh} disabled={loading}>
            {loading ? 'Reading…' : 'Refresh'}
          </button>
          <button type="button" className="changes-close" onClick={onClose} aria-label="Close source control">
            ✕
          </button>
        </div>
      </div>

      {!cwd ? (
        <p className="changes-note">This session has no working directory.</p>
      ) : !status ? (
        <p className="changes-note">
          {loading ? 'Reading the repository…' : 'Not a git repository.'}
        </p>
      ) : status.files.length === 0 ? (
        /* A clean tree is not the same as nothing to do. Commits waiting to be pushed are
           the reason this panel is open as often as edits are, and calling that "nothing"
           is how a reader concludes the panel is not working. */
        <p className="changes-note">
          Nothing to commit.
          {status.ahead > 0 &&
            ` ${status.ahead} ${status.ahead === 1 ? 'commit is' : 'commits are'} waiting to be pushed.`}
          {status.behind > 0 &&
            ` ${status.behind} ${status.behind === 1 ? 'commit is' : 'commits are'} waiting to be pulled.`}
        </p>
      ) : (
        <>
          {staged.length > 0 && (
            <>
              <p className="repo-group">Staged</p>
              <ul className="changes-list">
                {staged.map((file) => (
                  <FileRow
                    key={`staged:${file.path}`}
                    file={file}
                    change={file.staged!}
                    staged
                    open={open === diffKey(file.path, true)}
                    diff={diffs[diffKey(file.path, true)]}
                    onToggle={() => toggle(file.path, true)}
                  />
                ))}
              </ul>
            </>
          )}

          {unstaged.length > 0 && (
            <>
              {/* A file staged and then changed again appears under both, which is what it
                  is: part of it is going into the commit and part of it is not. The two
                  rows open different diffs, because they describe different things. */}
              <p className="repo-group">Changes</p>
              <ul className="changes-list">
                {unstaged.map((file) => (
                  <FileRow
                    key={`unstaged:${file.path}`}
                    file={file}
                    change={file.unstaged!}
                    staged={false}
                    open={open === diffKey(file.path, false)}
                    diff={diffs[diffKey(file.path, false)]}
                    onToggle={() => toggle(file.path, false)}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
