import { useEffect } from 'react';

import { BINDINGS } from '../lib/useShortcuts';

/**
 * The shortcuts there are, since nothing else says.
 *
 * The CLI keeps its own list a keypress away and this app has no status line to hint in, so
 * without this the shortcuts would only be found by someone who already knew them. Built
 * from the bindings themselves, so it cannot describe a key that does nothing.
 */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Claimed, so the same press does not also reach the shortcut that stops a turn.
      event.preventDefault();
      onClose();
    };

    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  return (
    <div className="sheet" role="dialog" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="sheet-body" onClick={(event) => event.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          {BINDINGS.map((binding) => (
            <div className="shortcut" key={binding.id}>
              <dt>
                <kbd>{binding.keys}</kbd>
              </dt>
              <dd>{binding.what}</dd>
            </div>
          ))}
        </dl>
        <p className="shortcut-note">Esc to close.</p>
      </div>
    </div>
  );
}
