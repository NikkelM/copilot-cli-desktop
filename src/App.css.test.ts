import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What the stylesheet asks for and never provides.
 *
 * `.settings` reached for `var(--panel)`, which is not a colour this app defines, so the
 * settings window had no background at all and the page showed through it.
 *
 * It does not fail at runtime. CSS drops a declaration it cannot understand and carries on
 * looking almost right, which is why it reached a reader rather than a test.
 */

const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8');

describe('custom properties', () => {
  /** `--name:` at the start of a declaration, which is where one is defined. */
  const defined = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]!));

  /**
   * Set from JavaScript rather than in the stylesheet, so absent here on purpose.
   *
   * Listed rather than inferred: a property that is only ever set at runtime is the one
   * case this cannot tell apart from a typo, so each has to be a deliberate entry.
   */
  const fromScript = new Set(['--menu-column']);

  it('defines every one it uses without a fallback', () => {
    // A `var(--x, something)` says what to do when it is absent, so it is not a gap.
    const withoutFallback = [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((match) => match[1]!);
    const missing = [...new Set(withoutFallback)].filter(
      (name) => !defined.has(name) && !fromScript.has(name),
    );

    expect(missing, 'used in App.css but never defined, so the declaration is dropped').toEqual([]);
  });

  it('has properties to check, so this cannot pass by finding nothing', () => {
    expect(defined.size).toBeGreaterThan(20);
    expect([...css.matchAll(/var\(\s*--[\w-]+\s*\)/g)].length).toBeGreaterThan(50);
  });
});

/**
 * The text scale reaches the conversation and nothing else. It cannot be checked by
 * rendering, because jsdom computes no stylesheet - but it can be read, and what it says is
 * the whole of the rule (#139).
 */
describe('how far the text scale reaches', () => {
  /** The declarations inside a rule, given its selector. */
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('is applied where the conversation is drawn', () => {
    const transcript = block('.transcript');

    // Every size the conversation uses, or the ones left out would not follow the rest.
    for (const size of ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl']) {
      expect(transcript, `--font-${size} should follow the text scale`).toContain(`--font-${size}:`);
    }
    expect([...transcript.matchAll(/var\(--text-scale\)/g)]).toHaveLength(9);
  });

  /**
   * The sizes are restated rather than the unit they share being redefined, because a
   * custom property is substituted where it is declared: `--font-md` on the root resolves
   * against the root's values, and a descendant changing what it was built from does not
   * reach back into it.
   */
  it('leaves the rest of the app at the app scale', () => {
    const root = block(':root');

    expect(root).toContain('--text-scale: 1;');
    // The sizes the whole app is drawn from must not mention it, or everything would follow.
    for (const line of root.split('\n').filter((l) => /^\s*--font-\w+:/.test(l))) {
      expect(line, 'a size on the root should not follow the text scale').not.toContain('--text-scale');
    }
  });
});

