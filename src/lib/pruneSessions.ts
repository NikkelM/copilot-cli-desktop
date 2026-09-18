import { existingSessions } from './sidecar';

/**
 * Forgetting what this app remembers about sessions that are gone.
 *
 * Three stores keep something per session - favourites, the archive, tags - and none of them
 * is told when a session is deleted. Without this each grows for the life of the install and
 * goes on holding state about sessions nobody can open.
 *
 * The part worth having in one place is not the loop, it is what must be asked and in which
 * order: disk decides, not the sidebar, because a session can be missing from the list for
 * reasons that have nothing to do with deletion, and throwing away a deliberate mark over
 * that would be worse than keeping a stale one (#152).
 */

/**
 * Which of these sessions are gone, or null when there is nothing to do.
 *
 * Returning the dead rather than the living is what makes the callers safe. Each has to
 * re-read its store after this resolves - something may have been marked while the sidecar
 * was answering - and dropping what is known dead keeps that new entry, where keeping what
 * was known alive would silently discard it.
 */
export async function goneFrom(ids: readonly string[]): Promise<ReadonlySet<string> | null> {
  if (ids.length === 0) return null;

  const alive = new Set(await existingSessions([...ids]));
  if (alive.size === ids.length) return null;

  return new Set(ids.filter((id) => !alive.has(id)));
}

/** Stores already pruned. Each answers about the whole install, so once each is enough. */
const pruned = new Set<string>();

/** Whether this store still needs pruning, marking it done. */
export function needsPruning(key: string): boolean {
  if (pruned.has(key)) return false;
  pruned.add(key);
  return true;
}
