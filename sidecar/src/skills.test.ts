import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

vi.mock('./paths.js', () => ({
  sessionStateDir: (sessionId: string) => join(home, 'session-state', sessionId),
}));

const { disabledSkills, setSkillDisabled } = await import('./skills.js');

const storeOf = (sessionId: string) => join(home, 'session-state', sessionId, 'desktop-skills.json');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skills-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('what a session has switched off', () => {
  it('starts with nothing switched off', () => {
    expect(disabledSkills('s1')).toEqual([]);
  });

  it('remembers a skill that was switched off', () => {
    setSkillDisabled('s1', 'agent-creator', true);

    expect(disabledSkills('s1')).toEqual(['agent-creator']);
  });

  it('switches one back on without disturbing the rest', () => {
    setSkillDisabled('s1', 'agent-creator', true);
    setSkillDisabled('s1', 'skill-creator', true);

    setSkillDisabled('s1', 'agent-creator', false);

    expect(disabledSkills('s1')).toEqual(['skill-creator']);
  });

  // The whole set, because the runtime replaces rather than amends: a caller applying this
  // to a live session needs everything that should be off, not the one that just changed.
  it('reports the whole set, not the change', () => {
    setSkillDisabled('s1', 'b', true);

    expect(setSkillDisabled('s1', 'a', true)).toEqual(['a', 'b']);
  });

  it('keeps one session choice out of another', () => {
    setSkillDisabled('s1', 'agent-creator', true);

    expect(disabledSkills('s2')).toEqual([]);
  });

  it('switching off a skill twice leaves it off once', () => {
    setSkillDisabled('s1', 'agent-creator', true);

    expect(setSkillDisabled('s1', 'agent-creator', true)).toEqual(['agent-creator']);
  });

  it('switching on a skill that was never off changes nothing', () => {
    expect(setSkillDisabled('s1', 'never-touched', false)).toEqual([]);
  });
});

describe('the file behind it', () => {
  // A session restored to its defaults should leave the same trace as one never touched.
  it('is removed once nothing is switched off', () => {
    setSkillDisabled('s1', 'agent-creator', true);
    expect(existsSync(storeOf('s1'))).toBe(true);

    setSkillDisabled('s1', 'agent-creator', false);

    expect(existsSync(storeOf('s1'))).toBe(false);
  });

  it('writes the names it was given', () => {
    setSkillDisabled('s1', 'agent-creator', true);

    expect(JSON.parse(readFileSync(storeOf('s1'), 'utf8'))).toEqual({ disabled: ['agent-creator'] });
  });

  // A broken preferences file should cost the reader their toggles, not their session.
  it('reads an unparseable file as no choices', () => {
    mkdirSync(join(home, 'session-state', 's1'), { recursive: true });
    writeFileSync(storeOf('s1'), '{ not json');

    expect(disabledSkills('s1')).toEqual([]);
  });

  it('ignores a file whose list is not a list', () => {
    mkdirSync(join(home, 'session-state', 's1'), { recursive: true });
    writeFileSync(storeOf('s1'), JSON.stringify({ disabled: 'agent-creator' }));

    expect(disabledSkills('s1')).toEqual([]);
  });

  it('keeps only the names among whatever the file holds', () => {
    mkdirSync(join(home, 'session-state', 's1'), { recursive: true });
    writeFileSync(storeOf('s1'), JSON.stringify({ disabled: ['real', 7, null, 'also-real'] }));

    expect(disabledSkills('s1')).toEqual(['real', 'also-real']);
  });

  it('writes into a directory that does not exist yet', () => {
    expect(() => setSkillDisabled('fresh', 'agent-creator', true)).not.toThrow();

    expect(disabledSkills('fresh')).toEqual(['agent-creator']);
  });
});
