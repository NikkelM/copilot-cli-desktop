import { openUrl } from '@tauri-apps/plugin-opener';
import type { DirectoryApplication } from '../../shared/directoryApplications';

/**
 * The page a checkout's GitHub remote has, on the branch the session is on.
 *
 * Linked to the branch rather than the default one, which is usually what is wanted in the
 * middle of a piece of work. Shared with the branch indicator in the header so both go to
 * the same place.
 */
export function githubUrl(remote: string, branch: string | null): string {
  return branch
    ? `https://github.com/${remote}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`
    : `https://github.com/${remote}`;
}

/**
 * Where a session's working directory can be taken.
 *
 * The header showed the path as text, which meant copying it out and switching application
 * by hand. Each of these is somewhere the reader was going to go anyway.
 *
 * Hidden rather than disabled when they do not apply: a session without a repository, or
 * without a directory at all, is normal here rather than an error.
 */
export function OpenIn({
  cwd,
  remote,
  branch,
  onError,
  applications,
  target,
  loading,
  onOpenDirectory,
  error,
}: {
  cwd: string | null;
  /** The `owner/repo` on GitHub, from the checkout's own remote. Null when there is none. */
  remote: string | null;
  branch: string | null;
  onError: (message: string) => void;
  applications: readonly DirectoryApplication[];
  target: string;
  loading: boolean;
  onOpenDirectory: (cwd: string) => void;
  error?: string | null;
}) {
  if (!cwd && !remote) return null;

  const failed = (e: unknown) => onError(String(e));

  return (
    <span className="open-in">
      {cwd && (
        <>
          <button
            type="button"
            onClick={() => onOpenDirectory(cwd)}
            disabled={loading || !applications.some((app) => app.id === target)}
            title={`Open ${cwd} in ${applications.find((app) => app.id === target)?.label ?? 'the selected application'}`}
          >
            Open in {applications.find((app) => app.id === target)?.label ?? 'configured application'}
          </button>
          {error && <span role="alert" className="error">{error}</span>}
        </>
      )}

      {remote && (
        <button
          type="button"
          onClick={() => openUrl(githubUrl(remote, branch)).catch(failed)}
          title={`Open ${remote} on GitHub`}
        >
          GitHub
        </button>
      )}
    </span>
  );
}
