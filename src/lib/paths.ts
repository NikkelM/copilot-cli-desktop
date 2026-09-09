/**
 * The last part of a path, whichever way its separators lean.
 *
 * Both separators, because a path can come from the clipboard, from a picker or from the
 * sidecar, and only one of those three is guaranteed to have been through Node.
 */
export function nameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Show paths relative to the session's working directory.
 * Absolute paths are mostly repeated prefix, which crowds out the part that matters.
 */
export function relativise(path: string, cwd: string | null): string {
  if (!cwd) return path;

  const normalise = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = normalise(path);
  const base = normalise(cwd);

  // Windows paths are case-insensitive, so compare case-folded but keep the original text.
  if (target.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
    return target.slice(base.length + 1);
  }
  return path;
}

/**
 * Write the home directory as `~`, the way a shell does.
 *
 * The prefix every path shares is the least interesting part of it, and a working directory
 * shown in full pushes the part that identifies it off the end of the line.
 */
export function shortenHome(path: string, home: string): string {
  if (!home) return path;

  const normalise = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = normalise(path);
  const base = normalise(home);
  if (!base) return path;

  if (target === base) return '~';
  // The separator is kept from the original path rather than imposed, so a Windows path
  // still reads as one.
  if (target.startsWith(`${base}/`)) return `~${path.slice(base.length)}`;
  return path;
}
