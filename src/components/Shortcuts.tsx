import { useState } from 'react';

import { Menu } from './Menu';
import { BINDINGS } from '../lib/useShortcuts';

/**
 * The shortcuts there are, since nothing else says.
 *
 * The CLI keeps its own list a keypress away and this app has no status line to hint in, so
 * without this the shortcuts would only be found by someone who already knew them. Built
 * from the bindings themselves, so it cannot describe a key that does nothing.
 *
 * Drawn as the same menu the composer uses rather than as a dialogue over the top: a list of
 * keys is the last thing that should take the keyboard away in order to be read.
 */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState(0);

  return (
    <Menu
      // No onChoose: this is a reference rather than something to pick from, so Enter is
      // left for whatever else wanted it.
      items={BINDINGS.map((binding) => ({
        id: binding.id,
        label: binding.keys,
        description: binding.what,
      }))}
      selected={selected}
      onSelect={setSelected}
      onDismiss={onClose}
      // Read, then dismissed by carrying on with anything - as the CLI's own help behaves.
      dismissOnAnyKey
      label="Keyboard shortcuts"
    />
  );
}
