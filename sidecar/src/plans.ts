import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { structuredPatch } from 'diff';

import type { SavedSessionPlan, SessionPlan } from '../../shared/protocol.js';
import { sessionStateDir } from './paths.js';

function planPath(sessionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sessionId)) throw new Error('Invalid session id');
  const directory = sessionStateDir(sessionId);
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Session directory cannot be a symbolic link');
  return join(directory, 'plan.md');
}

export function readSessionPlan(sessionId: string): SessionPlan | null {
  const path = planPath(sessionId);
  let content: string;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Session plan cannot be a symbolic link');
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return { path, content, revision: createHash('sha256').update(content).digest('hex') };
}

/** Locations refer to the saved revision, with a whole-plan fallback for broad or ambiguous edits */
export function planChangeHint(before: string, after: string): string | undefined {
  if (before.length + after.length > 1_000_000) return undefined;
  const oldText = before.replace(/\r\n/g, '\n');
  const newText = after.replace(/\r\n/g, '\n');
  const patch = structuredPatch('plan.md', 'plan.md', oldText, newText, undefined, undefined, {
    context: 0, timeout: 25, maxEditLength: 2000,
  });
  if (!patch?.hunks.length || patch.hunks.length > 6) return undefined;
  const lines = newText.split('\n');
  const changed = patch.hunks.reduce((count, hunk) => count + Math.max(hunk.oldLines, hunk.newLines), 0);
  if (changed > Math.max(oldText.split('\n').length, lines.length) / 2) return undefined;
  if (patch.hunks.some((hunk) => hunk.lines.some((line) => /^- {0,3}(?:#{1,6}(?:\s|$)|(?:=+|-+)\s*$)/.test(line)))) return undefined;

  const sections: string[] = [];
  const headings: { level: number; title: string }[] = [];
  let section = '';
  let fence: string | null = null;
  let frontmatter = lines[0] === '---';
  for (const [index, line] of lines.entries()) {
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false;
    } else {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker) {
        if (!fence) fence = marker[1]!;
        else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      } else if (!fence) {
        const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
        if (heading) {
          const level = heading[1]!.length;
          while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
          headings.push({ level, title: heading[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim() });
          section = headings.map((item) => item.title).join(' > ');
        }
      }
    }
    sections.push(section);
  }

  const groups = new Map<string, string[]>();
  for (const hunk of patch.hunks) {
    // A pure deletion names a gap, so include its surviving neighbours
    const start = Math.max(1, Math.min(lines.length, hunk.newStart - (hunk.newLines === 0 ? 1 : 0)));
    const end = Math.min(lines.length, start + (hunk.newLines === 0 ? 1 : hunk.newLines - 1));
    const affected = new Set(sections.slice(start - 1, end));
    if (affected.size > 1) return undefined;
    const heading = sections[start - 1] ?? '';
    const range = `L${start}${end > start ? `-${end}` : ''}${hunk.oldLines > hunk.newLines ? ' (deletions)' : ''}`;
    groups.set(heading, [...(groups.get(heading) ?? []), range]);
  }
  const hint = [...groups].map(([heading, ranges]) => `${heading ? `${heading}: ` : ''}${ranges.join(', ')}`).join('; ');
  return hint.length <= 320 ? hint : undefined;
}

export function writeSessionPlan(sessionId: string, content: string, revision: string): SavedSessionPlan {
  const path = planPath(sessionId);
  const temporary = join(sessionStateDir(sessionId), `.plan-${randomUUID()}.tmp`);
  let changedSections: string | undefined;
  try {
    writeFileSync(temporary, content, { flag: 'wx' });
    const current = readSessionPlan(sessionId);
    if (!current || current.revision !== revision) throw new Error('The plan changed on disk. Your edits have not been saved. Reload the plan before trying again.');
    changedSections = planChangeHint(current.content, content);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return {
    path, content, revision: createHash('sha256').update(content).digest('hex'),
    ...(changedSections ? { changedSections } : {}),
  };
}

/** Watch the directory rather than the file so atomic replacement and recreation are visible */
export function createPlanWatcher(onChanged: (sessionId: string, failed?: string) => void) {
  let watcher: FSWatcher | undefined;
  const close = () => {
    watcher?.close();
    watcher = undefined;
  };
  return {
    close,
    watch(sessionId: string | null) {
      close();
      if (!sessionId) return;
      planPath(sessionId);
      const current = watch(sessionStateDir(sessionId), (_event, filename) => {
        if (watcher === current && (!filename || filename.toString().toLowerCase() === 'plan.md')) onChanged(sessionId);
      });
      watcher = current;
      current.on('error', (error) => {
        if (watcher !== current) return;
        close();
        onChanged(sessionId, `Plan updates could not be watched: ${error.message}`);
      });
    },
  };
}
