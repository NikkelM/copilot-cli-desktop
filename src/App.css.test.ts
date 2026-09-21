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

    /**
     * And the size inherited by everything that names none, which is most of a reply. With
     * only the sizes above, the tool rows and the code blocks grew and the reading did not.
     */
    expect(transcript, 'the transcript should set the size its content inherits').toMatch(
      /font-size:\s*calc\(var\(--font-base\) \* var\(--text-scale\)\)/,
    );

    // Nine named sizes and the inherited one.
    expect([...transcript.matchAll(/var\(--text-scale\)/g)]).toHaveLength(10);
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



/**
 * A menu opened inside a window belongs over that window.
 *
 * Nothing about this fails: both are drawn, one on top of the other, and which one wins is
 * a number in a file neither of them mentions. The model list opened behind the settings
 * window that way, and it can only be read here, since jsdom computes no stylesheet.
 */
describe('what a floating menu sits over', () => {
  const layer = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    const found = /z-index:\s*(\d+)/.exec(css.slice(at, css.indexOf('\n}', at)));
    expect(found, `${selector} should name a layer`).not.toBeNull();
    return Number(found![1]);
  };

  it('is above every window it can be opened from', () => {
    // Each rule that claims a layer of its own, so a new one cannot quietly go over the top.
    const claimed = [...css.matchAll(/^(\.[\w-]+)[^{]*\{[^}]*?z-index:\s*(\d+)/gms)]
      .map((match) => [match[1]!, Number(match[2])] as const)
      .filter(([selector]) => selector !== '.floating');

    const highest = Math.max(...claimed.map(([, value]) => value));
    expect(claimed.length, 'nothing to compare against').toBeGreaterThan(5);
    expect(layer('.floating'), 'a menu should be over everything it can be opened from').toBeGreaterThan(
      highest,
    );
  });

  /**
   * The placing measures with getBoundingClientRect, which answers in viewport coordinates.
   * Only a fixed box reads a top and a right the same way: an absolute one is placed against
   * the page, so the menu would drift as soon as anything scrolled.
   */
  it('is placed against the viewport, which is what the placing measures', () => {
    const at = css.indexOf('.floating {');
    expect(css.slice(at, css.indexOf('\n}', at))).toContain('position: fixed;');
  });
});
