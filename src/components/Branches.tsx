import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ChevronIcon } from './Icons';
import { step } from '../lib/roving';

/**
 * How many changed files a switch would carry across, said rather than warned about.
 *
 * Uncommitted work comes along - that is git's behaviour, not a decision made here - so the
 * picker states it. A warning implies something might go wrong, and nothing does: git
 * carries the changes over, or refuses and leaves everything where it was. What the reader
 * needs is to know where their work will be, not to be alarmed.
 */
export function carryNote(dirty: number): string | null {
  if (dirty < 1) return null;
  return dirty === 1 ? '1 changed file carries over' : `${dirty} changed files carry over`;
}

/**
 * Choosing a branch, or starting one.
 *
 * Both places that reach this show the branch differently - the panel names it plainly, the
 * header dresses it as an aside to the path - so the trigger's face is the caller's to
 * decide and only what drops out of it is shared. #102 asked for the indicator to be the
 * place branches are reached from and said the second site should use the first's picker
 * rather than growing a copy of it, which is what this is.
 */
export function Branches({
  branch,
  label,
  className = 'repo-branch-button',
  title,
  note,
  branches,
  reading = false,
  switching,
  disabled,
  disabledReason,
  onOpen,
  onSwitch,
}: {
  /** The branch being stood on, for the name a screen reader reads out. */
  branch: string;
  /** What the trigger shows, when the plain name is not it. */
  label?: ReactNode;
  className?: string;
  title?: string;
  /** What a switch would carry across, or null when there is nothing to carry. */
  note?: string | null;
  branches: { name: string; current: boolean }[];
  /** Whether that list is still being read, so an empty menu can say which empty it is. */
  reading?: boolean;
  switching: boolean;
  /** Set while the agent is working, when switching underneath it would produce a diff nobody could explain. */
  disabled?: boolean;
  disabledReason?: string;
  onOpen: () => void;
  onSwitch: (name: string, create: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState('');
  const shut = disabled || switching;
  const held = useRef<HTMLSpanElement>(null);

  const close = () => {
    setOpen(false);
    setNaming('');
  };

  /**
   * Clicking away, or pressing escape, puts it away.
   *
   * The panel this started in could be closed to be rid of the menu. The header indicator
   * cannot, so a menu left open would sit over the transcript until something was chosen -
   * and the reader who opened it to look rather than to switch has nothing to choose.
   */
  useEffect(() => {
    if (!open) return;

    const away = (event: PointerEvent) => {
      if (!held.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <span
      className="repo-branches"
      ref={held}
      // A menu, which is where a reader reaches for an arrow hardest of all. Held here
      // rather than on the menu itself so that the first press counts: the keyboard is still
      // on the control that opened it, which is beside the menu rather than inside it.
      onKeyDown={(event) => {
        const by =
          event.key === 'ArrowDown'
            ? 1
            : event.key === 'ArrowUp'
              ? -1
              : event.key === 'Home'
                ? 'first'
                : event.key === 'End'
                  ? 'last'
                  : null;
        if (by === null) return;
        // The box that starts a branch is part of the menu rather than something after it:
        // starting one is the other half of what this is for, so the arrows reach it. Named
        // by where it sits rather than given the branches' own class, which would dress a
        // text box as one of them.
        if (step(held.current, '.repo-branch-item, .repo-branch-new input', by)) event.preventDefault();
      }}
    >
      <button
        type="button"
        className={className}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
        disabled={shut}
        aria-expanded={open && !shut}
        aria-label={`Switch branch, on ${branch}`}
        title={disabled ? disabledReason : title}
      >
        {label ?? branch}
        <ChevronIcon open={open && !shut} />
      </button>

      {open && !shut && (
        <div className="repo-branch-menu">
          {note && <p className="repo-branch-note">{note}</p>}

          {/* An empty list means two things and only one is worth a menu: not read yet, and
              read and found nothing. The second barely happens - a repository always has the
              branch you are standing on - so an empty gap is nearly always the first (#224). */}
          {reading && branches.length === 0 ? (
            <p className="repo-branch-note">Reading the branches.</p>
          ) : (
            <ul>
              {branches.map((each) => (
                <li key={each.name}>
                  <button
                    type="button"
                    className={each.current ? 'repo-branch-item current' : 'repo-branch-item'}
                    onClick={() => {
                      if (!each.current) onSwitch(each.name, false);
                      close();
                    }}
                  >
                    {each.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="repo-branch-new"
            onSubmit={(event) => {
              event.preventDefault();
              if (!naming.trim()) return;
              onSwitch(naming, true);
              close();
            }}
          >
            <input
              value={naming}
              onChange={(event) => setNaming(event.target.value)}
              placeholder="New branch"
              aria-label="New branch name"
            />
            <button type="submit" className="changes-action" disabled={!naming.trim()}>
              Create
            </button>
          </form>
        </div>
      )}
    </span>
  );
}
