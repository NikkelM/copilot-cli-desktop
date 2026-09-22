import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { copilotHome } from './paths.js';
import type { CliSetting, CliSettingKind, MergeStrategy } from '../../shared/protocol.js';

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
  // Both say "new interactive sessions" in the schema, and both were measured doing nothing
  // to a session this app made: allow-all left it on manual, which is #199 all over again.
  'defaultMode',
  'defaultPermissionMode',
]);

/** Whole groups of the CLI's terminal chrome, refused by their prefix rather than one by one. */
const TERMINAL_GROUPS = ['footer.', 'sidebar.', 'tabs.', 'statusLine.', 'voice.'];

/**
 * Settings this window has a better control for, in the category they belong to.
 *
 * Not refused because they do nothing - `model` demonstrably works from the CLI's file -
 * but because a model id typed into a text box is a worse way to choose one than the picker
 * that knows what the models are, what they cost and what they can be asked for.
 *
 * The other two are here for the opposite reason, and it is worth writing down: setting
 * `effortLevel` and `contextTier` in the CLI's file leaves a session this app makes with
 * neither. Measured - both were set, and the session's own log recorded
 * `"reasoningEffort":null,"contextTier":null` - so they are the CLI's own, reaching the
 * sessions it starts rather than these, and this app keeps its own pair (#200, #202).
 */
const SHOWN_ELSEWHERE = new Set(['model', 'effortLevel', 'contextTier']);

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
    if (SHOWN_ELSEWHERE.has(path)) continue;

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
  return readJsonObject(cliSettingsFile());
}

/** One settings file's contents, or nothing at all for one that is missing or unreadable. */
function readJsonObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
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
 * Whether the agent is told to sign what it commits as a co-author.
 *
 * The CLI's `includeCoAuthoredBy`, which reads like a git setting and is not one: the
 * runtime turns it into a `<git_commit_trailer>` block in the system prompt, telling the
 * model to add the trailer itself. Nothing rewrites a commit after the fact.
 *
 * It only reaches a session that is told, and the CLI tells the ones its own two front ends
 * start - prompt mode and the terminal. A session made through the SDK is told nothing and
 * falls back to the runtime's own answer, so a reader who had turned the trailer off still
 * got one here (#205).
 *
 * `!== false` rather than `=== true`, which is the CLI's own expression: the setting
 * defaults to on, so only having said no turns it off.
 */
export function coauthorEnabled(): boolean {
  return readCliSettings().includeCoAuthoredBy !== false;
}

/**
 * How a pull should reconcile two branches that have both moved on, for one repository.
 *
 * The CLI's `mergeStrategy`, read the way the CLI reads it: a repository may answer for
 * itself, and its answer wins over the reader's own. `settings.local.json` is the
 * git-ignored one beside it, which is a person's answer for their own checkout, so it wins
 * over the answer the repository ships.
 *
 * Null is a real answer and the common one. The setting has no default - the CLI shows a
 * picker saying "No mergeStrategy configured" rather than choosing - so reporting one
 * nobody set would be inventing the reader's answer for them.
 *
 * The CLI gates a repository's settings on whether the folder is trusted, and this has no
 * trust store to ask. What is read here is a choice between two things the reader has
 * already asked for by pressing Pull, so the most a repository can do with it is pick
 * rebase where they would have picked merge.
 */
export function mergeStrategyFor(gitRoot: string | null): MergeStrategy | null {
  const files = gitRoot
    ? [
        join(gitRoot, '.github', 'copilot', 'settings.local.json'),
        join(gitRoot, '.github', 'copilot', 'settings.json'),
        cliSettingsFile(),
      ]
    : [cliSettingsFile()];

  for (const file of files) {
    const found = readJsonObject(file).mergeStrategy;
    if (found === 'rebase' || found === 'merge') return found;
  }

  return null;
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
