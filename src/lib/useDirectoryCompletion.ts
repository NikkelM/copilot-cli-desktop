import { useEffect, useMemo, useRef, useState } from 'react';

import { messageOf } from './errors';
import { listDirectories } from './sidecar';
import type { SlashCommand } from '../../shared/protocol';

interface DirectoryInput {
  /** The path whose children should be read. */
  directory: string;
  /** The text kept before a chosen child's name. */
  base: string;
  /** The incomplete final segment used to filter those children. */
  prefix: string;
  /** The separator already chosen by the reader, if there is one. */
  separator?: string;
}

export interface DirectoryCompletion {
  name: string;
  /** The command argument with this directory selected. */
  path: string;
  /** The character to append when Tab drills into it. */
  separator: string;
}

interface Listing {
  key: string;
  entries: string[];
  separator: string;
  caseSensitive: boolean;
}

/** Keep an unfiltered directory with thousands of children from producing thousands of DOM rows. */
const MAX_VISIBLE = 200;

/**
 * Separate the directory to read from the final segment being filtered.
 *
 * Both separators are understood because Windows accepts either and a pasted path should
 * keep the style it already uses rather than changing halfway through.
 */
export function splitDirectoryInput(input: string): DirectoryInput {
  if (input === '~') return { directory: '~/', base: '~/', prefix: '', separator: '/' };
  if (/^[a-z]:$/i.test(input)) {
    const base = `${input}\\`;
    return { directory: base, base, prefix: '', separator: '\\' };
  }

  const slash = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'));
  if (slash === -1) return { directory: '', base: '', prefix: input };

  const base = input.slice(0, slash + 1);
  return {
    directory: base,
    base,
    prefix: input.slice(slash + 1),
    separator: input[slash],
  };
}

/**
 * Directory arguments matching what is currently typed.
 *
 * The sidecar reads only when the directory part changes. Filtering the final segment is
 * local, so each letter typed in one folder costs no IPC and no further disk access.
 */
export function useDirectoryCompletion(
  command: SlashCommand | undefined,
  input: string | null,
  cwd: string | null,
  onError: (message: string) => void,
): DirectoryCompletion[] {
  const enabled = command?.completion === 'directory' && input !== null;
  const parts = splitDirectoryInput(input ?? '');
  const key = enabled ? `${cwd ?? ''}\0${parts.directory}` : null;
  const [listing, setListing] = useState<Listing | null>(null);
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    if (!key) return;

    let current = true;
    listDirectories(cwd ?? undefined, parts.directory)
      .then((found) => {
        if (current) setListing({ key, ...found });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setListing(null);
        report.current(`Could not list directories: ${messageOf(error)}`);
      });

    return () => {
      current = false;
    };
  }, [cwd, key, parts.directory]);

  return useMemo(() => {
    if (!key || listing?.key !== key) return [];

    const wanted = listing.caseSensitive ? parts.prefix : parts.prefix.toLowerCase();
    const separator = parts.separator ?? listing.separator;
    return listing.entries
      .filter((name) => {
        const candidate = listing.caseSensitive ? name : name.toLowerCase();
        return candidate.startsWith(wanted);
      })
      .slice(0, MAX_VISIBLE)
      .map((name) => ({ name, path: `${parts.base}${name}`, separator }));
  }, [key, listing, parts.base, parts.prefix, parts.separator]);
}
