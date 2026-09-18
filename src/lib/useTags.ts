import { useCallback, useEffect, useState } from 'react';

import { existingSessions } from './sidecar';

/**
 * What is true about a session right now, as the reader sees it.
 *
 * Tags are the crosscutting half of organising a list this long: `bug`, `spike`,
 * `needs-review`. Many to a session, and they change often - one tagged `needs-review` today
 * is untagged tomorrow - which is what makes them different from a group, and from a
 * favourite, which is a tag with a fixed name and a place in the ordering (#123).
 *
 * Kept by this app rather than in the CLI's store, which is read-only here and has no notion
 * of either. Keyed by session id so a tag survives the session being renamed.
 */

/** Where they live, beside the app's other choices. */
export const TAGS = 'copilot-desktop.tags';

/** Tags per session. A session with none is absent rather than holding an empty list. */
export type Tags = Readonly<Record<string, readonly string[]>>;

/**
 * What a tag may be.
 *
 * Lowercased and trimmed so `Bug` and `bug ` are the same tag rather than two that look
 * alike in a list. Spaces are kept: a tag is a label rather than an identifier, and refusing
 * `needs review` would only send people to `needs-review` without saying why.
 */
export function normalise(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, ' ');
}

function read(): Tags {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TAGS) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const out: Record<string, string[]> = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const tags = [...new Set(value.filter((t): t is string => typeof t === 'string').map(normalise))].filter(Boolean);
      if (tags.length > 0) out[sessionId] = tags;
    }
    return out;
  } catch {
    return {};
  }
}

function write(tags: Tags): void {
  localStorage.setItem(TAGS, JSON.stringify(tags));
}

/**
 * Forget tags for sessions that are gone.
 *
 * The same reason and the same test as the favourites: nothing else removes an entry, so
 * without this the store grows for the life of the install. A session missing from the list
 * for some other reason must not lose its tags, so this asks disk rather than the sidebar.
 */
async function prune(): Promise<void> {
  const held = read();
  const ids = Object.keys(held);
  if (ids.length === 0) return;

  const alive = new Set(await existingSessions(ids));
  if (alive.size === ids.length) return;

  // Reread rather than filtering the copy above: something may have been tagged while the
  // sidecar was answering, and that entry is newer than anything here.
  const now = read();
  const kept: Record<string, readonly string[]> = {};
  for (const [sessionId, tags] of Object.entries(now)) {
    if (alive.has(sessionId) || !ids.includes(sessionId)) kept[sessionId] = tags;
  }
  write(kept);
}

let pruned = false;

export function useTags() {
  const [tags, setTags] = useState<Tags>(read);

  useEffect(() => {
    if (pruned) return;
    pruned = true;
    void prune().then(() => setTags(read()));
  }, []);

  /** Add a tag to a session, or take it off if it is already there. */
  const toggle = useCallback((sessionId: string, raw: string) => {
    const tag = normalise(raw);
    if (!tag) return;

    setTags((current) => {
      const held = current[sessionId] ?? [];
      const next = held.includes(tag) ? held.filter((t) => t !== tag) : [...held, tag];

      const all = { ...current };
      if (next.length > 0) all[sessionId] = next;
      else delete all[sessionId];

      write(all);
      return all;
    });
  }, []);

  return { tags, toggle };
}

/** Every tag in use, in the order they read best: commonest first, then alphabetically. */
export function allTags(tags: Tags): string[] {
  const counts = new Map<string, number>();
  for (const held of Object.values(tags)) {
    for (const tag of held) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .map(([tag]) => tag);
}
