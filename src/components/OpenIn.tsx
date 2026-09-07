import { openPath, openUrl } from '@tauri-apps/plugin-opener';

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
}: {
  cwd: string | null;
  /** The `owner/repo` on GitHub, from the checkout's own remote. Null when there is none. */
  remote: string | null;
  branch: string | null;
  onError: (message: string) => void;
}) {
  if (!cwd && !remote) return null;

  const failed = (e: unknown) => onError(String(e));

  return (
    <span className="open-in">
      {cwd && (
        <>
          <button type="button" onClick={() => openPath(cwd).catch(failed)} title={`Open ${cwd}`}>
            Folder
          </button>
          {/* Through its URI rather than the command, which would depend on code-insiders
              being on PATH. `windowId=_blank` is what stops it throwing the folder into
              whichever window was focused last, replacing what was open there - measured,
              the plain URI leaves the window count unchanged and this raises it. */}
          <button
            type="button"
            onClick={() =>
              openUrl(`vscode-insiders://file/${cwd.replace(/\\/g, '/')}?windowId=_blank`).catch(failed)
            }
            title="Open in a new VS Code Insiders window"
          >
            VS Code
          </button>
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
