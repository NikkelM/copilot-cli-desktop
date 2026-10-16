import { useCallback, useRef, useState } from 'react';

import { type HeldPaste, idsIn, type PasteForm, placeholder, restore, written } from './longPaste';

/**
 * How many pastes one session may hold behind placeholders at once.
 *
 * A backstop rather than the usual limit: a sent message lets go of the pastes it carried,
 * so this is only reached by piling many long pastes into one message never sent. Anything
 * past it drops the oldest, whose placeholder is then sent as written - visibly, since the
 * placeholder names itself, rather than as an empty gap.
 */
const PASTES_KEPT = 32;

/** What one session is holding out of its box. */
interface SessionPastes {
  held: Map<number, HeldPaste>;
  /** Never reused within a session, so an older placeholder cannot claim a newer paste. */
  next: number;
}

const nothing = (): SessionPastes => ({ held: new Map(), next: 1 });

/**
 * Unsent text, per session, and the one prompt each may have set aside.
 *
 * Two records rather than one because they are two states of the same writing, and every
 * operation moves text between them. Held together for that reason: a stash that lived
 * apart from the drafts it swaps with would need both to be passed around anyway.
 *
 * The pastes held out of the box live here too, for the same reason: a placeholder in a
 * draft means nothing without the text behind it, so the two travel together or not at all.
 *
 * Per session throughout. A draft kept in the composer would follow the reader to whichever
 * session they opened next and be sent there instead, which is #83.
 */
export function useDrafts() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [stash, setStash] = useState<Record<string, string>>({});
  const pastes = useRef<Record<string, SessionPastes>>({});

  // Read by handlers registered once, which would otherwise hold the first render's answer.
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  const stashNow = useRef(stash);
  stashNow.current = stash;

  /** Replace what a session has written but not sent. */
  const write = useCallback((sessionId: string, text: string) => {
    setDrafts((current) => ({ ...current, [sessionId]: text }));
  }, []);

  /**
   * Offer text only if the box is empty.
   *
   * Used to hand a failed message back. Anything typed since wins: taking that away to
   * restore an older draft would be the worse theft.
   */
  const suggest = useCallback((sessionId: string, text: string) => {
    setDrafts((current) => (current[sessionId] ? current : { ...current, [sessionId]: text }));
  }, []);

  /**
   * Trade the box with the session's one stash slot.
   *
   * A swap rather than a push, because with one slot stashing over something already
   * stashed would throw it away - and a key whose job is not to lose writing has no
   * business losing any. So an empty box pops, a full one stashes, and both full trade.
   */
  const swap = useCallback((sessionId: string) => {
    const box = draftsNow.current[sessionId] ?? '';
    const held = stashNow.current[sessionId] ?? '';
    if (!box && !held) return;

    setDrafts((current) => ({ ...current, [sessionId]: held }));
    setStash((current) => ({ ...current, [sessionId]: box }));
  }, []);

  /**
   * Hold a long paste out of the box, answering with what stands in its place.
   *
   * A ref rather than state: nothing draws these, and the placeholder that does goes into
   * the draft, which is state already. Putting them in state as well would redraw the
   * composer for a change nothing can see.
   */
  const hold = useCallback((sessionId: string, text: string, lines: number, size?: string): number => {
    const mine = (pastes.current[sessionId] ??= nothing());
    const id = mine.next++;

    mine.held.set(id, { text, lines, size });
    drop(mine);
    return id;
  }, []);

  /**
   * Say where a held paste was written, once it has been.
   *
   * The box already says a file is where this went - it said so as the paste landed, since
   * everything it needed to say it was known then. What arrives here is the path, which is
   * for the agent rather than the reader, so nothing on screen changes.
   *
   * The text goes as the file arrives. Putting the paste back names the file from here on,
   * so keeping the text would hold megabytes nothing can reach - and the file outlives this
   * app, which the text does not, so a send that fails can still be retried from it.
   */
  const wroteTo = useCallback((sessionId: string, id: number, file: string, size: string) => {
    const paste = pastes.current[sessionId]?.held.get(id);
    if (!paste) return;

    paste.file = file;
    paste.size = size;
    paste.text = '';
  }, []);

  /**
   * Take back what the box said about a paste that never reached a file.
   *
   * The box named it as saved on the way in, which is a promise rather than a report, and
   * this is the rare case where it turns out to have been wrong. The paste is still held, so
   * the message still carries it - only the label was mistaken, and it goes back to naming
   * the paste by its length.
   *
   * Only the label, and only if it is still there: anything typed since is somebody's.
   */
  const writeFailed = useCallback(
    (sessionId: string, id: number) => {
      const paste = pastes.current[sessionId]?.held.get(id);
      if (!paste || paste.file) return;

      const claimed = written(id, paste.size ?? '');
      const draft = draftsNow.current[sessionId] ?? '';
      // Split rather than replace: the label is full of characters a pattern would read as
      // instructions.
      if (draft.includes(claimed)) write(sessionId, draft.split(claimed).join(placeholder(id, paste.lines)));
    },
    [write],
  );

  /** Put every paste this session is holding back into a message, for the agent or the reader. */
  const expand = useCallback((sessionId: string, text: string, as: PasteForm): string => {
    const mine = pastes.current[sessionId];
    return mine ? restore(text, mine.held, as) : text;
  }, []);

  /**
   * Let go of the pastes a message carried, once it has actually gone.
   *
   * After the send rather than during it. A send that fails hands the message back to the
   * box exactly as it was typed, placeholders and all, so letting go any earlier would put
   * back a draft whose placeholders no longer stand for anything.
   */
  const release = useCallback((sessionId: string, text: string) => {
    const mine = pastes.current[sessionId];
    if (!mine) return;

    for (const id of idsIn(text)) mine.held.delete(id);
  }, []);

  return {
    hasUnsent: Object.values(drafts).some(Boolean) || Object.values(stash).some(Boolean),
    /** What is in a session's box, for the composer to show. */
    textOf: (sessionId: string | null) => (sessionId && drafts[sessionId]) || '',
    /** Whether a session has a prompt set aside, which the composer says so it is not invisible. */
    hasStash: (sessionId: string | null) => Boolean(sessionId && stash[sessionId]),
    /** What is in a session's box right now, for a handler that was registered once. */
    written: useCallback((sessionId: string | null) => (sessionId && draftsNow.current[sessionId]) || '', []),
    write,
    clear: useCallback((sessionId: string) => write(sessionId, ''), [write]),
    suggest,
    swap,
    hold,
    wroteTo,
    writeFailed,
    expand,
    release,
  };
}

/**
 * Drop the oldest until a session is within its ceiling.
 *
 * Insertion order, which for these is also the order they were made: a Map keeps it, and
 * the ids only ever count upwards. The placeholder for a dropped paste stays in the draft
 * and is sent as written, which names what was lost rather than leaving a gap.
 */
function drop(mine: SessionPastes): void {
  while (mine.held.size > PASTES_KEPT) {
    const oldest = mine.held.keys().next();
    if (oldest.done) return;
    mine.held.delete(oldest.value);
  }
}
