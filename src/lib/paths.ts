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
