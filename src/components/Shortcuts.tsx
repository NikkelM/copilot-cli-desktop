import { Menu } from './Menu';
import { BINDINGS, type Binding } from '../lib/useShortcuts';
import type { SlashCommand } from '../../shared/protocol';

/** What stands in the keys column for a shortcut somebody turned off. */
const CLEARED = 'not set';

/**
 * The keys there are, and on request everything else there is.
 *
 * The CLI keeps its own list a keypress away and this app has no status line to hint in, so
 * without this they would only be found by someone who already knew them. Built from the
 * bindings themselves, so it cannot describe a key that does nothing.
 *
 * `?` asks for the keys alone, which is what someone reaching for a reminder wants;
 * `/help` passes the commands too, for the reader who wants to know the whole surface at
 * once. Same list, one longer, exactly as the CLI divides its quick help from its full help.
 *
 * Drawn as the same menu the composer uses rather than as a dialogue over the top: a list of
 * keys is the last thing that should take the keyboard away in order to be read.
 *
 * @param bindings the keys as they actually are, which is not the same as the defaults once
 *   a reader has moved one (#246). A list showing what the keys used to be would be worse
 *   than no list.
 */
export function Shortcuts({
  commands,
  onClose,
  bindings = BINDINGS,
}: {
  commands?: SlashCommand[];
  onClose: () => void;
  bindings?: readonly Binding[];
}) {
  const keys = bindings.map((binding) => ({
    // By the id where there is one, since two shortcuts a reader has cleared both show the
    // same empty keys column and a list cannot have two rows under one key.
    id: binding.id ?? binding.keys,
    label: binding.keys || CLEARED,
    description: binding.what,
  }));

  // The quick list names /help so it can be found from `?`, which would say it twice here.
  const named = new Set(bindings.map((binding) => binding.keys));
  const slashes = (commands ?? [])
    .map((command) => ({
      id: `/${command.name}`,
      label: `/${command.name}`,
      description: command.description,
    }))
    .filter((row) => !named.has(row.id));

  return (
    <Menu
      // No onChoose: this is a reference rather than something to pick from, so Enter is
      // left for whatever else wanted it.
      items={[...keys, ...slashes]}
      // No row is current, because there is none to choose. A cursor on a list that cannot
      // be moved through is a control that is not there.
      selected={-1}
      onSelect={() => {}}
      onDismiss={onClose}
      // Read, then dismissed by carrying on with anything - as the CLI's own help behaves.
      dismissOnAnyKey
      columns
      label={commands ? 'Help' : 'Keyboard shortcuts'}
    />
  );
}
