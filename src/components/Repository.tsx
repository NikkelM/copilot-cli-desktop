import type { RepoFile, RepoStatus } from '../../shared/protocol';
import { fileBadge } from '../lib/fileBadge';

interface RepositoryProps {
  status: RepoStatus | null;
  loading: boolean;
  /** Absent when the session has no working directory at all. */
  cwd: string | null;
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

/** One path, shown under whichever heading it belongs to. */
function FileRow({ file, change }: { file: RepoFile; change: string }) {
  const badge = fileBadge(file.path);
  const name = file.path.split('/').pop() ?? file.path;
  const folder = file.path.slice(0, file.path.length - name.length);

  return (
    <li className={`repo-file ${change}`}>
      <span className="repo-mark" title={change}>
        {MARK[change] ?? '?'}
      </span>
      {badge ? (
        <span className="tool-badge" data-tone={badge.tone}>
          {badge.label}
        </span>
      ) : (
        <span className="tool-badge" />
      )}
      <span className="repo-path" title={file.from ? `${file.path} (was ${file.from})` : file.path}>
        <span className="repo-name">{name}</span>
        {/* The folder after the name and quieter: a list of paths is read by filename, and
            the leading directories are the part every row has in common. */}
        {folder && <span className="repo-folder">{folder}</span>}
      </span>
    </li>
  );
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
export function Repository({ status, loading, cwd, onRefresh, onClose }: RepositoryProps) {
  const staged = status?.files.filter((file) => file.staged) ?? [];
  const unstaged = status?.files.filter((file) => file.unstaged) ?? [];

  return (
    <div className="changes repository">
      <div className="changes-header">
        <strong>Source control</strong>
        {status && (
          <span className="repo-branch" title={status.detached ? 'No branch: HEAD is detached' : undefined}>
            {status.branch}
            {status.upstream && (
              <span className="repo-upstream">
                {' → '}
                {status.upstream}
              </span>
            )}
            {/* Only when there is something to say. A pair of zeroes on every clean
                repository is punctuation. */}
            {status.ahead > 0 && <span className="repo-count">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="repo-count">↓{status.behind}</span>}
          </span>
        )}
        <button type="button" className="changes-action" onClick={onRefresh} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <button type="button" className="changes-action" onClick={onClose}>
          Close
        </button>
      </div>

      {!cwd ? (
        <p className="changes-note">This session has no working directory.</p>
      ) : !status ? (
        <p className="changes-note">
          {loading ? 'Reading the repository…' : 'Not a git repository.'}
        </p>
      ) : status.files.length === 0 ? (
        <p className="changes-note">Nothing has changed.</p>
      ) : (
        <>
          {staged.length > 0 && (
            <>
              <p className="repo-group">Staged</p>
              <ul className="changes-list">
                {staged.map((file) => (
                  <FileRow key={`staged:${file.path}`} file={file} change={file.staged!} />
                ))}
              </ul>
            </>
          )}

          {unstaged.length > 0 && (
            <>
              {/* A file staged and then changed again appears under both, which is what it
                  is: part of it is going into the commit and part of it is not. */}
              <p className="repo-group">Changes</p>
              <ul className="changes-list">
                {unstaged.map((file) => (
                  <FileRow key={`unstaged:${file.path}`} file={file} change={file.unstaged!} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
