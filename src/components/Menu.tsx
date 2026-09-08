import { useEffect, useRef } from 'react';

/** One row: a name, and what it does. */
export interface MenuItem {
  id: string;
  /** The name, shown in monospace on the left. */
  label: string;
  description: string;
}

/** Keys that are the start of a combination rather than input in their own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock']);

interface MenuProps {
  items: MenuItem[];
  /** Which row is under the cursor, owned by the caller so typing can reset it. */
  selected: number;
  onSelect: (index: number) => void;
  /**
   * Absent for a list that is only a reference, such as the shortcuts.
   *
   * Told which key was used, because the two mean different things where a menu completes
   * something being typed: Tab finishes the word and leaves the cursor in the box, Enter
   * finishes it and acts. Clicking is the mouse saying Enter.
   */
  onChoose?: (item: MenuItem, key: 'Tab' | 'Enter') => void;
  onDismiss: () => void;
  /**
   * Close on any key at all, as the CLI's own help does.
   *
   * Right for a reference list: it is read, and then dismissed by carrying on with whatever
   * you were doing. Wrong for a list being filtered, where typing is how it is narrowed.
   */
  dismissOnAnyKey?: boolean;
  label: string;
}

/**
 * A list that opens above the composer and is driven entirely from the keyboard.
 *
 * Modelled on the CLI, which puts its command list here rather than in a dialogue: the
 * reader is already typing, so the answer belongs next to what they are typing and not over
 * the top of it. A popup would also take the keyboard away and hand it back, which is what
 * the shortcuts list used to do.
 *
 * The caller owns the selected index because typing changes the list underneath it - a menu
 * that kept its own would leave the cursor on a row that had moved or gone.
 */
export function Menu({
  items,
  selected,
  onSelect,
  onChoose,
  onDismiss,
  dismissOnAnyKey,
  label,
}: MenuProps) {
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
          // A reference list closes on anything, which is how the CLI's help behaves - it is
          // read and then dismissed by carrying on. Checked before navigation, so nothing is
          // quietly exempt from "anything".
          //
          // Except a modifier held on its own: pressing Ctrl is the start of a combination, not
          // carrying on, and the CLI leaves its help open for it. Not prevented either, so the
          // key that closes the list still does whatever it normally would.
          if (dismissOnAnyKey) {
            if (!MODIFIERS.has(event.key)) onDismiss();
            return;
          }

          const move = (to: number) => {
            event.preventDefault();
            // Wraps, because a list this short is quicker to reach round the end than back
            // through the middle.
            onSelect((to + items.length) % items.length);
          };

          switch (event.key) {
            case 'ArrowDown':
              return move(selected + 1);
            case 'ArrowUp':
              return move(selected - 1);
            case 'Home':
              return move(0);
            case 'End':
              return move(items.length - 1);
            case 'Escape':
              // Claimed, so the same press does not also reach the shortcut that stops a turn.
              event.preventDefault();
              return onDismiss();
            case 'Tab':
            case 'Enter': {
              const item = items[selected];
              if (!onChoose || !item) return;
              event.preventDefault();
              return onChoose(item, event.key);
            }
            default:
              return;
          }
    }

    // Capturing, so the composer does not act on a key meant for the menu - Enter would
    // otherwise send the message the menu was opened to help write.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [items, selected, onSelect, onChoose, onDismiss, dismissOnAnyKey]);

  // Keeps the cursor in view when it is moved past either end of what is scrolled to.
  // Guarded because jsdom does not implement scrollIntoView, and a reference list has no
  // business failing to render because it could not scroll.
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  if (items.length === 0) return null;

  return (
    <ul className="menu" ref={list} role="listbox" aria-label={label}>
      {items.map((item, index) => (
        <li
          key={item.id}
          role="option"
          aria-selected={index === selected}
          className={index === selected ? 'menu-row selected' : 'menu-row'}
          // Hovering moves the cursor rather than acting, so the pointer and the keyboard
          // agree about which row Enter would take.
          onMouseMove={() => index !== selected && onSelect(index)}
          onClick={() => onChoose?.(item, 'Enter')}
        >
          <span className="menu-label">{item.label}</span>
          <span className="menu-description">{item.description}</span>
        </li>
      ))}
    </ul>
  );
}
