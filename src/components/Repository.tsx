import { useEffect, useState } from 'react';

import { canAmend, type FileDiff, type RepoFile, type RepoStatus } from '../../shared/protocol';
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
  /** Paths with a staging operation in flight, so a row cannot be clicked twice. */
  busy: string[];
  /** Put paths into the index, or take them back out. */
  onStage: (paths: string[], staged: boolean) => void;
  /** Commit what is staged, or amend the commit at HEAD. */
  onCommit: (message: string, amend: boolean) => void;
  committing: boolean;
  /** What could not be done, so a button never appears to do nothing. */
  failed: string | null;
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
  busy,
  onToggle,
  onStage,
}: {
  file: RepoFile;
  change: string;
  staged: boolean;
  open: boolean;
  diff: FileDiff | undefined;
  busy: boolean;
  onToggle: () => void;
  onStage: () => void;
}) {
  const badge = fileBadge(file.path);
  const name = file.path.split('/').pop() ?? file.path;
  const folder = file.path.slice(0, file.path.length - name.length);

  return (
    <li>
      <div className="repo-row">
        {/* Leftmost and always drawn, rather than at the far end of a row that is as wide as
            the window: on a wide screen nobody looks over there, and a control nobody finds
            is a control that is not there. */}
        {change !== 'unmerged' ? (
          <button
            type="button"
            className="repo-stage"
            onClick={onStage}
            disabled={busy}
            title={staged ? `Take ${name} out of the next commit` : `Put ${name} into the next commit`}
            aria-label={staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
          >
            {staged ? '−' : '+'}
          </button>
        ) : (
          /* Unmerged files are left alone: staging one would record a half-resolved conflict
             as if it were the answer, and this panel has no way to resolve it. The space is
             kept so the paths beside it still line up. */
          <span className="repo-stage empty" />
        )}

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
            {/* The folder after the name and quieter: a list of paths is read by filename,
                and the leading directories are the part every row has in common. */}
            {folder && <span className="repo-folder">{folder}</span>}
          </span>
        </button>
      </div>

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
 * Where a subject stops being a subject.
 *
 * Fifty is the line git's own tooling wraps at and every log viewer assumes; past seventy-two
 * it is being truncated somewhere. Both are shown as colour rather than enforced - it is the
 * reader's message, and a panel that refused to commit over a long line would be wrong.
 */
const SUBJECT_COMFORTABLE = 50;
const SUBJECT_LONG = 72;

/**
 * Writing a commit.
 *
 * The message is the reader's. Nothing here writes one, suggests one, or fills the box in
 * from the diff - if that is ever offered it has to arrive as a suggestion that is edited
 * and confirmed, never as text that committed itself (#44).
 */
function Commit({
  staged,
  canAmend,
  committing,
  onCommit,
}: {
  staged: number;
  canAmend: boolean;
  committing: boolean;
  onCommit: (message: string, amend: boolean) => void;
}) {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const subject = message.split('\n')[0] ?? '';
  const ready = message.trim().length > 0 && (staged > 0 || amend) && !committing;

  return (
    <div className="repo-commit">
      <textarea
        className="repo-message"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder={amend ? 'Reword the last commit' : 'What this commit does, and why'}
        rows={3}
        spellCheck
        aria-label="Commit message"
        onKeyDown={(event) => {
          // The key every commit box answers to. Enter alone is a newline, because a commit
          // message has more than one line more often than it does not.
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && ready) {
            event.preventDefault();
            onCommit(message, amend);
            setMessage('');
          }
        }}
      />

      <div className="repo-commit-row">
        {/* What is going in, said before it goes in rather than after. */}
        <span className="repo-commit-count">
          {amend
            ? staged > 0
              ? `Amending, with ${staged} staged ${staged === 1 ? 'file' : 'files'}`
              : 'Amending the message only'
            : `${staged} staged ${staged === 1 ? 'file' : 'files'}`}
        </span>

        {subject.length > 0 && (
          <span
            className={
              subject.length > SUBJECT_LONG
                ? 'repo-subject long'
                : subject.length > SUBJECT_COMFORTABLE
                  ? 'repo-subject wide'
                  : 'repo-subject'
            }
            title={`Subject line: ${subject.length} characters`}
          >
            {subject.length}
          </span>
        )}

        {/* Absent rather than disabled once the commit is published: an amend that cannot be
            done is not a choice the reader should be offered and then refused. */}
        {canAmend && (
          <label className="repo-amend">
            <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />
            Amend last
          </label>
        )}

        <button
          type="button"
          className="changes-action primary"
          onClick={() => {
            onCommit(message, amend);
            setMessage('');
          }}
          disabled={!ready}
          title="Commit (Ctrl+Enter)"
        >
          {committing ? 'Committing…' : 'Commit'}
        </button>
      </div>
    </div>
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
export function Repository({
  status,
  loading,
  cwd,
  diffs,
  onDiff,
  busy,
  onStage,
  onCommit,
  committing,
  failed,
  onRefresh,
  onClose,
}: RepositoryProps) {
  const staged = status?.files.filter((file) => file.staged) ?? [];
  const unstaged = status?.files.filter((file) => file.unstaged) ?? [];
  /** Which row is open, since one file can appear under both headings with different diffs. */
  const [open, setOpen] = useState<{ path: string; staged: boolean } | null>(null);

  /**
   * Ask for the open row's diff whenever it does not have one.
   *
   * Covers opening a row and, less obviously, reading the tree again: a refresh drops every
   * held diff, because a diff describes the state the status was read in. Without this the
   * open row said it was reading and then never was, until it was collapsed and reopened.
   *
   * Settles rather than loops, because a diff that cannot be read is still recorded - the
   * absence is what this reacts to, and it is filled either way.
   */
  useEffect(() => {
    if (open && !diffs[diffKey(open.path, open.staged)]) onDiff(open.path, open.staged);
  }, [open, diffs, onDiff]);

  const toggle = (path: string, isStaged: boolean) => {
    setOpen((current) =>
      current && current.path === path && current.staged === isStaged ? null : { path, staged: isStaged },
    );
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

      {/* Said where the action was taken rather than at the top: a button that appears to
          have done nothing is the thing worth explaining. */}
      {failed && <p className="error">{failed}</p>}

      {/* Under the head and above the lists, so what is being written sits next to what it
          will record. Only in a repository: there is nothing to commit to otherwise. */}
      {status && (
        <Commit
          staged={staged.length}
          canAmend={canAmend(status)}
          committing={committing}
          onCommit={onCommit}
        />
      )}

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
              <p className="repo-group">
                <button
                  type="button"
                  className="repo-stage"
                  onClick={() => onStage(staged.map((file) => file.path), false)}
                  disabled={staged.some((file) => busy.includes(file.path))}
                  title="Take everything out of the next commit"
                  aria-label="Unstage all"
                >
                  −
                </button>
                <span className="repo-group-label">Staged</span>
              </p>
              <ul className="changes-list">
                {staged.map((file) => (
                  <FileRow
                    key={`staged:${file.path}`}
                    file={file}
                    change={file.staged!}
                    staged
                    open={open?.path === file.path && open.staged}
                    diff={diffs[diffKey(file.path, true)]}
                    busy={busy.includes(file.path)}
                    onToggle={() => toggle(file.path, true)}
                    onStage={() => onStage([file.path], false)}
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
              <p className="repo-group">
                <button
                  type="button"
                  className="repo-stage"
                  onClick={() => onStage(unstaged.map((file) => file.path), true)}
                  disabled={unstaged.some((file) => busy.includes(file.path))}
                  title="Put everything into the next commit"
                  aria-label="Stage all"
                >
                  +
                </button>
                <span className="repo-group-label">Changes</span>
              </p>
              <ul className="changes-list">
                {unstaged.map((file) => (
                  <FileRow
                    key={`unstaged:${file.path}`}
                    file={file}
                    change={file.unstaged!}
                    staged={false}
                    open={open?.path === file.path && !open.staged}
                    diff={diffs[diffKey(file.path, false)]}
                    busy={busy.includes(file.path)}
                    onToggle={() => toggle(file.path, false)}
                    onStage={() => onStage([file.path], true)}
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



