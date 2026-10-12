import { useCallback, useRef, useState } from 'react';

import { startingEffort } from '../lib/models';
import { credits, tokens } from '../lib/units';
import { FloatingMenu } from './FloatingMenu';
import { ChevronIcon } from './Icons';
import type {
  AutoTier,
  ContextTier,
  ModelChoice,
  ReasoningEffort,
  SessionAutoTier,
  SessionContextUsage,
  SessionModel,
} from '../../shared/protocol';

export interface ModelChoiceMade {
  model: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: ContextTier;
  /** How `auto` should route. Carried with the model because the runtime takes it that way. */
  autoTier?: AutoTier | null;
}

/**
 * The routing preferences offered, which is three of the four the runtime takes.
 *
 * `fast` is left out: the SDK calls it an integrator-only latency preset and says it is not
 * a first-party product preference, so putting it beside the three that are would misreport
 * what it is.
 */
const AUTO_TIERS: readonly AutoTier[] = ['efficiency', 'balance', 'intelligence'];

interface ModelPickerProps {
  /** What the session runs on: null when its log never said, undefined until it is read. */
  current: SessionModel | null | undefined;
  /** What is available. Remembered between runs, so it is usually known before opening. */
  models: ModelChoice[] | null;
  /** How full the window is. Null for a session the runtime is not holding, which has no window. */
  usage: SessionContextUsage | null;
  /**
   * How auto routes, for a loaded session (#215).
   *
   * Null where there is no session to ask, and absent where there is no session at all -
   * the same picker chooses the defaults for sessions not yet made, and a routing
   * preference belongs to a running session rather than to a choice about future ones.
   */
  autoTier?: SessionAutoTier | null;
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
  autoTier = null,
  failed,
  onOpen,
  onChoose,
  emptyLabel = 'No model recorded',
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  /** The row under the pointer, so its price can be read without committing to it. */
  const [hovered, setHovered] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

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
        title="Change the model, reasoning effort and context size"
      >
        {/* Named even before the catalogue is known: this comes from the session's own log,
            so a session says what it runs on without being started. While that read is in
            flight the control holds its shape rather than showing a name that may turn out
            to be wrong - blanking the text alone collapsed it to an empty blob. */}
        {current === undefined ? (
          <span className="model-id waiting" aria-label="Loading model" />
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
        {/* Says the control opens something, which a row of facts otherwise does not. */}
        <ChevronIcon open={open} />
      </button>

      {open && (
        <FloatingMenu
          anchor={box}
          onDismiss={close}
          className="model-menu"
          role="listbox"
          onMouseLeave={() => setHovered(null)}
        >
          {failed && <p className="error">{failed}</p>}
          {!models && !failed && <p className="model-loading">Starting the runtime to ask what is available.</p>}

          {models && models.length > 0 && <Prices model={described} />}
          {models?.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              current={current}
              autoTier={autoTier}
              onChoose={onChoose}
              onDone={close}
              onLookAt={() => setHovered(model.id)}
            />
          ))}
        </FloatingMenu>
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
 *
 * Always drawn, and always the same height, whatever it has to say. Everything it can show
 * is a different number of lines - three prices, one line saying there are none, or nothing
 * at all before the pointer has been anywhere - and the list sits directly underneath, so a
 * block that grew and shrank would shunt the rows out from under the pointer that moved it.
 */
function Prices({ model }: { model: ModelChoice | undefined }) {
  const rows: ReadonlyArray<[string, number | undefined]> = [
    ['Input', model?.prices?.input],
    ['Cached input', model?.prices?.cachedInput],
    ['Output', model?.prices?.output],
  ];
  const known = rows.filter(([, amount]) => amount !== undefined);

  return (
    <div className="model-prices">
      <p className="model-prices-head">
        Cost per 1M tokens{model && <span className="model-prices-of"> · {model.name}</span>}
      </p>

      {/* Auto has no price of its own: what it costs depends on where it routes. */}
      {known.length === 0 && (
        <p className="model-price wide">{model ? 'No price listed' : 'Hover a model to see its price'}</p>
      )}

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
 */
function ModelRow({
  model,
  current,
  autoTier,
  onChoose,
  onDone,
  onLookAt,
}: {
  model: ModelChoice;
  current: SessionModel | null | undefined;
  autoTier: SessionAutoTier | null;
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
  /**
   * Which way auto should route, starting from whatever the session asked for last.
   *
   * A pending request beats the preference in force, because it is the newer of the two and
   * the one the reader made: showing the old one under a request they have already given
   * would read as the request having been ignored.
   */
  const [routing, setRouting] = useState<AutoTier | undefined>(
    () => autoTier?.pending ?? autoTier?.current ?? undefined,
  );

  /** Everything the row holds, with whichever part has just been touched replacing its own. */
  const held = (change: Partial<ModelChoiceMade>): ModelChoiceMade => ({
    model: model.id,
    reasoningEffort: effort,
    contextTier: tier,
    ...(model.id === 'auto' && routing ? { autoTier: routing } : {}),
    ...change,
  });

  /**
   * Keep a part of the row, and commit it where the row is the one in use.
   *
   * Touching the effort or the room size of the model already selected is not composing a
   * choice, it is changing the thing in front of you, so it takes effect. On any other row
   * the same click is one part of a choice not yet made, and is held until the reader says
   * which model it belongs to.
   *
   * The menu stays open either way: a reader adjusting one of these often adjusts the other,
   * and closing after the first would make the second a second trip.
   */
  const keep = (change: Partial<ModelChoiceMade>) => {
    if (chosen) onChoose(held(change));
  };

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
          // Sent with whatever the row holds. The routing preference rides along only on
          // auto, which is the only model the runtime accepts one against.
          onChoose(held({}));
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
              onClick={() => {
                setEffort(level);
                keep({ reasoningEffort: level });
              }}
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
              onClick={() => {
                setTier(context.tier);
                keep({ contextTier: context.tier });
              }}
              aria-label={`${model.name} with ${tokens(context.maxPromptTokens)} of context`}
            >
              {tokens(context.maxPromptTokens)}
            </button>
          ))}
        </div>
      )}

      {/* Only on auto, which is the only model the runtime accepts a routing preference
          against, and only where there is a session to ask: the tier is in no log, so a
          cold one has nothing to say and is not worth starting to find out (#215). */}
      {model.id === 'auto' && (
        <div className="model-line">
          <span className="model-line-label">Routing</span>
          {AUTO_TIERS.map((level) => (
            <button
              type="button"
              key={level}
              className={routing === level ? 'model-option chosen' : 'model-option'}
              aria-pressed={routing === level}
              onClick={() => {
                setRouting(level);
                keep({ autoTier: level });
              }}
              aria-label={`Auto routing for ${level}`}
            >
              {level}
            </button>
          ))}
          {/* Said rather than drawn as done. The runtime records this one and commits it on a
              later turn that uses auto, so until that turn it is a request. */}
          {autoTier?.pending !== undefined && <span className="model-note">waiting for the next prompt</span>}
        </div>
      )}
    </div>
  );
}
