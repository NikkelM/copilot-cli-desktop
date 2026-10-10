import { useEffect, useMemo, useRef, useState } from 'react';

import { messageOf } from './errors';
import { splitDirectoryInput } from './useDirectoryCompletion';
import { listEntries } from './sidecar';

/** A file or folder offered for a mention being written. */
export interface MentionChoice {
  name: string;
  /** What the mention becomes if this is taken, including everything typed before it. */
  path: string;
  directory: boolean;
  /** The separator to follow a folder with, so the next segment can be typed straight away. */
  separator: string;
  /**
   * Whether this is still inside the session's working directory.
   *
   * A relative path reads back to the agent against the same place it was typed against, so
   * it is the better thing to put in a message - right up until it climbs out with `..`,
   * where it stops being resolvable from the session alone and has to be named in full.
   */
  inside: boolean;
  /** Where the file actually is, for the case above. */
  absolute: string;
}

interface Listing {
  key: string;
  entries: { name: string; directory: boolean }[];
  directory: string;
  separator: string;
  caseSensitive: boolean;
}

/** A folder of thousands should not become thousands of rows, as the path menu already has it. */
const MAX_VISIBLE = 200;

/**
 * Whether one path is the other or sits beneath it.
 *
 * Compared as text, folded for case, because this is about two answers from the same machine
 * rather than about what a filesystem would accept. The separator comes from the sidecar, so
 * the comparison uses the platform's own rather than guessing at one.
 */
function within(folder: string, root: string, separator: string, caseSensitive: boolean): boolean {
  if (!folder || !root) return false;

  const fold = (path: string) => (caseSensitive ? path : path.toLowerCase());
  const base = fold(root.endsWith(separator) ? root.slice(0, -separator.length) : root);
  const here = fold(folder);

  return here === base || here.startsWith(`${base}${separator}`);
}

/**
 * Files and folders matching the path being mentioned (#135).
 *
 * Built the same way the path argument menu is: the sidecar reads only when the folder part
 * changes, and narrowing the last segment is local - so each letter typed in one folder
 * costs no round trip and no further disk access. The difference is only in what comes back,
 * since naming a file is the whole point of `@`.
 *
 * @param path what has been typed after the `@`, or null when no mention is being written.
 */
export function useMentionCompletion(
  path: string | null,
  cwd: string | null,
  onError: (message: string) => void,
): MentionChoice[] {
  const parts = splitDirectoryInput(path ?? '');
  // Only inside a session: a relative path has no honest base without one, and the sidecar
  // refuses to guess rather than browsing wherever it happens to be installed.
  const key = path !== null && cwd ? `${cwd}\0${parts.directory}` : null;
  const [listing, setListing] = useState<Listing | null>(null);
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    if (!key) return;

    let current = true;
    listEntries(cwd ?? undefined, parts.directory)
      .then((found) => {
        if (current) setListing({ key, ...found });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setListing(null);
        report.current(`Could not list files: ${messageOf(error)}`);
      });

    return () => {
      current = false;
    };
  }, [cwd, key, parts.directory]);

  return useMemo(() => {
    if (!key || listing?.key !== key) return [];

    const wanted = listing.caseSensitive ? parts.prefix : parts.prefix.toLowerCase();
    const separator = parts.separator ?? listing.separator;
    const inside = within(listing.directory, cwd ?? '', listing.separator, listing.caseSensitive);

    return listing.entries
      .filter((entry) => {
        const candidate = listing.caseSensitive ? entry.name : entry.name.toLowerCase();
        return candidate.startsWith(wanted);
      })
      .slice(0, MAX_VISIBLE)
      .map((entry) => ({
        name: entry.name,
        path: `${parts.base}${entry.name}`,
        directory: entry.directory,
        separator,
        inside,
        absolute: `${listing.directory}${listing.separator}${entry.name}`,
      }));
  }, [cwd, key, listing, parts.base, parts.prefix, parts.separator]);
}
