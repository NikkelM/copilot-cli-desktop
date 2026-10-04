import { useCallback, useEffect, useMemo, useState } from 'react';

import { goneFrom, needsPruning } from './pruneSessions';
import { read as readStore, save } from './store';
import { tagSlug } from '../../shared/tags';

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
/**
 * The names there are, apart from which sessions carry them.
 *
 * A tag is a name someone invented, and it goes on existing when the last session carrying
 * it is untagged: taking a tag off a session says nothing about wanting the name gone. The
 * only thing that removes a name is retiring it deliberately.
 */
export const TAG_NAMES = 'tagNames';

export const TAGS = 'tags';

/**
 * Tags per session, each session's own sorted alphabetically.
 *
 * Sorted rather than kept in the order they were added, so the same tags read in the same
 * order on every row and line up down the sidebar. Ordering by when someone happened to add
 * them says nothing about them and makes two rows carrying `bug` and `unity` look unrelated.
 */
export type Tags = Readonly<Record<string, readonly string[]>>;

/**
 * What a tag may be.
 *
 * One spelling shared with the wiki, because the two have to match each other: a session
 * tagged `Timeless Manor` and a page tagged `timeless-manor` are the same subject, and
 * anything that answers otherwise leaves them unable to find one another (#35).
 *
 * Spaces were kept here for a while, on the grounds that a tag is a label rather than an
 * identifier and that refusing `needs review` only sends people to `needs-review` without
 * saying why. True in isolation, and wrong the moment the wiki was on the other side of it.
 *
 * Stored tags are read through this as well, so one written before now is the same tag it
 * always was rather than a second one beside its new spelling.
 */
export function normalise(tag: string): string {
  return tagSlug(tag);
}

function read(): Tags {
  try {
    const parsed: unknown = JSON.parse(readStore('sessions', TAGS) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const out: Record<string, string[]> = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const tags = [...new Set(value.filter((t): t is string => typeof t === 'string').map(normalise))]
        .filter(Boolean)
        .sort();
      if (tags.length > 0) out[sessionId] = tags;
    }
    return out;
  } catch {
    return {};
  }
}

function write(tags: Tags): void {
  save('sessions', TAGS, JSON.stringify(tags));
}

/** Forget tags for sessions that are gone. */
async function prune(): Promise<void> {
  const gone = await goneFrom(Object.keys(read()));
  if (!gone) return;

  // Reread rather than filtering the copy asked about: something may have been tagged while
  // the sidecar was answering, and dropping only what is known gone keeps it.
  const kept: Record<string, readonly string[]> = {};
  for (const [sessionId, tags] of Object.entries(read())) {
    if (!gone.has(sessionId)) kept[sessionId] = tags;
  }
  write(kept);
}

/** The names there are, whether or not any session carries them. */
function readNames(): string[] {
  try {
    const parsed: unknown = JSON.parse(readStore('sessions', TAG_NAMES) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((t): t is string => typeof t === 'string').map(normalise))].filter(Boolean).sort();
  } catch {
    return [];
  }
}

function writeNames(names: readonly string[]): void {
  save('sessions', TAG_NAMES, JSON.stringify(names));
}

export function useTags() {
  const [tags, setTags] = useState<Tags>(read);
  const [names, setNames] = useState<string[]>(readNames);

  useEffect(() => {
    if (!needsPruning(TAGS)) return;
    void prune().then(() => {
      setTags(read());
      setNames(readNames());
    });
  }, []);

  /** Add a tag to a session, or take it off if it is already there. */
  const toggle = useCallback((sessionId: string, raw: string) => {
    const tag = normalise(raw);
    if (!tag) return;

    // Naming a tag is what brings it into existence, and taking it off the last session
    // carrying it does not take it back out again.
    setNames((current) => {
      if (current.includes(tag)) return current;
      const next = [...current, tag].sort();
      writeNames(next);
      return next;
    });

    setTags((current) => {
      const held = current[sessionId] ?? [];
      const next = held.includes(tag) ? held.filter((t) => t !== tag) : [...held, tag].sort();

      const all = { ...current };
      if (next.length > 0) all[sessionId] = next;
      else delete all[sessionId];

      write(all);
      return all;
    });
  }, []);

  /**
   * Take a tag off every session, and forget the name.
   *
   * The only thing that removes a name. Untagging says the session is not that; this says
   * the name itself is not wanted, which is also how a mistyped one is fixed.
   */
  const retire = useCallback((raw: string) => {
    const tag = normalise(raw);
    if (!tag) return;

    setNames((current) => {
      const next = current.filter((t) => t !== tag);
      writeNames(next);
      return next;
    });

    setTags((current) => {
      const all: Record<string, readonly string[]> = {};
      for (const [sessionId, held] of Object.entries(current)) {
        const next = held.filter((t) => t !== tag);
        if (next.length > 0) all[sessionId] = next;
      }

      write(all);
      return all;
    });
  }, []);

  /**
   * Every name there is, in the order they read best.
   *
   * The ones in use first and commonest first among those, since that is what is being
   * reached for; then the rest alphabetically. A name nobody is using is still offered -
   * that is the whole point of keeping it - but it is not what someone is looking for.
   *
   * Names in use are folded in whether or not the list of names knows about them, so a store
   * written before names were kept separately still offers everything it holds.
   */
  const known = useMemo(() => {
    const used = countTags(tags).map(({ tag }) => tag);
    const rest = names.filter((tag) => !used.includes(tag));
    return [...used, ...rest];
  }, [tags, names]);

  return { tags, known, toggle, retire };
}

/**
 * Every tag worth offering, with how many sessions it would leave.
 *
 * With nothing chosen that is simply how many carry each tag. With something chosen it is how
 * many carry all of those *and* this one, which is the number that answers the question
 * someone is actually asking: what happens if I also pick this.
 *
 * A tag carried by none of the sessions that remain is not offered at all. That falls out of
 * counting rather than being a rule: those sessions are skipped, so their tags are never
 * reached. The one entry that can read zero is a chosen tag nothing carries.
 *
 * Commonest first because that is what is being reached for; the alphabet only decides ties,
 * which would otherwise fall out in whatever order the store happened to be written in.
 */
export function countTags(tags: Tags, chosen: readonly string[] = []): { tag: string; count: number }[] {
  const counts = new Map<string, number>();

  for (const held of Object.values(tags)) {
    // A session that does not already answer the chosen tags says nothing about what adding
    // another would do. Skipping it is also what leaves a tag out: one carried by no
    // remaining session is never counted, so there is nothing to hide afterwards.
    if (!chosen.every((tag) => held.includes(tag))) continue;
    for (const tag of held) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  // A chosen tag is listed whatever its count, since dropping it would leave no way to unpick
  // a filter that had emptied the list. It is the only entry that can read zero.
  for (const tag of chosen) if (!counts.has(tag)) counts.set(tag, 0);

  return [...counts.entries()]
    .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .map(([tag, count]) => ({ tag, count }));
}
