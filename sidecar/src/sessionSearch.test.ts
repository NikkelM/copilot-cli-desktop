import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asPhrase, turnOf } from './sessionSearch.js';

/**
 * A throwaway store with the CLI's real FTS5 table.
 *
 * Against a real index rather than a stub, because everything this module does is decided by
 * FTS5: whether a phrase matches, whether a prefix matches, and what a snippet looks like.
 * A stubbed query would test the fold and nothing else - and it was FTS5 refusing `snippet`
 * beside `GROUP BY` that broke the first version of this.
 */
function makeStore() {
  const home = mkdtempSync(join(tmpdir(), 'ccd-search-'));
  const db = new DatabaseSync(join(home, 'session-store.db'));

  db.exec(`
    CREATE VIRTUAL TABLE search_index USING fts5(
      content, session_id UNINDEXED, source_type UNINDEXED, source_id UNINDEXED
    );
  `);

  return {
    home,
    say(sessionId: string, turn: number | null, content: string) {
      const sourceId = turn === null ? `${sessionId}:ckpt:0:checkpoint_history` : `${sessionId}:turn:${turn}`;
      db.prepare(
        `INSERT INTO search_index (content, session_id, source_type, source_id) VALUES (?, ?, ?, ?)`,
      ).run(content, sessionId, turn === null ? 'checkpoint_history' : 'turn', sourceId);
    },
    close() {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

let store: ReturnType<typeof makeStore>;

/** paths.ts reads COPILOT_HOME once at import, so the module cache must be cleared. */
async function search(query: string) {
  vi.resetModules();
  process.env.COPILOT_HOME = store.home;
  const { searchSessions } = await import('./sessionSearch.js');
  return searchSessions(query);
}

beforeEach(() => {
  store = makeStore();
});

afterEach(() => {
  store.close();
  delete process.env.COPILOT_HOME;
});

/**
 * Quoted as one phrase, which is both what the filter box has always meant and what makes
 * anything a reader can type safe to hand to FTS5.
 */
describe('turning what was typed into a query', () => {
  it('reads two words as one phrase rather than two conditions', () => {
    expect(asPhrase('hades biomes')).toBe('"hades biomes"*');
  });

  it('escapes the one character that would still end the phrase', () => {
    expect(asPhrase('say "hi"')).toBe('"say ""hi"""*');
  });

  it('leaves a path alone, where a colon and a backslash are just characters', () => {
    expect(asPhrase('C:\\work')).toBe('"C:\\work"*');
  });
});

describe('which turn a match sits in', () => {
  it('reads the index out of a turn source', () => {
    expect(turnOf('abc:turn:269')).toBe(269);
  });

  it('has none for a checkpoint, which is not in the conversation', () => {
    expect(turnOf('abc:ckpt:0:checkpoint_history')).toBeNull();
  });

  it('has none for anything it does not recognise', () => {
    expect(turnOf('rubbish')).toBeNull();
    expect(turnOf('')).toBeNull();
  });

  // `turn` with nothing after it, or something that is not a number, is not a turn.
  it('has none when the index is missing or not a number', () => {
    expect(turnOf('abc:turn:')).toBeNull();
    expect(turnOf('abc:turn:later')).toBeNull();
  });
});

describe('searching what sessions said', () => {
  it('finds the session that said it', async () => {
    store.say('one', 3, 'the eviction rule was wrong');
    store.say('two', 0, 'something else entirely');

    const found = await search('eviction');

    expect(found.map((m) => m.sessionId)).toEqual(['one']);
    expect(found[0].turn).toBe(3);
  });

  it('names a session once, however often it said it', async () => {
    store.say('one', 0, 'eviction');
    store.say('one', 1, 'eviction again');
    store.say('one', 2, 'and eviction once more');

    expect((await search('eviction')).map((m) => m.sessionId)).toEqual(['one']);
  });

  /**
   * Which of a session's matches is kept is the one the reader is shown and the one clicking
   * goes to, so it has to be the best rather than whichever came back last.
   */
  it('keeps a session\'s best match rather than its last', async () => {
    // Short and entirely about the term, so BM25 ranks it above the long one below.
    store.say('one', 4, 'eviction');
    store.say(
      'one',
      9,
      'a long stretch of unrelated prose that happens to mention eviction once somewhere in ' +
        'the middle of a great many other words which dilute it considerably further still',
    );

    const [match] = await search('eviction');

    expect(match.turn).toBe(4);
    expect(match.excerpt).toContain('\u0002eviction\u0003');
  });

  it('matches the last word by prefix, so a query narrows as it is typed', async () => {
    store.say('one', 0, 'the eviction rule');

    expect(await search('evict')).toHaveLength(1);
  });

  it('matches two words together rather than separately', async () => {
    store.say('together', 0, 'the branch picker opens');
    store.say('apart', 1, 'a branch, and elsewhere a picker');

    expect((await search('branch picker')).map((m) => m.sessionId)).toEqual(['together']);
  });

  it('has no turn to go to for something said in a checkpoint', async () => {
    store.say('one', null, 'eviction was settled here');

    expect((await search('eviction'))[0].turn).toBeNull();
  });

  it('marks the match inside the words around it', async () => {
    store.say('one', 0, 'we decided the eviction rule was wrong after all');

    const { excerpt } = (await search('eviction'))[0];

    expect(excerpt).toContain('\u0002eviction\u0003');
  });

  it('finds nothing rather than everything for a word nobody said', async () => {
    store.say('one', 0, 'the eviction rule');

    expect(await search('zzzznope')).toEqual([]);
  });

  it('asks nothing at all for an empty query', async () => {
    store.say('one', 0, 'the eviction rule');

    expect(await search('')).toEqual([]);
    expect(await search('   ')).toEqual([]);
  });

  /**
   * Everything below is something FTS5 would otherwise read as syntax. Quoting the query
   * turns each of them back into text, which is what somebody typing into a filter box means.
   */
  describe('what a reader can type without it meaning something else', () => {
    it('reads OR and NOT as words, not as operators', async () => {
      store.say('literal', 0, 'a memory OR a session');
      store.say('other', 1, 'memory on its own');

      expect((await search('memory OR')).map((m) => m.sessionId)).toEqual(['literal']);
    });

    it('reads a path as a path', async () => {
      store.say('one', 0, 'it lives in C:\\work\\repo now');

      expect(await search('C:\\work')).toHaveLength(1);
    });

    it('survives a lone quote', async () => {
      store.say('one', 0, 'the eviction rule');

      expect(await search('"')).toEqual([]);
    });

    it('survives the characters FTS5 would read as operators', async () => {
      store.say('one', 0, 'the eviction rule');

      for (const query of ['*', '^', '-', '(', ')', ':', 'NEAR(']) {
        expect(await search(query), `${query} should not throw`).toBeInstanceOf(Array);
      }
    });
  });

  it('says nothing when there is no database to read', async () => {
    store.close();
    expect(await search('eviction')).toEqual([]);
    store = makeStore();
  });
});
