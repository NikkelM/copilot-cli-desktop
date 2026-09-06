import { useEffect, useRef, useState } from 'react';

import { credits, tokens } from '../lib/units';
import type { ContextTier, ModelChoice, ReasoningEffort, SessionModel } from '../../shared/protocol';

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
  /** Why the catalogue could not be fetched, if it could not. */
  failed: string | null;
  /** Refresh the catalogue. Costs a running server, so it waits for the picker to open. */
  onOpen: () => void;
  onChoose: (choice: ModelChoiceMade) => void;
}

/**
 * Which model a session runs on, how hard it is asked to think, and how much room it has.
 *
 * All three read as one setting, so the closed control shows all three and the menu offers
 * all three: changing the effort should not mean finding the model again.
 */
export function ModelPicker({ current, models, failed, onOpen, onChoose }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
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
    // Asking costs a server process, so it waits for someone to actually want the list.
    onOpen();
  }

  const effort = current?.reasoningEffort && current.reasoningEffort !== 'none' ? current.reasoningEffort : null;
  const active = models?.find((model) => model.id === current?.model);
  // Named by size rather than by tier, since the size is the whole difference between them.
  const room = active?.contexts.find((context) => context.tier === (current?.contextTier ?? 'default'));

  return (
    <div className="model" ref={box}>
      <button
        type="button"
        className="model-current"
        onClick={toggle}
        title="Change the model, how hard it thinks, and how much room it has"
      >
        {/* Named even before the catalogue is known: this comes from the session's own log,
            so a session says what it runs on without being started. Blank rather than
            "nothing recorded" until that read comes back, so switching sessions does not
            flash a claim that turns out to be false. */}
        <span className="model-id">{current === undefined ? '' : (current?.model ?? 'No model recorded')}</span>
        {effort && <span className="model-tag">{effort}</span>}
        {/* Only once the catalogue is known, since the size is not in the session's log. */}
        {room && <span className="model-tag">{tokens(room.maxPromptTokens)}</span>}
      </button>

      {open && (
        <div className="model-menu" role="listbox">
          {failed && <p className="error">{failed}</p>}
          {!models && !failed && <p className="model-loading">Starting the runtime to ask what is available.</p>}

          {active?.prices && <Prices prices={active.prices} />}

          {models?.map((model) => (
            <ModelRow key={model.id} model={model} current={current} onChoose={onChoose} onDone={() => setOpen(false)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What a million tokens costs on the model in use.
 *
 * Shown for that model alone rather than on every row: it is the one a reader is spending
 * on, and twenty-one price tables would bury the list they came for.
 */
function Prices({ prices }: { prices: NonNullable<ModelChoice['prices']> }) {
  const rows: ReadonlyArray<[string, number | undefined]> = [
    ['Input', prices.input],
    ['Cached input', prices.cachedInput],
    ['Output', prices.output],
  ];
  const known = rows.filter(([, amount]) => amount !== undefined);
  if (known.length === 0) return null;

  return (
    <div className="model-prices">
      <p className="model-prices-head">Cost per 1M tokens</p>
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
  onChoose,
  onDone,
}: {
  model: ModelChoice;
  current: SessionModel | null | undefined;
  onChoose: (choice: ModelChoiceMade) => void;
  onDone: () => void;
}) {
  const chosen = current?.model === model.id;

  // Starts from what this model is already running with, so opening the menu and clicking
  // the name changes nothing. Held per row, and forgotten when the menu closes, because a
  // half-made choice on a model that was not committed to means nothing later.
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(
    chosen ? (current?.reasoningEffort as ReasoningEffort | undefined) : undefined,
  );
  const [tier, setTier] = useState<ContextTier>(chosen ? ((current?.contextTier as ContextTier) ?? 'default') : 'default');

  return (
    <div className={chosen ? 'model-row chosen' : 'model-row'}>
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
