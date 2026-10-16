import { useRef, useState } from 'react';
import { ChevronIcon, TickIcon } from './Icons';
import { FloatingMenu } from './FloatingMenu';

export function Dropdown<T extends string>({
  id, label, value, options, onChange, disabled = false, variant = 'field',
}: {
  id?: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  variant?: 'field' | 'compact';
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = `${id ?? label.replace(/\W/g, '-')}-options`;
  const close = () => {
    setOpen(false);
    anchor.current?.focus();
  };
  const expand = () => {
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  return (
    <>
      <button
        id={id}
        ref={anchor}
        type="button"
        role="combobox"
        className={`app-dropdown ${variant}${open ? ' open' : ''}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => open ? close() : expand()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            expand();
          }
        }}
      >
        {options.find((option) => option.value === value)?.label ?? 'Choose...'}
        <ChevronIcon open={open} />
      </button>
      {open && (
        <FloatingMenu anchor={anchor} onDismiss={close} className={`app-dropdown-menu ${variant}`} role="listbox"
          id={listId} aria-label={label}>
          <div ref={menu}>
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`app-dropdown-option${option.value === value ? ' chosen' : ''}`}
                autoFocus={index === active}
                tabIndex={index === active ? 0 : -1}
                onClick={() => { onChange(option.value); close(); }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                    return;
                  }
                  if (event.key === 'Tab') { setOpen(false); return; }
                  let next = index;
                  if (event.key === 'ArrowDown') next = (index + 1) % options.length;
                  else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = options.length - 1;
                  else if (event.key.length === 1 && event.key !== ' ') {
                    const ordered = [...options.slice(index + 1), ...options.slice(0, index + 1)];
                    const match = ordered.find((each) => each.label.toLowerCase().startsWith(event.key.toLowerCase()));
                    if (!match) return;
                    next = options.indexOf(match);
                  } else return;
                  event.preventDefault();
                  setActive(next);
                  menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
                }}
              >
                <span className="app-dropdown-tick">{option.value === value && <TickIcon />}</span>
                {option.label}
              </button>
            ))}
          </div>
        </FloatingMenu>
      )}
    </>
  );
}
