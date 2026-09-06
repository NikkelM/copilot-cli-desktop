import type { ModelChoice, ReasoningEffort } from '../../shared/protocol';

/**
 * The levels in the order they mean something, least to most.
 *
 * Which is not the order a model happens to list them in, and is what makes one level the
 * nearest thing to another.
 */
const SCALE = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ReasoningEffort[];

/**
 * Adding a level to the protocol without ranking it here is a compile error.
 *
 * A level missing from the scale would be silently unrankable, and the picker would quietly
 * stop offering the nearest thing to it. Better to be told at the point of adding it.
 */
type Unranked = Exclude<ReasoningEffort, (typeof SCALE)[number]>;
const RANKED: Unranked extends never ? true : never = true;
void RANKED;

const rankOf = (level: string) => (SCALE as readonly string[]).indexOf(level);

/**
 * The effort a model should start at when the picker offers it.
 *
 * Something has to be chosen: committing a model sends whatever the row holds, so a row
 * with no effort on it would quietly leave that to the runtime rather than to the reader.
 *
 * A reader moving between models is saying something about the model, not about how hard
 * they want it to think, so the level they are already at is kept where the model has it
 * and otherwise the nearest one to it - xhigh becomes high before it becomes anything else.
 * Only with nothing to be near does this fall back to what the model says it prefers, and
 * then to the middle of what it offers.
 */
export function startingEffort(model: ModelChoice, wanted?: ReasoningEffort): ReasoningEffort | undefined {
  const levels = model.reasoningEfforts;
  if (levels.length === 0) return undefined;

  if (wanted && levels.includes(wanted)) return wanted;

  const nearest = wanted && nearestTo(wanted, levels);
  if (nearest) return nearest;

  if (model.defaultReasoningEffort && levels.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }

  // "Medium" by name where a model has one, since a named middle beats a counted one, and
  // by position otherwise.
  return levels.includes('medium') ? 'medium' : levels[Math.floor((levels.length - 1) / 2)];
}

/** The offered level closest to one that is not offered, the lower of two equally close. */
function nearestTo(wanted: ReasoningEffort, levels: ReasoningEffort[]): ReasoningEffort | undefined {
  const target = rankOf(wanted);
  // A level this app has never heard of cannot be measured against anything.
  if (target === -1) return undefined;

  const ranked = levels
    .map((level, index) => ({ level, rank: rank(level, index, levels) }))
    .filter((entry): entry is { level: ReasoningEffort; rank: number } => entry.rank !== null)
    .sort((a, b) => {
      const distance = Math.abs(a.rank - target) - Math.abs(b.rank - target);
      // Equally close in both directions means going down rather than up: spending more
      // than was asked for is the worse of the two mistakes.
      return distance || a.rank - b.rank;
    });

  return ranked[0]?.level;
}

/**
 * Where a level sits on the scale, including one the scale has never heard of.
 *
 * The runtime lists a model's levels from least to most, so a level this app does not know
 * still has neighbours that it does, and belongs between them. That keeps a level added
 * after this was written rankable rather than invisible, which matters because being
 * invisible here means never being offered as the nearest thing to anything.
 */
function rank(level: ReasoningEffort, index: number, levels: ReasoningEffort[]): number | null {
  const known = rankOf(level);
  if (known !== -1) return known;

  const below = levels.slice(0, index).map(rankOf).filter((at) => at !== -1);
  const above = levels.slice(index + 1).map(rankOf).filter((at) => at !== -1);

  if (below.length && above.length) return (Math.max(...below) + Math.min(...above)) / 2;
  if (below.length) return Math.max(...below) + 0.5;
  if (above.length) return Math.min(...above) - 0.5;

  // Nothing around it is known either, so there is no telling where it belongs.
  return null;
}
