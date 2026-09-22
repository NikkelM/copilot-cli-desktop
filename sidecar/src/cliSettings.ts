import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { copilotHome } from './paths.js';
import type { CliSetting, CliSettingKind } from '../../shared/protocol.js';

/**
 * The Copilot CLI's own settings, which this app writes directly.
 *
 * They live in `~/.copilot/settings.json`, which is the CLI's file rather than this app's -
 * and deliberately so. A reader looking for a setting does not care which program owns it,
 * and the CLI keeps these in one place for exactly this reason: its own error text tells
 * people to "edit settings.json directly", and its `config.json` opens with "User settings
 * belong in settings.json" (#202).
 *
 * Writing here reaches a running session. Settings are read when a session is created
 * rather than cached when the server starts, so a change made in this window applies to the
 * next session without restarting anything. Verified against a real runtime: `model` set
 * while a server was already up was picked up by the next session on that same server.
 */

/** Every kind the schema uses. Only some of them are a control somebody can be shown. */
const EDITABLE: readonly CliSettingKind[] = ['boolean', 'enum', 'number', 'string'];

/**
 * Settings that only mean something to a terminal.
 *
 * A denylist rather than a list of what to show, so a setting the CLI adds tomorrow appears
 * here without this file being touched. That is the safe default under the rule this
 * follows: these are the CLI's own settings, and writing one configures the reader's CLI
 * whether or not this app has an opinion about it.
 *
 * What is refused is what could only ever draw a terminal. Showing `scrollbar` or
 * `bannerStyle` in a window with neither would be offering a control over nothing.
 */
const TERMINAL_ONLY = new Set([
  'mouse',
  'banner',
  'bannerStyle',
  'showTipsOnStartup',
  'companyAnnouncements',
  'beep',
  'beepOnSchedule',
  'copyOnSelect',
  'compactPaste',
  'shellShortcut',
  'renderMarkdown',
  'renderHexColors',
  'inlineImages',
  'inlineImageLiveWindow',
  'scrollbar',
  'pinnedPrompts',
  'screenReader',
  'theme',
  'editorMode',
  'transcriptView',
  'updateTerminalTitle',
  'terminalProgress',
  // Its own history lives in this app, in this app's own store, so the CLI's size for it
  // would be a number that changes nothing here.
  'commandHistoryMaxSize',
  // Both say "new interactive sessions" in the schema, and both were measured doing nothing
  // to a session this app made: allow-all left it on manual, which is #199 all over again.
  'defaultMode',
  'defaultPermissionMode',
]);

/** Whole groups of the CLI's terminal chrome, refused by their prefix rather than one by one. */
const TERMINAL_GROUPS = ['footer.', 'sidebar.', 'tabs.', 'statusLine.', 'voice.'];

/** Where the CLI keeps what the reader chose. The CLI's file, not this app's. */
export function cliSettingsFile(): string {
  return join(copilotHome, 'settings.json');
}

/**
 * The native runtime the CLI is built around, which carries the settings schema.
 *
 * Found rather than configured: the CLI unpacks itself per version, so the path holds a
 * version this app must not be pinned to. The newest is taken, which is the one a CLI
 * launched now would use.
 *
 * Answering null is a real answer. A reader whose CLI is laid out differently should get a
 * window without this group rather than an error about a file they have never heard of.
 */
