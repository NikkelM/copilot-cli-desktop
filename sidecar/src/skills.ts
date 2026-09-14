import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sessionStateDir } from './paths.js';

/**
 * Which skills a session has been told not to load.
 *
 * The runtime has its own per-session disable, and it does not survive a resume - measured:
 * disable, disconnect, resume, and the skill is back on. This app disconnects idle sessions
 * on purpose, so relying on that would mean a switch that silently flips itself back the
 * next time the session is evicted. The set is kept here instead and handed to the runtime
 * as `disabledSkills` every time a session is created or resumed, which does survive.
 *
 * Beside the session's own record rather than in one shared file, as pastes are: deleting
 * a session takes its choices with it, and two sessions never contend for the same write.
 */
function storePath(sessionId: string): string {
  return join(sessionStateDir(sessionId), 'desktop-skills.json');
}

interface Stored {
  disabled: string[];
}

/**
 * The skills this session has switched off.
 *
 * Anything unreadable is treated as no choices rather than an error: a corrupt preferences
 * file should cost the reader their toggles, not their session.
 */
export function disabledSkills(sessionId: string): string[] {
  const path = storePath(sessionId);
  if (!existsSync(path)) return [];

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Stored;
    return Array.isArray(parsed.disabled) ? parsed.disabled.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Switch one skill on or off for one session, and report the whole set afterwards.
 *
 * The whole set, because that is what the runtime takes: `disabledSkills` replaces rather
 * than amends, so the caller needs all of it to apply the change to a live session.
 */
export function setSkillDisabled(sessionId: string, name: string, disabled: boolean): string[] {
  const current = new Set(disabledSkills(sessionId));
  if (disabled) current.add(name);
  else current.delete(name);

  const next = [...current].sort();
  const path = storePath(sessionId);

  // Nothing switched off is the default, so the file is removed rather than left holding an
  // empty list. A session that was never touched and one restored to its defaults are the
  // same session, and should leave the same trace.
  if (next.length === 0) {
    rmSync(path, { force: true });
    return next;
  }

  mkdirSync(sessionStateDir(sessionId), { recursive: true });
  writeFileSync(path, JSON.stringify({ disabled: next }, null, 2));
  return next;
}
