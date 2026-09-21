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