export function runtimeBinary(): string | null {
  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'copilot', 'pkg'),
    join(homedir(), '.local', 'share', 'copilot', 'pkg'),
    join(homedir(), 'Library', 'Application Support', 'copilot', 'pkg'),
  ].filter((root) => root && existsSync(root));

  for (const root of roots) {
    for (const platform of readdirSync(root)) {
      const versions = readdirSync(join(root, platform))
        .filter((name) => /^\d/.test(name))
        // Newest first. The CLI keeps every version it has unpacked, so which one is meant
        // is a real question: this machine held five, and the one `copilot --version`
        // reports is the one whose settings a session will read.
        .sort(newestFirst);

      for (const version of versions) {
        const candidate = join(root, platform, version, 'prebuilds', platform, 'runtime.node');
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  return null;
}

/**
 * Newest first, for the version directories the CLI unpacks itself into.
 *
 * Compared as numbers per segment, since 87 is above 9 and "87" is not. A version with a
 * suffix is a build leading up to the one without it - `1.0.87-0` came before `1.0.87` and
 * this machine has both - so the shorter wins where every shared segment matches.
 */
export function newestFirst(a: string, b: string): number {
  const left = a.split(/[.-]/).map(Number);
  const right = b.split(/[.-]/).map(Number);
  const shared = Math.min(left.length, right.length);

  for (let at = 0; at < shared; at += 1) {
    const difference = (right[at] ?? 0) - (left[at] ?? 0);
    if (difference) return difference;
  }

  return left.length - right.length;
}

/** Read once. The file is 90MB, which is 60ms to read and nothing to keep afterwards. */
let held: CliSetting[] | null = null;

/**
 * Every setting the CLI knows about, as the CLI describes it.
 *
 * Read from the runtime rather than kept here, so this cannot go stale against the CLI the
 * reader actually has: a setting added by an update appears without this app being rebuilt,
 * and one that is removed stops being offered.
 *
 * The whole file is read rather than streamed. It is 90MB, which sounds like a reason to
 * stream it - but streaming measured slower (107ms against 61ms) and held more, because the
 * chunks are strings this process keeps while the file itself is one the platform can map.
 */
export function cliSettingsSchema(): CliSetting[] {
  if (held) return held;

  const binary = runtimeBinary();
  if (!binary) return (held = []);

  let text: string;
  try {
    // Latin-1 rather than UTF-8: this is a binary, and decoding it as text would replace
    // bytes that are not characters, which can eat the delimiters being matched on.
    text = readFileSync(binary, 'latin1');
  } catch {
    return (held = []);
  }

  const found = new Map<string, CliSetting>();
  for (const match of text.matchAll(/\{"path":"[^"]+","leafKind":"[^"]+"[^}]*\}/g)) {
    let parsed: Partial<CliSetting> & { leafKind?: string };
    try {
      parsed = JSON.parse(match[0]) as Partial<CliSetting> & { leafKind?: string };
    } catch {
      continue;
    }

    const path = parsed.path;
    const kind = parsed.leafKind as CliSettingKind | undefined;
    if (!path || !kind || found.has(path)) continue;
    if (!EDITABLE.includes(kind)) continue;
    if (TERMINAL_ONLY.has(path) || TERMINAL_GROUPS.some((group) => path.startsWith(group))) continue;

    found.set(path, {
      path,
      kind,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      ...(parsed.options ? { options: parsed.options } : {}),
    });
  }

  return (held = [...found.values()].sort((a, b) => a.path.localeCompare(b.path)));
}

/**
 * What the CLI is set to, or nothing where the reader has never said.
 *
 * Absent is not the same as false: a fresh install has an empty file and the CLI falls back
 * to the defaults in its own schema, which are not written down anywhere this can read. So
 * an unset setting is reported as unset rather than as a value nobody chose.
 */
export function readCliSettings(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cliSettingsFile(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // No file is what a fresh install looks like, and an unreadable one is not this app's
    // to repair - refusing to write over it is what matters, and that is below.
    return {};
  }
}

/**
 * Change some of the CLI's settings, leaving the rest of its file alone.
 *
 * Merged rather than replaced, and refused outright when what is there cannot be read: the
 * file is the CLI's, it holds things this app never shows - enabled plugins, MCP servers -
 * and overwriting it with only what this window knows about would throw those away. The
 * runtime takes the same position, refusing to update a settings file it cannot parse.
 *
 * Undefined removes a key rather than writing it, so going back to the CLI's own default is
 * possible at all: there is no value to write that means "whatever you would have done".
 */
export function writeCliSettings(changes: Record<string, unknown>): void {
  const file = cliSettingsFile();
  let current: Record<string, unknown> = {};

  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} does not hold an object, so it was left alone`);
    }
    current = parsed as Record<string, unknown>;
  }

  for (const [path, value] of Object.entries(changes)) {
    if (value === undefined) delete current[path];
    else current[path] = value;
  }

  // Two spaces and a trailing newline, which is what the CLI writes, so a file this app
  // touched does not show up as rewritten wholesale in a diff.
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}
