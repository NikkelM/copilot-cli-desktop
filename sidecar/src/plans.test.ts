import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
let plans: typeof import('./plans.js');
let directory: string;
let file: string;
const watchers: ReturnType<typeof import('./plans.js')['createPlanWatcher']>[] = [];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ccd-plans-'));
  directory = join(home, 'session-state', 's1');
  mkdirSync(directory, { recursive: true });
  file = join(directory, 'plan.md');
  vi.stubEnv('COPILOT_HOME', home);
  vi.resetModules();
  plans = await import('./plans.js');
});

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.close();
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('session plan files', () => {
  it('reads only the root plan and distinguishes no plan from an empty plan', () => {
    mkdirSync(join(directory, 'files'));
    writeFileSync(join(directory, 'files', 'plan.md'), 'not the session plan');
    expect(plans.readSessionPlan('s1')).toBeNull();
    writeFileSync(file, '');
    expect(plans.readSessionPlan('s1')).toEqual({ path: file, content: '', revision: expect.any(String) });
  });

  describe('compact plan edit locations', () => {
    const before = [
      '# Plan', '## Work', 'Intro', 'old first', 'unchanged', 'old second',
      ...Array.from({ length: 20 }, (_, index) => `Keep ${index}`),
    ].join('\n');

    it('groups exact changed line ranges under their shared heading path', () => {
      const after = before.replace('old first', 'new first').replace('old second', 'new second');
      expect(plans.planChangeHint(before, after)).toBe('Plan > Work: L4, L6');
    });

    it('gets the hints from the file revision actually replaced by a successful save', () => {
      writeFileSync(file, before);
      const original = plans.readSessionPlan('s1')!;
      const saved = plans.writeSessionPlan('s1', before.replace('old first', 'new first'), original.revision);
      expect(saved.changedSections).toBe('Plan > Work: L4');
      expect(plans.readSessionPlan('s1')?.content).toBe(saved.content);
      expect(plans.readSessionPlan('s1')).not.toHaveProperty('changedSections');
    });

    it('includes deletion hints with a readable range in the updated document', () => {
      expect(plans.planChangeHint(before, before.replace('old first\n', ''))).toBe(
        'Plan > Work: L3-4 (deletions)',
      );
    });

    it('uses an existing line when the last line is deleted', () => {
      const source = `${before}\ndelete this`;
      expect(plans.planChangeHint(source, before)).toBe(`Plan > Work: L${before.split('\n').length} (deletions)`);
    });

    it('distinguishes repeated heading names by their parent headings', () => {
      const source = [
        '# Plan', '## Build', '### Tests', 'old build', 'keep 1', 'keep 2',
        '## Deploy', '### Tests', 'old deploy', ...Array.from({ length: 15 }, (_, index) => `Keep ${index}`),
      ].join('\n');
      expect(plans.planChangeHint(source, source.replace('old deploy', 'new deploy'))).toBe(
        'Plan > Deploy > Tests: L9',
      );
    });

    it.each(['```', '~~~~'])('ignores heading-like text inside %s code fences', (fence) => {
      const source = [
        '# Plan', '## Work', `${fence}markdown`, '# Fake heading', fence, 'old',
        ...Array.from({ length: 10 }, (_, index) => `Keep ${index}`),
      ].join('\n');
      expect(plans.planChangeHint(source, source.replace('\nold\n', '\nnew\n'))).toBe('Plan > Work: L6');
    });

    it('keeps physical line numbers when frontmatter is present', () => {
      const source = `---\ntitle: Plan\n---\n${before}`;
      expect(plans.planChangeHint(source, source.replace('old first', 'new first'))).toBe('Plan > Work: L7');
    });

    it('falls back to line ranges when the document has no recognised heading', () => {
      const source = ['Intro', 'old', ...Array.from({ length: 10 }, (_, index) => `Keep ${index}`)].join('\n');
      expect(plans.planChangeHint(source, source.replace('\nold\n', '\nnew\n'))).toBe('L2');
    });

    it.each([
      (source: string) => source.replace('## Work', '## Renamed work'),
      (source: string) => source.replace('## Work\n', ''),
    ])('requests a whole-plan reread for renamed or deleted headings', (change) => {
      expect(plans.planChangeHint(before, change(before))).toBeUndefined();
    });

    it('requests a whole-plan reread for broad edits or too many separate changes', () => {
      const source = Array.from({ length: 40 }, (_, index) => `Line ${index}`).join('\n');
      expect(plans.planChangeHint(source, source.replace(/Line/g, 'Replaced'))).toBeUndefined();
      const sixEdits = source.replace(/Line (0|2|4|6|8|10)(?=\n|$)/g, 'Changed $1');
      expect(plans.planChangeHint(source, sixEdits)).toBe('L1, L3, L5, L7, L9, L11');
      const scattered = source.replace(/Line (0|2|4|6|8|10|12)(?=\n|$)/g, 'Changed $1');
      expect(plans.planChangeHint(source, scattered)).toBeUndefined();
    });

    it('caps hints at 320 characters without truncating or silently dropping a changed section', () => {
      const withHeading = (length: number) => `# ${'x'.repeat(length)}\nKeep\nold\nMore\nKeep\nMore`;
      const fitting = withHeading(316);
      expect(plans.planChangeHint(fitting, fitting.replace('\nold\n', '\nnew\n'))).toHaveLength(320);
      const tooLong = withHeading(317);
      expect(plans.planChangeHint(tooLong, tooLong.replace('\nold\n', '\nnew\n'))).toBeUndefined();
    });

    it('bounds document diffing at one million combined characters', () => {
      const withLength = (length: number) => {
        const prefix = '# Plan\n';
        const suffix = '\nold\nKeep\nMore\nKeep';
        return prefix + 'x'.repeat(length - prefix.length - suffix.length) + suffix;
      };
      const fitting = withLength(500_000);
      expect(plans.planChangeHint(fitting, fitting.replace('\nold\n', '\nnew\n'))).toBe('Plan: L3');
      const oversized = withLength(500_001);
      expect(plans.planChangeHint(oversized, oversized.replace('\nold\n', '\nnew\n'))).toBeUndefined();
    });

    it('emits no misleading locations for unchanged or line-ending-only edits', () => {
      expect(plans.planChangeHint(before, before)).toBeUndefined();
      expect(plans.planChangeHint(before, before.replace(/\n/g, '\r\n'))).toBeUndefined();
    });
  });

  it('replaces an existing plan completely, updates its revision, and leaves no temporary file', () => {
    writeFileSync(file, '# Original\n\nLong content');
    const original = plans.readSessionPlan('s1')!;
    const saved = plans.writeSessionPlan('s1', '# New', original.revision);
    expect(saved).toEqual(plans.readSessionPlan('s1'));
    expect(saved.content).toBe('# New');
    expect(saved.revision).not.toBe(original.revision);
    expect(readdirSync(directory)).toEqual(['plan.md']);
    expect(plans.writeSessionPlan('s1', '', saved.revision).content).toBe('');
    expect(plans.readSessionPlan('s1')?.content).toBe('');
  });

  it('refuses stale edits and does not overwrite the agent or leave a temporary file', () => {
    writeFileSync(file, 'initial');
    const original = plans.readSessionPlan('s1')!;
    writeFileSync(file, 'agent revision');
    expect(() => plans.writeSessionPlan('s1', 'user revision', original.revision)).toThrow('changed on disk');
    expect(plans.readSessionPlan('s1')?.content).toBe('agent revision');
    expect(readdirSync(directory)).toEqual(['plan.md']);
  });

  it('does not recreate a plan deleted while it was being edited', () => {
    writeFileSync(file, 'initial');
    const original = plans.readSessionPlan('s1')!;
    unlinkSync(file);
    expect(() => plans.writeSessionPlan('s1', 'draft', original.revision)).toThrow('changed on disk');
    expect(plans.readSessionPlan('s1')).toBeNull();
    expect(readdirSync(directory)).toEqual([]);
  });

  it('reports read errors rather than pretending there is no plan', () => {
    mkdirSync(file);
    expect(() => plans.readSessionPlan('s1')).toThrow();
  });

  it.each(['..', '..\\outside', 'a/b', '', 'C:\\outside'])('rejects invalid session id %j', (id) => {
    expect(() => plans.readSessionPlan(id)).toThrow('Invalid session id');
    expect(() => plans.writeSessionPlan(id, 'draft', 'revision')).toThrow('Invalid session id');
  });

  it('watches creation, atomic replacement, deletion and recreation without a CLI process', async () => {
    const changed = vi.fn();
    const watcher = plans.createPlanWatcher(changed);
    watchers.push(watcher);
    watcher.watch('s1');
    writeFileSync(file, 'created');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('s1'));
    changed.mockClear();
    writeFileSync(join(directory, 'replacement'), 'replaced');
    renameSync(join(directory, 'replacement'), file);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('s1'));
    changed.mockClear();
    unlinkSync(file);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('s1'));
    changed.mockClear();
    writeFileSync(file, 'recreated');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('s1'));
    watcher.watch(null);
    changed.mockClear();
    writeFileSync(file, 'not watched');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(changed).not.toHaveBeenCalled();
  });

  it('ignores other files and watches only the selected directory', async () => {
    const changed = vi.fn();
    const watcher = plans.createPlanWatcher(changed);
    watchers.push(watcher);
    watcher.watch('s1');
    writeFileSync(join(directory, 'events.jsonl'), 'event');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(changed).not.toHaveBeenCalled();
    const second = join(home, 'session-state', 's2');
    mkdirSync(second);
    watcher.watch('s2');
    writeFileSync(file, 'old session');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(changed).not.toHaveBeenCalled();
    writeFileSync(join(second, 'plan.md'), 'new session');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('s2'));
  });
});
