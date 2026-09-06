import { useEffect, useRef, useState } from 'react';
import type { ContextTier, ModelChoice, ReasoningEffort, SessionModel } from '../../shared/protocol';

/** What to call each context tier, since the runtime's own names are not for reading. */
const TIERS: ReadonlyArray<[ContextTier, string]> = [
  ['default', 'standard context'],
  ['long_context', 'long context'],
];

export interface ModelChoiceMade {
  model: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: ContextTier;
}

interface ModelPickerProps {
  /** What the session runs on now, or null while that is still unknown. */
  current: SessionModel | null;
  /** Asked for only when the picker is opened: listing models costs a running server. */
  onOpen: () => Promise<ModelChoice[]>;
  onChoose: (choice: ModelChoiceMade) => void;
}

/**
 * Which model a session runs on, how hard it is asked to think, and how much room it has.
 *
 * All three read as one setting, so the closed control shows all three and the menu offers
 * all three: changing the effort should not mean finding the model again. The catalogue
 * behind it is only fetched when the list is opened, since asking the runtime for it starts
 * the shared server, and the whole point of this app is that looking at a session is free.
 */
export function ModelPicker({ current, onOpen, onChoose }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
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
    // Fetched once and kept: the catalogue does not change while the app is open, and the
    // wait is the server starting rather than the list being long.
    if (!models) {
      setFailed(null);
      onOpen()
        .then(setModels)
        .catch((e: unknown) => setFailed(String(e)));
    }
  }

  const effort = current?.reasoningEffort && current.reasoningEffort !== 'none' ? current.reasoningEffort : null;
  const long = current?.contextTier === 'long_context';

  return (
    <div className="model" ref={box}>
      <button
        type="button"
        className="model-current"
        onClick={toggle}
        title="Change the model, how hard it thinks, and how much room it has"
      >
        {/* Named even before the catalogue is known: this comes from the session's own log,
            so a session says what it runs on without being started. */}
        <span className="model-id">{current?.model ?? 'No model recorded'}</span>
        {effort && <span className="model-tag">{effort}</span>}
        {long && <span className="model-tag">long context</span>}
      </button>

      {open && (
        <div className="model-menu" role="listbox">
          {failed && <p className="error">{failed}</p>}
          {!models && !failed && <p className="model-loading">Starting the runtime to ask what is available.</p>}

          {models?.map((model) => (
            <ModelRow key={model.id} model={model} current={current} onChoose={onChoose} onDone={() => setOpen(false)} />
          ))}
        </div>
      )}
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
  current: SessionModel | null;
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

      {(model.reasoningEfforts.length > 0 || model.longContext) && (
        <div className="model-options">
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

          {model.longContext &&
            TIERS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={tier === value ? 'model-option chosen' : 'model-option'}
                aria-pressed={tier === value}
                onClick={() => setTier(value)}
                aria-label={`${model.name} with ${label}`}
              >
                {label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
