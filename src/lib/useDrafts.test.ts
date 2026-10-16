// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { placeholder, written } from './longPaste';
import { useDrafts } from './useDrafts';

describe('writing that has not been sent', () => {
  it('reports unsent work in every session and in the stash before an app update', () => {
    const { result } = renderHook(() => useDrafts());
    expect(result.current.hasUnsent).toBe(false);
    act(() => result.current.write('other', 'do not lose this'));
    expect(result.current.hasUnsent).toBe(true);
    act(() => result.current.swap('other'));
    expect(result.current.textOf('other')).toBe('');
    expect(result.current.hasUnsent).toBe(true);
    act(() => result.current.swap('other'));
    act(() => result.current.clear('other'));
    expect(result.current.hasUnsent).toBe(false);
  });

  it('keeps each session\u2019s text to itself, so it cannot be sent to the wrong one', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'meant for one'));
    act(() => result.current.write('s2', 'meant for two'));

    expect(result.current.textOf('s1')).toBe('meant for one');
    expect(result.current.textOf('s2')).toBe('meant for two');
  });

  it('has nothing for a session never written in', () => {
    const { result } = renderHook(() => useDrafts());

    expect(result.current.textOf('s1')).toBe('');
  });

  it('has nothing when no session is selected', () => {
    const { result } = renderHook(() => useDrafts());

    expect(result.current.textOf(null)).toBe('');
    expect(result.current.hasStash(null)).toBe(false);
  });

  it('empties one session without touching another', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'one'));
    act(() => result.current.write('s2', 'two'));
    act(() => result.current.clear('s1'));

    expect(result.current.textOf('s1')).toBe('');
    expect(result.current.textOf('s2')).toBe('two');
  });
});

describe('handing back a message that failed to send', () => {
  it('puts it back when nothing has been typed since', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.suggest('s1', 'the one that failed'));

    expect(result.current.textOf('s1')).toBe('the one that failed');
  });

  /** Taking away what is being written to restore an older draft is the worse theft. */
  it('leaves anything typed in the meantime alone', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'started something else'));
    act(() => result.current.suggest('s1', 'the one that failed'));

    expect(result.current.textOf('s1')).toBe('started something else');
  });
});

describe('setting a prompt aside', () => {
  it('empties the box and remembers what was in it', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'wait your turn'));
    act(() => result.current.swap('s1'));

    expect(result.current.textOf('s1')).toBe('');
    expect(result.current.hasStash('s1')).toBe(true);
  });

  it('brings it back into an empty box', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'wait your turn'));
    act(() => result.current.swap('s1'));
    act(() => result.current.swap('s1'));

    expect(result.current.textOf('s1')).toBe('wait your turn');
    expect(result.current.hasStash('s1')).toBe(false);
  });

  /** The reason it is a swap: with one slot, stashing over a stash would lose writing. */
  it('trades the two rather than losing either', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'first thought'));
    act(() => result.current.swap('s1'));
    act(() => result.current.write('s1', 'second thought'));
    act(() => result.current.swap('s1'));

    expect(result.current.textOf('s1')).toBe('first thought');
    act(() => result.current.swap('s1'));
    expect(result.current.textOf('s1')).toBe('second thought');
  });

  it('does nothing at all when there is nothing on either side', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.swap('s1'));

    expect(result.current.textOf('s1')).toBe('');
    expect(result.current.hasStash('s1')).toBe(false);
  });

  it('is per session, like the box it swaps with', () => {
    const { result } = renderHook(() => useDrafts());

    act(() => result.current.write('s1', 'one'));
    act(() => result.current.swap('s1'));

    expect(result.current.hasStash('s2')).toBe(false);
  });
});

describe('reading the box from a handler registered once', () => {
  it('answers with what is there now, not what was there when it was registered', () => {
    const { result } = renderHook(() => useDrafts());
    const { written } = result.current;

    act(() => result.current.write('s1', 'typed later'));

    expect(written('s1')).toBe('typed later');
  });

  it('has nothing to report without a session', () => {
    const { result } = renderHook(() => useDrafts());

    expect(result.current.written(null)).toBe('');
  });
});

/**
 * Pastes held out of the box (#55).
 *
 * The box shows a placeholder; the message carries the paste. These two only agree because
 * the same session holds both, so what is tested here is mostly that pairing.
 */
