import { useEffect, useRef, useState } from 'react';

import { startingEffort } from '../lib/models';
import { credits, tokens } from '../lib/units';
import type {
  ContextTier,
  ModelChoice,
  ReasoningEffort,
  SessionContextUsage,
  SessionModel,
} from '../../shared/protocol';

export interface ModelChoiceMade {
  model: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: ContextTier;
}

interface ModelPickerProps {
  /** What the session runs on: null when its log never said, undefined until it is read. */
  current: SessionModel | null | undefined;
  /** What is available. Remembered between runs, so it is usually known before opening. */
  models: ModelChoice[] | null;
  /** How full the window is. Null for a session the runtime is not holding, which has no window. */
  usage: SessionContextUsage | null;
  /** Why the catalogue could not be fetched, if it could not. */
  failed: string | null;
  /** Refresh the catalogue. Costs a running server, so it waits for the picker to open. */
  onOpen: () => void;
  onChoose: (choice: ModelChoiceMade) => void;
  /**
   * What to say when nothing is chosen.
   *
   * A session always runs on something, so for one this means its log never said. Choosing
   * a default for sessions not yet made is the other case, where nothing chosen is a real
   * answer rather than a gap (#200).
   */
  emptyLabel?: string;
}

/**
 * What the room has gone on, for the meter's tooltip.
 *
 * Ordered largest first rather than by name: the reason to open this is to find what is
 * taking the space, and empty buckets are left out so a session with no MCP servers does not
 * read as having them.
 */
