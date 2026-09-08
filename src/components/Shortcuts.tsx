import { Menu } from './Menu';
import { BINDINGS } from '../lib/useShortcuts';

/**
 * The keys there are, since nothing else says.
 *
 * The CLI keeps its own list a keypress away and this app has no status line to hint in, so
 * without this they would only be found by someone who already knew them. Built from the
 * bindings themselves, so it cannot describe a key that does nothing.
 *
 * Drawn as the same menu the composer uses rather than as a dialogue over the top: a list of
 * keys is the last thing that should take the keyboard away in order to be read.
 */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Menu
      // No onChoose: this is a reference rather than something to pick from, so Enter is
      // left for whatever else wanted it.
      items={BINDINGS.map((binding) => ({
        // Keyed by the keys themselves: most bindings belong to the composer or the menu
        // rather than to the shortcut hook, so there is no id to key them by.
        id: binding.keys,
        label: binding.keys,
        description: binding.what,
      }))}
      // No row is current, because there is none to choose. A cursor on a list that cannot
      // be moved through is a control that is not there.
      selected={-1}
      onSelect={() => {}}
      onDismiss={onClose}
      // Read, then dismissed by carrying on with anything - as the CLI's own help behaves.
      dismissOnAnyKey
      columns
      label="Keyboard shortcuts"
    />
  );
}