describe('holding a paste out of the box', () => {
  it('gives every paste an id of its own, so one placeholder cannot claim another', () => {
    const { result } = renderHook(() => useDrafts());

    const first = result.current.hold('s1', 'a', 1);
    const second = result.current.hold('s1', 'b', 1);

    expect(second).not.toBe(first);
  });

  it('puts the paste back into the message it was taken out of', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'four\nhundred\nlines', 3);

    expect(result.current.expand('s1', `look at [Paste #${id} - 3 lines] please`, 'sent')).toBe(
      'look at four\nhundred\nlines please',
    );
  });

  /** The whole point of the split: one session's paste cannot be sent from another. */
  it('holds each session\u2019s pastes apart, even where their ids agree', () => {
    const { result } = renderHook(() => useDrafts());

    const mine = result.current.hold('s1', 'belongs to one', 1);
    const theirs = result.current.hold('s2', 'belongs to two', 1);

    // Ids count from one in every session, so the same number is two different pastes.
    expect(theirs).toBe(mine);
    expect(result.current.expand('s1', `[Paste #${mine} - 1 lines]`, 'sent')).toBe('belongs to one');
    expect(result.current.expand('s2', `[Paste #${theirs} - 1 lines]`, 'sent')).toBe('belongs to two');
  });

  it('has nothing to put back for a session that never held anything', () => {
    const { result } = renderHook(() => useDrafts());

    expect(result.current.expand('never', 'plain text', 'sent')).toBe('plain text');
  });

  // Once written, the agent is better off reading the file than being handed the text.
  it('names the file instead of the text once the paste has been written down', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'a\nb', 2);
    result.current.wroteTo('s1', id, 'C:\\tmp\\p.txt', '300 KB');

    expect(result.current.expand('s1', `[Paste #${id} - 2 lines]`, 'sent')).toBe(
      '<pasted_content file="C:\\tmp\\p.txt" size="300 KB" lines="2" />',
    );
  });

  it('ignores a write landing for a paste that is no longer held', () => {
    const { result } = renderHook(() => useDrafts());

    expect(() => result.current.wroteTo('s1', 99, 'gone.txt', '1 KB')).not.toThrow();
  });

  /**
   * Bounded, so one message never sent cannot hold every paste piled into it. The oldest
   * goes first, and its placeholder is sent as written rather than as an empty gap.
   */
  it('drops the oldest once it is holding more than it keeps', () => {
    const { result } = renderHook(() => useDrafts());

    const first = result.current.hold('s1', 'oldest', 1);
    let last = first;
    for (let i = 0; i < 32; i++) last = result.current.hold('s1', `paste ${i}`, 1);

    expect(result.current.expand('s1', `[Paste #${first} - 1 lines]`, 'sent')).toBe(`[Paste #${first} - 1 lines]`);
    expect(result.current.expand('s1', `[Paste #${last} - 1 lines]`, 'sent')).toBe('paste 31');
  });
});

/**
 * When a held paste is let go of.
 *
 * Held text is the largest thing this app keeps in memory, so the question is not only
 * whether it is freed but when: too early and a send that failed cannot be recovered.
 */
describe('letting go of a paste', () => {
  it('forgets what a sent message carried', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'a\nb', 2);
    const typed = `look at [Paste #${id} - 2 lines]`;

    act(() => result.current.release('s1', typed));

    expect(result.current.expand('s1', typed, 'sent')).toBe(typed);
  });

  it('keeps a paste whose placeholder was not in the message', () => {
    const { result } = renderHook(() => useDrafts());

    const sent = result.current.hold('s1', 'went', 1);
    const kept = result.current.hold('s1', 'stayed', 1);

    act(() => result.current.release('s1', `[Paste #${sent} - 1 lines]`));

    expect(result.current.expand('s1', `[Paste #${kept} - 1 lines]`, 'sent')).toBe('stayed');
  });

  /**
   * The recovery path a failed send depends on. The message goes back to the box exactly as
   * it was typed, so the paste behind it has to still be there to put back.
   */
  it('still holds the paste until the message is let go of', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'four hundred lines', 1);
    const typed = `[Paste #${id} - 1 lines]`;

    expect(result.current.expand('s1', typed, 'sent')).toBe('four hundred lines');
    expect(result.current.expand('s1', typed, 'sent')).toBe('four hundred lines');
  });

  it('lets go of nothing for a session that never held anything', () => {
    const { result } = renderHook(() => useDrafts());

    expect(() => result.current.release('never', '[Paste #1 - 1 lines]')).not.toThrow();
  });

  it('forgets a paste the message named by its file', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'a'.repeat(40), 1, '40 KB');
    const typed = written(id, '40 KB');
    act(() => result.current.write('s1', typed));
    act(() => result.current.wroteTo('s1', id, 'C:\\p.txt', '40 KB'));

    act(() => result.current.release('s1', typed));

    expect(result.current.expand('s1', typed, 'sent')).toBe(typed);
  });
});

