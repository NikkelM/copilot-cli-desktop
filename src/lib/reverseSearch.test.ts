import { describe, expect, it } from 'vitest';

import { cycled, erased, highlighted, opened, typed } from './reverseSearch';

const history = ['fix the parser', 'add a test for the parser', 'run the build', 'FIX the docs'];

describe('opening a search', () => {
  it('starts with nothing typed and nothing found', () => {
    expect(opened()).toEqual({ query: '', match: null, at: -1, failed: false });
  });
});

describe('typing what to look for', () => {
  it('finds the newest prompt containing it', () => {
    const search = typed(opened(), history, 'f');

    expect(search.query).toBe('f');
    expect(search.match).toBe('fix the parser');
    expect(search.at).toBe(0);
    expect(search.failed).toBe(false);
  });

  it('ignores case, so a prompt written in capitals is still found', () => {
    const search = typed(typed(typed(opened(), history, 'F'), history, 'I'), history, 'X');

    expect(search.match).toBe('fix the parser');
  });

  it('searches again from the newest, so a second character can move the match forwards', () => {
    const search = typed(typed(opened(), history, 'r'), history, 'u');

    expect(search.match).toBe('run the build');
    expect(search.at).toBe(2);
  });

  it('keeps the match it had when the new character finds nothing', () => {
    const search = typed(typed(opened(), history, 'f'), history, 'z');

    expect(search.query).toBe('fz');
    expect(search.match).toBe('fix the parser');
    expect(search.failed).toBe(true);
  });

  it('fails without a match when the very first character finds nothing', () => {
    const search = typed(opened(), history, 'z');

    expect(search.match).toBeNull();
    expect(search.failed).toBe(true);
  });
});

describe('taking a character back', () => {
  it('finds what the shorter query finds', () => {
    const search = erased(typed(typed(opened(), history, 'r'), history, 'u'), history);

    expect(search.query).toBe('r');
    expect(search.match).toBe('fix the parser');
  });

  it('clears a failure, so backing out of a typo carries on the same search', () => {
    const search = erased(typed(typed(opened(), history, 'f'), history, 'z'), history);

    expect(search.failed).toBe(false);
    expect(search.match).toBe('fix the parser');
  });

  it('forgets the match once the query is empty', () => {
    const search = erased(typed(opened(), history, 'f'), history);

    expect(search.query).toBe('');
    expect(search.match).toBeNull();
    expect(search.at).toBe(-1);
  });

  it('does nothing with nothing typed', () => {
    const search = opened();

    expect(erased(search, history)).toBe(search);
  });
});

describe('stepping back through the matches', () => {
  it('moves to the next older prompt that matches', () => {
    const search = cycled(typed(opened(), history, 'the'), history);

    expect(search.match).toBe('add a test for the parser');
    expect(search.at).toBe(1);
  });

  it('stays on the last match rather than wrapping round, and says it failed', () => {
    let search = typed(opened(), history, 'run');
    search = cycled(search, history);

    expect(search.match).toBe('run the build');
    expect(search.failed).toBe(true);
  });

  it('does nothing with nothing typed, since every prompt would match', () => {
    const search = opened();

    expect(cycled(search, history)).toBe(search);
  });
});

describe('showing where the match was found', () => {
  it('splits the prompt around the part searched for', () => {
    expect(highlighted(typed(typed(opened(), history, 'p'), history, 'a'))).toEqual({
      before: 'fix the ',
      hit: 'pa',
      after: 'rser',
    });
  });

  it('highlights what was matched rather than what was typed, so case is kept', () => {
    const search = typed(typed(typed(opened(), ['FIX the docs'], 'f'), ['FIX the docs'], 'i'), ['FIX the docs'], 'x');

    expect(highlighted(search)).toEqual({ before: '', hit: 'FIX', after: ' the docs' });
  });

  it('shows a stale match whole, since none of it matches what is now typed', () => {
    const search = typed(typed(opened(), history, 'f'), history, 'z');

    expect(highlighted(search)).toEqual({ before: 'fix the parser', hit: '', after: '' });
  });

  it('has nothing to show before anything is found', () => {
    expect(highlighted(opened())).toBeNull();
  });
});
