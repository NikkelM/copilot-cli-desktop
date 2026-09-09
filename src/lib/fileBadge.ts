/**
 * The CLI's own table, verbatim.
 *
 * The labels are not abbreviations of the extension so much as of the language - `tsx` is
 * TX rather than TS so it can be told apart from `ts` at a glance, and `json` is `{}`.
 */
const FROM_CLI: Record<string, { label: string; tone: Tone }> = {
  ts: { label: 'TS', tone: 'blue' },
  mts: { label: 'TS', tone: 'blue' },
  cts: { label: 'TS', tone: 'blue' },
  tsx: { label: 'TX', tone: 'blue' },
  js: { label: 'JS', tone: 'yellow' },
  mjs: { label: 'JS', tone: 'yellow' },
  cjs: { label: 'JS', tone: 'yellow' },
  jsx: { label: 'JX', tone: 'yellow' },
  json: { label: '{}', tone: 'green' },
  md: { label: 'MD', tone: 'gray' },
  mdx: { label: 'MX', tone: 'gray' },
  rs: { label: 'RS', tone: 'red' },
  py: { label: 'PY', tone: 'cyan' },
  go: { label: 'GO', tone: 'cyan' },
  rb: { label: 'RB', tone: 'red' },
  java: { label: 'JV', tone: 'red' },
  c: { label: 'C', tone: 'cyan' },
  h: { label: 'H', tone: 'cyan' },
  cpp: { label: 'C+', tone: 'cyan' },
  cc: { label: 'C+', tone: 'cyan' },
  cs: { label: 'C#', tone: 'green' },
  sh: { label: 'SH', tone: 'gray' },
  bash: { label: 'SH', tone: 'gray' },
  yaml: { label: 'YM', tone: 'gray' },
  yml: { label: 'YM', tone: 'gray' },
  toml: { label: 'TM', tone: 'gray' },
  html: { label: 'HT', tone: 'yellow' },
  css: { label: 'SS', tone: 'cyan' },
  scss: { label: 'SS', tone: 'cyan' },
  sql: { label: 'SQ', tone: 'green' },
};

/**
 * What the CLI's table misses, kept apart from it so parity stays checkable.
 *
 * Two kinds only, so this does not turn into a list of every extension in existence.
 * Siblings first: another spelling of something already listed, where leaving it out looks
 * like an oversight rather than a decision. Then the types that actually turn up in real
 * sessions here - counted from the file paths in every rewind snapshot on this machine,
 * where xml, lua, svg, astro, ps1 and hpp were the ones with no badge to show.
 */
const ADDED: Record<string, { label: string; tone: Tone }> = {
  markdown: { label: 'MD', tone: 'gray' },
  jsonc: { label: '{}', tone: 'green' },
  json5: { label: '{}', tone: 'green' },
  zsh: { label: 'SH', tone: 'gray' },
  fish: { label: 'SH', tone: 'gray' },
  htm: { label: 'HT', tone: 'yellow' },
  sass: { label: 'SS', tone: 'cyan' },
  less: { label: 'LS', tone: 'cyan' },
  cxx: { label: 'C+', tone: 'cyan' },
  hpp: { label: 'H', tone: 'cyan' },
  hxx: { label: 'H', tone: 'cyan' },

  xml: { label: 'XM', tone: 'gray' },
  svg: { label: 'SV', tone: 'gray' },
  lua: { label: 'LU', tone: 'blue' },
  ps1: { label: 'PS', tone: 'blue' },
  astro: { label: 'AS', tone: 'yellow' },
};

/**
 * Only the extensions above are here. An unlisted one gets no badge rather than a guess: a
 * made-up mark is worse than none, because the reader cannot tell which is which.
 */
const BADGES: Record<string, { label: string; tone: Tone }> = { ...FROM_CLI, ...ADDED };

export type Tone = 'blue' | 'yellow' | 'green' | 'gray' | 'red' | 'cyan';

export interface FileBadge {
  label: string;
  tone: Tone;
}

/**
 * Look up the badge for a path, or null if there is none for it.
 *
 * Splits on both separators rather than using a path module, because the path comes from
 * whichever machine the session ran on and may not use this one's. A leading dot is not an
 * extension, so `.gitignore` gets nothing rather than being read as a `gitignore` file.
 */
export function fileBadge(path: string): FileBadge | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return BADGES[name.slice(dot + 1).toLowerCase()] ?? null;
}
