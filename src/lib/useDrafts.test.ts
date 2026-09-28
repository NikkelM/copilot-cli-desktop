// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useDrafts } from './useDrafts';

describe('writing that has not been sent', () => {
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
});
