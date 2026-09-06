import type { ModelChoice, ReasoningEffort } from '../../shared/protocol';

/**
 * The effort a model should start at when the picker offers it.
 *
 * Something has to be chosen: committing a model sends whatever the row holds, so a row
 * with no effort on it would quietly leave that to the runtime rather than to the reader.
 * In order of preference, that is what the session already runs at, what the model says its
 * own default is, and failing both the middle of what it offers - the level that assumes
 * least about what the reader wanted.
 */
export function startingEffort(model: ModelChoice, wanted?: ReasoningEffort): ReasoningEffort | undefined {
  const levels = model.reasoningEfforts;
  if (levels.length === 0) return undefined;

  if (wanted && levels.includes(wanted)) return wanted;
  if (model.defaultReasoningEffort && levels.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }

  // "Medium" by name where a model has one, since a named middle beats a counted one, and
  // by position otherwise.
  return levels.includes('medium') ? 'medium' : levels[Math.floor((levels.length - 1) / 2)];
}