/**
 * A paste that goes to a file (#55).
 *
 * The box names it as saved the moment it lands, rather than naming it by its length and
 * correcting itself once the write returns: the size and the id are both known straight
 * away, and only the path is not. Naming it twice would put a label on screen for just long
 * enough to read and then take it away.
 */
describe('naming a paste that went to a file', () => {
  /** The path is for the agent, so nothing the reader can see changes when it arrives. */
  it('leaves the box alone when the write lands', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'x', 65185, '6.2 MB');
    const typed = `look at ${written(id, '6.2 MB')} please`;
    act(() => result.current.write('s1', typed));

    act(() => result.current.wroteTo('s1', id, 'C:\\p\\big.txt', '6.2 MB'));

    expect(result.current.textOf('s1')).toBe(typed);
  });

  it('sends the saved paste as the reference to its file', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'x', 9, '1 KB');
    act(() => result.current.write('s1', written(id, '1 KB')));
    act(() => result.current.wroteTo('s1', id, 'C:\\p\\big.txt', '1 KB'));

    expect(result.current.expand('s1', result.current.textOf('s1'), 'sent')).toBe(
      '<pasted_content file="C:\\p\\big.txt" size="1 KB" lines="9" />',
    );
  });

  /** Already the reader's form, so the conversation shows it as the box had it. */
  it('shows the saved paste as it stands', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'x', 9, '1 KB');
    const typed = written(id, '1 KB');
    act(() => result.current.write('s1', typed));
    act(() => result.current.wroteTo('s1', id, 'C:\\p\\big.txt', '1 KB'));

    expect(result.current.expand('s1', typed, 'shown')).toBe(typed);
  });

  /**
   * The label is a promise made before the write, so a message sent while it is in flight
   * has to carry what the paste was rather than a reference to a file that is not there.
   */
  it('sends the text while the file is still being written', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'four hundred lines', 9, '1 KB');

    expect(result.current.expand('s1', written(id, '1 KB'), 'sent')).toBe('four hundred lines');
  });
});

/**
 * When the promise the box made turns out to be wrong.
 *
 * Naming a paste as saved on the way in is the price of not renaming it afterwards, and
 * this is the rare case where it was not true. The paste is still held, so the message
 * still carries it - only the label was mistaken.
 */
describe('a paste that never reached its file', () => {
  it('names it by its length after all', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'x', 9, '1 KB');
    act(() => result.current.write('s1', `look at ${written(id, '1 KB')} please`));

    act(() => result.current.writeFailed('s1', id));

    expect(result.current.textOf('s1')).toBe(`look at ${placeholder(id, 9)} please`);
  });

  it('still carries the paste it was holding', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'four hundred lines', 9, '1 KB');
    act(() => result.current.write('s1', written(id, '1 KB')));
    act(() => result.current.writeFailed('s1', id));

    expect(result.current.expand('s1', result.current.textOf('s1'), 'sent')).toBe('four hundred lines');
  });

  // Writing carries on while the file is being written, and it is not the paste.
  it('leaves what was typed in the meantime', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'x', 9, '1 KB');
    act(() => result.current.write('s1', `${written(id, '1 KB')} and a question`));
    act(() => result.current.writeFailed('s1', id));

    expect(result.current.textOf('s1')).toContain('and a question');
  });

  it('says nothing about a paste whose label was deleted', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'x', 9, '1 KB');
    act(() => result.current.write('s1', 'changed my mind'));
    act(() => result.current.writeFailed('s1', id));

    expect(result.current.textOf('s1')).toBe('changed my mind');
  });

  /** A write that lands after all is the one that was right, so the label stands. */
  it('leaves a label alone once the file is there', () => {
    const { result } = renderHook(() => useDrafts());

    const id = result.current.hold('s1', 'x', 9, '1 KB');
    const typed = written(id, '1 KB');
    act(() => result.current.write('s1', typed));
    act(() => result.current.wroteTo('s1', id, 'C:\\p\\big.txt', '1 KB'));

    act(() => result.current.writeFailed('s1', id));

    expect(result.current.textOf('s1')).toBe(typed);
  });
});
