import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * The languages a code block may be highlighted as.
 *
 * Named one by one rather than taking the highlighter's usual bundle: that carries every
 * grammar it knows, which is most of the weight for languages this app will never show.
 * Anything absent from here renders plain, which is the right answer for a language nobody
 * here writes and a far better one than guessing.
 */
export const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  lua,
  markdown,
  powershell,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

/**
 * The names a fence is actually written with.
 *
 * A reply opens a block with whatever the language is usually called - ```ts, ```sh, ```yml -
 * and those are not the grammars' own names. Without these the block would fall back to
 * plain for no reason a reader could see.
 */
export const aliases = {
  bash: ['sh', 'shell', 'zsh', 'console'],
  cpp: ['c++', 'cc', 'h', 'hpp'],
  csharp: ['cs', 'c#'],
  diff: ['patch'],
  go: ['golang'],
  ini: ['toml'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  json: ['jsonc', 'json5'],
  markdown: ['md'],
  powershell: ['ps', 'ps1', 'pwsh'],
  python: ['py'],
  rust: ['rs'],
  typescript: ['ts', 'tsx'],
  xml: ['html', 'svg', 'xhtml'],
  yaml: ['yml'],
};
