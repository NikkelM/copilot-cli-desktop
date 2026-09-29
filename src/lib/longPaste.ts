/**
 * What to do with a paste too long to sit in the box (#55).
 *
 * Pasting four hundred lines into the composer leaves the thing you are writing somewhere
 * inside four hundred lines. The CLI collapses a long paste to a placeholder and puts the
 * text back when the message is sent, so the box stays a box; this is the same bargain,
 * with the same words, so a line means the same thing in both.
 *
 * Kept apart from the composer because it is all rules and no drawing: what counts as long,
 * what the placeholder says, and how to find it again. The composer decides when to ask.
 */

/**
 * Lines before a paste is collapsed, matching the CLI's own `ioo = 10`.
 *
 * Ten rather than one because a short paste is not in the way - a few lines of code or a
 * stack trace reads perfectly well in the box, and hiding it behind a placeholder would be
 * taking something away for nothing.
 */
export const COLLAPSE_OVER_LINES = 10;

/**
 * Bytes before a paste is written to a file instead of held in memory.
 *
 * Hidden or not, a placeholder still has the whole paste behind it, and a message carries
 * what it stands for. Past a certain size that is no longer a message - it is a document,
 * and a document is better as a file the agent can read than as a wall of prompt.
 *
 * The CLI's own number, read from the runtime it asks rather than guessed: the native
 * module exports `largeOutputDefaultThreshold()`, which returns 20480, and the CLI writes a
 * paste to a file when its UTF-8 length is over that. Bytes rather than lines, so what
 * counts is what the message would carry.
 */
export const WRITE_TO_FILE_OVER_BYTES = 20 * 1024;

/** A paste being held out of the box, and what it would read as if put back. */
export interface HeldPaste {
  /** The full text, put back when the message is sent. */
  text: string;
  lines: number;
  /**
   * Where it was written, once it has been.
   *
   * Set for a paste too large to be a message, and only when the write has landed. Until
   * then the text stands, so a message sent while it is still being written carries what it
   * always carried rather than a reference to a file that is not there yet.
   */
  file?: string;
  /** How large it is, for the reference that names the file. */
  size?: string;
}

/** What stands in the box while the text is held. */
export function placeholder(id: number, lines: number): string {
  return `[Paste #${id} - ${lines} lines]`;
}

/**
 * The placeholder shape, as the CLI writes it.
 *
 * The line count is optional because the CLI's own pattern allows a placeholder without
 * one, and a pattern that insists on it would fail to find one the CLI wrote.
 */
const HELD = /\[Paste #(\d+)(?: - \d+ lines)?\]/g;

/**
 * The placeholder for a paste that went to a file, which is the CLI's pattern exactly.
 *
 * A second form rather than a flag on the first, because the box says which one a paste is:
 * naming it by its length once it has a file would describe it as the thing it stopped
 * being.
 */
const SAVED = /\[Saved pasted content to workspace \([^)]+\) id=(\d+)\]/g;

/**
 * Who a restored paste is for.
 *
 * Only matters for one written to a file: 'sent' names the file so the agent can read it,
 * 'shown' says one is there without dragging it into the conversation.
 */
export type PasteForm = 'sent' | 'shown';

/** Whether a paste is long enough to be worth collapsing. */
export function worthCollapsing(text: string): boolean {
  return countLines(text) > COLLAPSE_OVER_LINES;
}

/** Whether a paste is large enough to belong in a file rather than a message. */
export function worthWriting(text: string): boolean {
  // The bytes it will occupy rather than its length: the threshold is about what is being
  // carried, and a character outside ASCII carries more than one byte of it.
  return new TextEncoder().encode(text).length > WRITE_TO_FILE_OVER_BYTES;
}

/** How many lines a paste has, counting the way somebody looking at it would. */
export function countLines(text: string): number {
  return text.split('\n').length;
}

/**
 * Put every held paste back into the text that stands for it.
 *
 * Two forms, because the agent and the reader want opposite things from a paste written to
 * a file. The agent gets a reference naming the file, which is the point of having written
 * it. The reader gets a label saying one is there: the file was written because it is too
 * big to read in a message, and it is no smaller in the conversation.
 *
 * A reader's form must also survive being rendered. The reference is a tag, and an unknown
 * tag is not merely dropped by the sanitiser - it swallows everything after it, so showing
 * one would cut the message off at the paste.
 *
 * One still being written puts its text back whichever form is asked for, since a reference
 * to a file that does not exist yet would be worse than the paste itself.
 *
 * A placeholder nobody is holding is left exactly as it was. That covers two cases at once:
 * text somebody typed that happens to look like one, and a placeholder surviving from a
 * session whose pastes this no longer has - and leaving it alone is right for both, since
 * inventing a paste would be worse than sending the line as written.
 */
export function restore(text: string, held: ReadonlyMap<number, HeldPaste>, as: PasteForm): string {
  const named = text.replace(HELD, (whole, id: string) => {
    const paste = held.get(Number(id));
    if (!paste) return whole;
    if (!paste.file) return paste.text;

    return as === 'sent' ? reference(paste.file, paste.size ?? '', paste.lines) : written(Number(id), paste.size ?? '');
  });

  // The box says a paste went to a file, so this is already the reader's form and only the
  // agent's has to be made.
  if (as === 'shown') return named;

  return named.replace(SAVED, (whole, id: string) => {
    const paste = held.get(Number(id));
    if (!paste) return whole;

    // The label goes into the box as the paste lands, so it can be sent before the file
    // exists. The text is what it stood for until then.
    return paste.file ? reference(paste.file, paste.size ?? '', paste.lines) : paste.text;
  });
}

/**
 * Which pastes a piece of text is standing in for.
 *
 * Read from the text rather than tracked alongside it, because the text is what the reader
 * edited: a placeholder they deleted before sending is no longer carried by the message,
 * and one they never typed is not either.
 *
 * Both forms, since a paste that went to a file is named by the file from then on and would
 * otherwise be held for as long as the session lasted.
 */
export function idsIn(text: string): number[] {
  return [...text.matchAll(HELD), ...text.matchAll(SAVED)].map(([, id]) => Number(id));
}

/**
 * Turn a placeholder for a written paste into the reference the agent reads.
 *
 * The CLI's own shape, so a model that has seen one before knows what it is looking at. The
 * file is named rather than quoted: the point of writing it down was not to send it.
 */
export function reference(file: string, size: string, lines: number): string {
  return `<pasted_content file="${escape(file)}" size="${escape(size)}" lines="${lines}" />`;
}

/**
 * What the conversation shows in place of a paste that was written to a file.
 *
 * The CLI's wording, and deliberately not a tag: this goes through a markdown renderer that
 * drops tags it does not know along with everything following them.
 */
export function written(id: number, size: string): string {
  return `[Saved pasted content to workspace (${size}) id=${id}]`;
}

/** The attribute-safe form of a value going into the reference tag. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A size somebody would read, for the placeholder that stands in for a written paste. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
