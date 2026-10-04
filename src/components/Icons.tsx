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

/**
 * Settings. A cogwheel: eight teeth around a hollow rim, which is the shape everyone
 * already reads as settings.
 *
 * The outline is generated rather than drawn by hand - alternating arcs at the tooth tips
 * and the roots between them - so the teeth are evenly spaced instead of nearly so.
 */
export function GearIcon() {
  return (
    <svg {...shared}>
      <path
        d="M6.88 1.6A6.5 6.5 0 0 1 9.12 1.6L9.14 3.24A4.9 4.9 0 0 1 10.56 3.82L11.74 2.68A6.5 6.5 0 0 1 13.32 4.26L12.18 5.44A4.9 4.9 0 0 1 12.76 6.86L14.4 6.88A6.5 6.5 0 0 1 14.4 9.12L12.76 9.14A4.9 4.9 0 0 1 12.18 10.56L13.32 11.74A6.5 6.5 0 0 1 11.74 13.32L10.56 12.18A4.9 4.9 0 0 1 9.14 12.76L9.12 14.4A6.5 6.5 0 0 1 6.88 14.4L6.86 12.76A4.9 4.9 0 0 1 5.44 12.18L4.26 13.32A6.5 6.5 0 0 1 2.68 11.74L3.82 10.56A4.9 4.9 0 0 1 3.24 9.14L1.6 9.12A6.5 6.5 0 0 1 1.6 6.88L3.24 6.86A4.9 4.9 0 0 1 3.82 5.44L2.68 4.26A6.5 6.5 0 0 1 4.26 2.68L5.44 3.82A4.9 4.9 0 0 1 6.86 3.24Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.15" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

/** A tick, for a box that has been ticked. Stroked like the rest so it scales with the box. */
export function TickIcon() {
  return (
    <svg {...shared} className="tick">
      <path
        d="M3.5 8.4 6.4 11.3 12.5 4.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Close. An X, drawn rather than taken from the text, like the rest of these. */
export function CloseIcon() {
  return (
    <svg {...shared}>
      <path
        d="M4 4 12 12M12 4 4 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A folder, for the control that opens one. */
export function FolderIcon() {
  return (
    <svg {...shared}>
      <path
        d="M1.9 4.1A1 1 0 0 1 2.9 3.1h2.9l1.3 1.6h4.9a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A notebook, for the pages a repository already has in the wiki (#35).
 *
 * Drawn rather than written as a character. The glyph it replaces carried its own font
 * metrics into a row whose text had different ones, so centring the two boxes left the
 * mark sitting visibly above the words beside it.
 */
export function NotesIcon() {
  return (
    <svg {...shared}>
      <rect
        x="2.75"
        y="2.75"
        width="10.5"
        height="10.5"
        rx="1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path d="M6.25 2.75V13.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}