function spentOn(usage: SessionContextUsage): string {
  const parts: [string, number][] = [
    ['messages', usage.categories.messages],
    ['tools', usage.categories.systemTools],
    ['MCP tools', usage.categories.mcpTools],
    ['system prompt', usage.categories.systemPrompt],
    ['instructions', usage.categories.customInstructions],
  ];

  const spent = parts
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${tokens(count)} ${label}`)
    .join(', ');

  const compacted =
    usage.compactions > 0 ? `, compacted ${usage.compactions === 1 ? 'once' : `${usage.compactions} times`}` : '';

  return `${spent}${compacted}`;
}

/**
 * Which model a session runs on, how hard it is asked to think, and how much room it has.
 *
 * All three read as one setting, so the closed control shows all three and the menu offers
 * all three: changing the effort should not mean finding the model again.
 */
export function ModelPicker({
  current,
  models,
  usage,
  failed,
  onOpen,
  onChoose,
  emptyLabel = 'No model recorded',
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  /** The row under the pointer, so its price can be read without committing to it. */
  const [hovered, setHovered] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    // Clicking elsewhere, or pressing Escape, is how a menu is dismissed everywhere else.
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);

    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }

    setOpen(true);
    setHovered(null);
    // Asking costs a server process, so it waits for someone to actually want the list.
    onOpen();
  }

  const effort = current?.reasoningEffort && current.reasoningEffort !== 'none' ? current.reasoningEffort : null;
  const inUse = models?.find((model) => model.id === current?.model);
  // Named by size rather than by tier, since the size is the whole difference between them.
  const room = inUse?.contexts.find((context) => context.tier === (current?.contextTier ?? 'default'));
  // Whichever model the reader is looking at, which is the one they want the price of.
  const described = (hovered && models?.find((model) => model.id === hovered)) || inUse;

  return (
    <div className="model" ref={box}>
      <button
        type="button"
        className="model-current"
        onClick={toggle}
        title="Change the model, how hard it thinks, and how much room it has"
      >
        {/* Named even before the catalogue is known: this comes from the session's own log,
            so a session says what it runs on without being started. While that read is in
            flight the control holds its shape rather than showing a name that may turn out
            to be wrong - blanking the text alone collapsed it to an empty blob. */}
        {current === undefined ? (
          <span className="model-id waiting" aria-label="Reading which model this session uses" />
        ) : (
          <span className="model-id">{current?.model ?? emptyLabel}</span>
        )}
        {effort && <span className="model-tag">{effort}</span>}
        {/* How much room is left beats how much there is, so the meter replaces the size
            whenever the runtime can say. Only a loaded session can: a cold one is occupying
            no window, and its size alone still tells the reader what it would have. */}
        {usage ? (
          <span
            className={`model-tag context${usage.totalTokens >= usage.compactionThreshold ? ' pressed' : ''}`}
            title={`Context: ${spentOn(usage)}`}
          >
            {tokens(usage.totalTokens)}/{tokens(usage.promptTokenLimit)}
          </span>
        ) : (
          /* Only once the catalogue is known, since the size is not in the session's log. */
          room && <span className="model-tag">{tokens(room.maxPromptTokens)}</span>
        )}
      </button>

      {open && (
        <div className="model-menu" role="listbox" onMouseLeave={() => setHovered(null)}>
          {failed && <p className="error">{failed}</p>}
          {!models && !failed && <p className="model-loading">Starting the runtime to ask what is available.</p>}

          {described && <Prices model={described} />}

          {models?.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              current={current}
              onChoose={onChoose}
              onDone={() => setOpen(false)}
              onLookAt={() => setHovered(model.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What a million tokens costs on the model being looked at.
 *
 * One model at a time rather than a price beside every row, which would bury the list the
 * reader came for. It follows the pointer, so comparing two models is a matter of moving
 * between them, and falls back to the model in use when the pointer is elsewhere.
 */
function Prices({ model }: { model: ModelChoice }) {
  const rows: ReadonlyArray<[string, number | undefined]> = [
    ['Input', model.prices?.input],
    ['Cached input', model.prices?.cachedInput],
    ['Output', model.prices?.output],
  ];
  const known = rows.filter(([, amount]) => amount !== undefined);

  return (
    <div className="model-prices">
      <p className="model-prices-head">
        Cost per 1M tokens<span className="model-prices-of"> · {model.name}</span>
      </p>

      {/* Auto has no price of its own: what it costs depends on where it routes. */}
      {known.length === 0 && <p className="model-price">Not priced on its own</p>}

      {known.map(([label, amount]) => (
        <p className="model-price" key={label}>
          <span className="model-price-label">{label}</span>
          <span className="model-price-value">{credits(amount!)} credits</span>
        </p>
      ))}
    </div>
  );
}

/**
 * One model, with what can be asked of it beside it.
 *
 * Choosing is deliberately two steps: the levels and the context sizes only set themselves,
 * and the model name commits. A reader wanting a different effort usually wants to say
 * something about the context too, and committing on the first of those would send them
 * back into the menu to say the second.
 */function ModelRow({
  model,
  current,
  onChoose,
  onDone,
  onLookAt,
}: {
  model: ModelChoice;
  current: SessionModel | null | undefined;
  onChoose: (choice: ModelChoiceMade) => void;
  onDone: () => void;
  onLookAt: () => void;
}) {
  const chosen = current?.model === model.id;

  // Every row starts from what the session is set to, not just the row for the model it is
  // on: someone changing model almost always wants to carry their effort and their context
  // across rather than restate them. Where this model does not offer what the session uses,
  // the row still starts somewhere, since committing sends whatever it holds.
  const wantedTier = (current?.contextTier as ContextTier) ?? 'default';

  // Held per row, and forgotten when the menu closes, because a half-made choice on a model
  // that was not committed to means nothing later.
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(() =>
    startingEffort(model, current?.reasoningEffort as ReasoningEffort | undefined),
  );
  const [tier, setTier] = useState<ContextTier>(
    model.contexts.some((context) => context.tier === wantedTier) ? wantedTier : 'default',
  );

  return (
    // Focus does what the pointer does, so the price follows a reader using the keyboard.
    <div
      className={chosen ? 'model-row chosen' : 'model-row'}
      onMouseEnter={onLookAt}
      onFocus={onLookAt}
    >
      <button
        type="button"
        className="model-name"
        role="option"
        aria-selected={chosen}
        onClick={() => {
          onChoose({ model: model.id, reasoningEffort: effort, contextTier: tier });
          onDone();
        }}
      >
        {model.name}
        {model.needsAgreement && <span className="model-note">terms not accepted</span>}
      </button>

      {model.reasoningEfforts.length > 0 && (
        <div className="model-line">
          <span className="model-line-label">Effort</span>
          {model.reasoningEfforts.map((level) => (
            <button
              type="button"
              key={level}
              className={effort === level ? 'model-option chosen' : 'model-option'}
              aria-pressed={effort === level}
              onClick={() => setEffort(level)}
              aria-label={`${model.name} thinking ${level}`}
            >
              {level}
            </button>
          ))}
        </div>
      )}

      {model.contexts.length > 1 && (
        <div className="model-line">
          <span className="model-line-label">Context</span>
          {model.contexts.map((context) => (
            <button
              type="button"
              key={context.tier}
              className={tier === context.tier ? 'model-option chosen' : 'model-option'}
              aria-pressed={tier === context.tier}
              onClick={() => setTier(context.tier)}
              aria-label={`${model.name} with ${tokens(context.maxPromptTokens)} of context`}
            >
              {tokens(context.maxPromptTokens)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
