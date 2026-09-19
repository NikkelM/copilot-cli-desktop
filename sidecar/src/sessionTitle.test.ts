import { describe, expect, it } from 'vitest';

import { TITLE_QUESTION, isPlaceholder, titleIn } from './sessionTitle.js';

describe('the title out of a model answer', () => {
  it('reads one from the tags it was asked for', () => {
    expect(titleIn('<session-title>Fix Broken Login Form</session-title>')).toBe('Fix Broken Login Form');
  });

  // Observed: models answer with the tags alone, but a reply that explains itself first is
  // the ordinary way for one to go wrong, and the tags are there to survive that.
  it('finds one in an answer that explains itself first', () => {
    const answer = 'Looking at the conversation, the task is clear.\n\n<session-title>Add React Dark Mode</session-title>';

    expect(titleIn(answer)).toBe('Add React Dark Mode');
  });

  it('flattens one that came back across lines', () => {
    expect(titleIn('<session-title>Fix\n  Broken   Login</session-title>')).toBe('Fix Broken Login');
  });

  /**
   * Refused rather than salvaged. A model that ignored the format has probably ignored the
   * rules too, and the name being replaced at least says what the session is about.
   */
  it('takes an answer without the tags as no answer', () => {
    expect(titleIn('Fix Broken Login Form')).toBeNull();
    expect(titleIn('The title is: Fix Broken Login Form.')).toBeNull();
  });

  it('refuses an empty one, which would leave a session with no name at all', () => {
    expect(titleIn('<session-title></session-title>')).toBeNull();
    expect(titleIn('<session-title>   </session-title>')).toBeNull();
  });

  // Past sixty characters it is not a title, it is the answer to a different question.
  it('refuses one long enough to be the problem it is solving', () => {
    const rambling = 'Fix the login form so that it stops rejecting passwords that are perfectly valid';

    expect(titleIn(`<session-title>${rambling}</session-title>`)).toBeNull();
    expect(titleIn(`<session-title>${'x'.repeat(60)}</session-title>`)).toBe('x'.repeat(60));
  });

  it('closes on the first closing tag rather than the last', () => {
    expect(titleIn('<session-title>First</session-title> and <session-title>Second</session-title>')).toBe('First');
  });
});

describe('whether a name is standing in for a title', () => {
  const PROMPT = 'Fix the login form, which rejects valid passwords.';

  it('says so for a session with no name', () => {
    expect(isPlaceholder(null, PROMPT, false)).toBe(true);
    expect(isPlaceholder('', PROMPT, false)).toBe(true);
    expect(isPlaceholder('   ', PROMPT, false)).toBe(true);
  });

  // The runtime writes the prompt verbatim, so this is exact rather than a guess at length.
  it('says so for a name that is the prompt', () => {
    expect(isPlaceholder(PROMPT, PROMPT, false)).toBe(true);
    expect(isPlaceholder(` ${PROMPT} `, PROMPT, false)).toBe(true);
  });

  it('leaves a title the CLI wrote alone', () => {
    expect(isPlaceholder('Fix Login Form Bug', PROMPT, false)).toBe(false);
  });

  /** Even when it is the prompt, and even when it is long: somebody typed it. */
  it('never touches a name somebody chose', () => {
    expect(isPlaceholder(PROMPT, PROMPT, true)).toBe(false);
    expect(isPlaceholder(null, PROMPT, true)).toBe(false);
    expect(isPlaceholder('A Name Somebody Chose', PROMPT, true)).toBe(false);
  });

  // A prompt only a few words long is still a prompt, and a written title still reads better.
  it('says so for a short prompt, which is still a prompt', () => {
    expect(isPlaceholder('fix the login bug', 'fix the login bug', false)).toBe(true);
  });
});

describe('the question asked', () => {
  /**
   * Taken from `runtime.node`, where the CLI's own titles come from. A title written here
   * should be indistinguishable from one the CLI wrote, and asking the same question is the
   * only way to be sure of it.
   */
  it('is the runtime own wording, tags and all', () => {
    expect(TITLE_QUESTION).toContain('Generate a short title for a coding session');
    expect(TITLE_QUESTION).toContain('2-6 words, title case');
    expect(TITLE_QUESTION).toContain('<session-title></session-title>');
  });

  it('asks for what it can read back', () => {
    // The format the question demands is the one titleIn expects, or every answer is refused.
    expect(titleIn('<session-title>Fix Broken Login Form</session-title>')).not.toBeNull();
  });
});

