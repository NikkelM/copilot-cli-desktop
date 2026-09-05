import { describe, expect, it } from 'vitest';

import { appendLive, timelineOf, type TimelineEvent } from './timeline';

const said = (content: string, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  type: 'user.message',
  data: { content },
  ...extra,
});

const replied = (content: string): TimelineEvent => ({ type: 'assistant.message', data: { content } });

describe('appendLive', () => {
  it('adds an event to the end', () => {
    expect(appendLive([replied('one')], replied('two'))).toEqual([replied('one'), replied('two')]);
  });

  // The prompt is shown before the runtime confirms it, so the echo must land on the
  // entry already there rather than beside it.
  it('replaces the optimistic prompt with the echo of the same message', () => {
    const optimistic = said('hello', { local: true, id: 'local-1' });
    const echo = said('hello', { id: 'server-1' });

    const next = appendLive([replied('earlier'), optimistic], echo);

    expect(next).toHaveLength(2);
    expect(next[1]).toBe(echo);
  });

  it('keeps a prompt that says something else', () => {
    const optimistic = said('hello', { local: true });
    expect(appendLive([optimistic], said('goodbye'))).toHaveLength(2);
  });

  // Only the app's own entries are placeholders; a replayed message is history.
  it('does not fold an echo into an identical message from the log', () => {
    expect(appendLive([said('hello')], said('hello'))).toHaveLength(2);
  });
});

describe('timelineOf', () => {
  it('puts everything since selection after the replayed history', () => {
    expect(timelineOf([replied('old')], [said('new')])).toEqual([replied('old'), said('new')]);
  });

  /**
   * The bug behind #71. A replay describes the log at the moment it was requested, so
   * when the two lists were one, a reply that arrived after the user had already typed
   * overwrote the prompt, which then reappeared only when the session was reopened.
   */
  it('survives history arriving after the user has already sent something', () => {
    const prompt = said('do the thing', { local: true });

    // The user sends while the replay is still in flight.
    let live = appendLive([], prompt);
    // The replay lands, describing a log recorded before that prompt existed.
    const history = [replied('from the log')];

    expect(timelineOf(history, live)).toEqual([replied('from the log'), prompt]);

    // And the runtime's echo still finds the prompt to replace.
    const echo = said('do the thing');
    live = appendLive(live, echo);
    expect(timelineOf(history, live)).toEqual([replied('from the log'), echo]);
  });

  it('holds live events through a page of older history being prepended', () => {
    const live = [said('recent', { local: true })];
    const history = [replied('page two')];
    const older = [replied('page one')];

    expect(timelineOf([...older, ...history], live)).toEqual([
      replied('page one'),
      replied('page two'),
      said('recent', { local: true }),
    ]);
  });
});
