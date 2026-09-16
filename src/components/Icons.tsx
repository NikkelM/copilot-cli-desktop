/**
 * The composer's actions, drawn rather than named.
 *
 * Inline SVG rather than an icon font or a glyph from the text: three shapes is not enough
 * to be worth a dependency, and a character like an arrow renders differently on every
 * machine. Drawn in `currentColor` so each one follows the button it sits in.
 *
 * Every icon is decorative: the button around it carries the name, so a reader who cannot
 * see the shape still hears what it does.
 */
const shared = {
  viewBox: '0 0 16 16',
  width: 16,
  height: 16,
  'aria-hidden': true,
  focusable: 'false',
} as const;

/** Add something to this message. */
export function PlusIcon() {
  return (
    <svg {...shared}>
      <path
        d="M8 3.25v9.5M3.25 8h9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Stop the turn that is running. */
export function StopIcon() {
  return (
    <svg {...shared}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** Send what is written, or queue it behind the turn. */
export function SendIcon() {
  return (
    <svg {...shared}>
      <path
        d="M8 13V3.5M8 3.5 3.75 7.75M8 3.5l4.25 4.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Whether something folded away is open, which is the one icon here that is also a state.
 *
 * One shape turned rather than two glyphs, so the two states cannot drift apart and the
 * move between them can be shown. Drawn rather than typed because a text triangle is
 * whatever size the font decides a small triangle is - a few pixels across at the sizes
 * these rows set - and it sits on a baseline rather than in the middle of its row (#177).
 */
export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg {...shared} className="caret" data-open={open}>
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
