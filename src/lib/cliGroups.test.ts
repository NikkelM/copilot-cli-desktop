import { describe, expect, it } from 'vitest';

import { groupCliSettings, leafName } from './cliGroups';
import type { CliSetting } from '../../shared/protocol';

const setting = (path: string): CliSetting => ({ path, kind: 'boolean', description: `About ${path}` });

const shape = (settings: CliSetting[]) =>
  groupCliSettings(settings).map((entry) =>
    entry.kind === 'one' ? entry.setting.path : `${entry.group.prefix}: ${entry.group.settings.map((s) => s.path).join(', ')}`,
  );

describe('gathering the nested settings', () => {
  it('leaves a setting nested in nothing where it is', () => {
    expect(shape([setting('autoUpdate'), setting('memory')])).toEqual(['autoUpdate', 'memory']);
  });

  it('gathers the ones sharing a name under it', () => {
    expect(shape([setting('ide.autoConnect'), setting('ide.openDiffOnEdit')])).toEqual([
      'ide: ide.autoConnect, ide.openDiffOnEdit',
    ]);
  });

  /** A group with one row inside is a row you have to open to see one row. */
  it('leaves a lone nested setting as a row of its own', () => {
    expect(shape([setting('customAgents.defaultLocalOnly')])).toEqual(['customAgents.defaultLocalOnly']);
  });

  /** Nesting a list inside a list inside a list reads worse than one heading. */
  it('gathers by the first name only, however deep the rest goes', () => {
    expect(shape([setting('sandbox.auth.git'), setting('sandbox.userPolicy.network.allowOutbound')])).toEqual([
      'sandbox: sandbox.auth.git, sandbox.userPolicy.network.allowOutbound',
    ]);
  });

  it('keeps groups apart from each other', () => {
    expect(shape([setting('ide.a'), setting('telemetry.a'), setting('ide.b'), setting('telemetry.b')])).toEqual([
      'ide: ide.a, ide.b',
      'telemetry: telemetry.a, telemetry.b',
    ]);
  });

  /** Where its first member was, so the list is not re-sorted on the way past. */
  it('puts a group where the first of it came', () => {
    expect(shape([setting('autoUpdate'), setting('ide.a'), setting('memory'), setting('ide.b')])).toEqual([
      'autoUpdate',
      'ide: ide.a, ide.b',
      'memory',
    ]);
  });

  it('has nothing to gather from nothing', () => {
    expect(groupCliSettings([])).toEqual([]);
  });

  /** A path opening with a dot names nothing, so there is nothing to gather it under. */
  it('does not gather under an empty name', () => {
    expect(shape([setting('.odd'), setting('.strange')])).toEqual(['.odd', '.strange']);
  });
});

describe('what a setting is called inside its group', () => {
  it('drops the name the heading already says', () => {
    expect(leafName('sandbox.enabled', 'sandbox')).toBe('enabled');
  });

  it('keeps the rest of where it lives', () => {
    expect(leafName('sandbox.auth.git', 'sandbox')).toBe('auth.git');
  });

  /** Nothing is dropped from a path that only starts with the same letters. */
  it('leaves a path that is not under it alone', () => {
    expect(leafName('sandboxing', 'sandbox')).toBe('sandboxing');
  });
});
