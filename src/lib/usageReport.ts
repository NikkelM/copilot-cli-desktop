import type { SessionUsage } from '../../shared/protocol';

/** Thousands separated, since these run to seven figures and are read at a glance. */
function count(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Premium requests, which are fractional because each model carries a multiplier.
 *
 * Shown to one decimal only when there is one: a whole number of requests reading `45.0`
 * suggests a precision the figure does not have.
 */
function requests(value: number): string {
  return Number.isInteger(value) ? count(value) : value.toFixed(1);
}

/** AI units, to the precision the number deserves rather than the nine decimals it arrives with. */
function units(value: number): string {
  if (value === 0) return '0';
  return value < 10 ? value.toFixed(2) : count(value);
}

/** A duration a reader can hold in their head, rather than milliseconds. */
function spent(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * What a session has cost, as the transcript row `/usage` leaves behind.
 *
 * Markdown, because it is a table of figures and the transcript already renders markdown.
 *
 * How much there is to say depends on which side answered. A loaded session accounts for
 * its tokens, its requests and the code it changed; a cold one knows only the two running
 * totals from its log. Rather than showing empty rows for the rest, the difference is
 * stated - a reader who wants the detail can send a message and ask again, and should know
 * that is what it takes.
 */
export function usageReport(usage: SessionUsage | null): string {
  if (!usage) {
    return 'Nothing recorded yet. A session accounts for itself once it has finished a turn.';
  }

  const lines = [
    '| What | Amount |',
    '|---|---|',
    `| Premium requests | ${requests(usage.premiumRequests)} |`,
    `| AI units | ${units(usage.aiu)} |`,
  ];

  if (usage.requests !== undefined) lines.push(`| Model calls | ${count(usage.requests)} |`);
  if (usage.apiDurationMs !== undefined && usage.apiDurationMs > 0) {
    lines.push(`| Time in the model | ${spent(usage.apiDurationMs)} |`);
  }

  if (usage.tokens) {
    const { input, output, cacheRead, cacheWrite, reasoning } = usage.tokens;
    lines.push(`| Tokens in | ${count(input)} |`);
    lines.push(`| Tokens out | ${count(output)} |`);
    if (reasoning > 0) lines.push(`| Thinking | ${count(reasoning)} |`);
    // Worth separating: cached tokens are most of a long session's input and are charged
    // differently, so a single input figure reads as far more expensive than it was.
    if (cacheRead > 0 || cacheWrite > 0) {
      lines.push(`| Cache read / written | ${count(cacheRead)} / ${count(cacheWrite)} |`);
    }
  }

  const changed = usage.codeChanges;
  if (changed && (changed.linesAdded > 0 || changed.linesRemoved > 0)) {
    lines.push(
      `| Code changed | +${count(changed.linesAdded)} -${count(changed.linesRemoved)} ` +
        `in ${count(changed.filesModified)} file${changed.filesModified === 1 ? '' : 's'} |`,
    );
  }

  const models = usage.models?.filter((model) => model.requests > 0) ?? [];
  // Only worth a section when there is a division to show; one model is already the answer.
  if (models.length > 1) {
    lines.push('', 'By model:', '');
    for (const model of models) {
      lines.push(`- ${model.model}: ${count(model.requests)} calls, ${requests(model.cost)} premium`);
    }
  }

  if (!usage.loaded) {
    lines.push(
      '',
      'Read from this session\u2019s log, which records what it spent but not how. ' +
        'Tokens and the rest are only known while the session is loaded.',
    );
  }

  return lines.join('\n');
}
