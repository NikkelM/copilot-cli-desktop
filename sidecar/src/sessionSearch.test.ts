import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asPhrase } from './sessionSearch.js';

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
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER, timestamp TEXT
    );
    CREATE TABLE checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, checkpoint_number INTEGER, created_at TEXT
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
    turn(sessionId: string, index: number, timestamp: string) {
      db.prepare(`INSERT INTO turns (session_id, turn_index, timestamp) VALUES (?, ?, ?)`).run(
        sessionId,
        index,
        timestamp,
      );
    },
    checkpoint(sessionId: string, number: number, createdAt: string) {
      db.prepare(`INSERT INTO checkpoints (session_id, checkpoint_number, created_at) VALUES (?, ?, ?)`).run(
        sessionId,
        number,
        createdAt,
      );
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

describe('searching what sessions said', () => {
  it('finds the session that said it', async () => {
    store.say('one', 3, 'the eviction rule was wrong');
    store.say('two', 0, 'something else entirely');

    const found = await search('eviction');

    expect(found.map((m) => m.sessionId)).toEqual(['one']);
    expect(found[0].source).toBe('one:turn:3');
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

    expect(match.source).toBe('one:turn:4');
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

  /**
   * The index also holds checkpoint summaries, which are written about a session rather than
   * in it. Their words are nowhere in the conversation, so a reader sent to one arrives at a
   * page with nothing to see.
   */
  it('finds only what was said, not what was written about it', async () => {
    store.say('one', null, 'the eviction rule was settled here');

    expect(await search('eviction')).toEqual([]);
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

/**
 * Where to stop reading so a match is on the page that opens.
 *
 * A turn ends where the next begins; a checkpoint summarises up to the moment it was
 * written, so its own time is where to arrive. Getting this wrong for checkpoints is what
 * made a match in one open at the end of the session instead, with nothing saying why.
 */
describe('the moment a match should open at', () => {
  const at = async (sessionId: string, source: string) => {
    vi.resetModules();
    process.env.COPILOT_HOME = store.home;
    const { momentAfter } = await import('./sessionSearch.js');
    return momentAfter(sessionId, source);
  };

  it('ends a turn where the next one begins', async () => {
    store.turn('one', 3, '2026-01-01T00:03:00.000Z');
    store.turn('one', 4, '2026-01-01T00:04:00.000Z');

    expect(await at('one', 'one:turn:3')).toBe('2026-01-01T00:04:00.000Z');
  });

  // Nothing follows the last turn, so it runs to the end of the log.
  it('has no bound for the last turn', async () => {
    store.turn('one', 3, '2026-01-01T00:03:00.000Z');

    expect(await at('one', 'one:turn:3')).toBeNull();
  });

  // Only turns are searched, so only turns ever arrive here.
  it('says nothing for a handle that is not a turn', async () => {
    store.checkpoint('one', 2, '2026-01-01T09:00:00.000Z');

    expect(await at('one', 'one:ckpt:2:checkpoint_history')).toBeUndefined();
  });

  /** Not the same answer as a turn that runs to the end: this names nothing at all. */
  it('says nothing for a turn the database does not hold', async () => {
    store.turn('one', 3, '2026-01-01T00:03:00.000Z');

    expect(await at('one', 'one:turn:9')).toBeUndefined();
  });

  it('says nothing for a checkpoint the database does not hold', async () => {
    expect(await at('one', 'one:ckpt:7:checkpoint_history')).toBeUndefined();
  });

  it('says nothing for a handle of a kind it does not know', async () => {
    expect(await at('one', 'one:something:3')).toBeUndefined();
    expect(await at('one', 'rubbish')).toBeUndefined();
    expect(await at('one', '')).toBeUndefined();
  });

  it('says nothing for a turn whose index is not a number', async () => {
    expect(await at('one', 'one:turn:later')).toBeUndefined();
    expect(await at('one', 'one:turn:')).toBeUndefined();
  });

  // Another session's turn three is not this one's.
  it('answers for the session it was asked about', async () => {
    store.turn('one', 3, '2026-01-01T00:03:00.000Z');
    store.turn('one', 4, '2026-01-01T00:04:00.000Z');

    expect(await at('two', 'two:turn:3')).toBeUndefined();
  });
});
