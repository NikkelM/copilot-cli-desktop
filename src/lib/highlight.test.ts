import { describe, expect, it } from 'vitest';

import { aliases, languages } from './highlight';

/**
 * These two objects go straight to the highlighter, which asks no questions of them: an
 * alias against a language that is not registered is accepted and then never matches, so
 * the block renders plain and nothing anywhere says why. That is the failure worth catching
 * here, because it only ever appears when someone adds a language.
 */
describe('the grammars a code block may be highlighted as', () => {
  const names = Object.keys(languages);

  it('registers every alias against a language that exists', () => {
    const missing = Object.keys(aliases).filter((name) => !names.includes(name));

    expect(missing).toEqual([]);
  });

  it('claims no alias twice, so no fence has two answers', () => {
    const all = Object.values(aliases).flat();

    expect(all.length).toBe(new Set(all).size);
  });

  /** A grammar answers to its own name already, and an alias shadowing another is a silent swap. */
  it('claims no alias that is already a grammar name', () => {
    const shadowed = Object.values(aliases)
      .flat()
      .filter((alias) => names.includes(alias));

    expect(shadowed).toEqual([]);
  });

  it('names every grammar it registers', () => {
    const unnamed = Object.entries(languages).filter(([, grammar]) => typeof grammar !== 'function');

    expect(unnamed).toEqual([]);
  });

  /**
   * Fences are written in lower case and matched as written, so a capital here would be a
   * grammar nothing can reach.
   */
  it('keeps every name and alias lower case', () => {
    const wrong = [...names, ...Object.values(aliases).flat()].filter((name) => name !== name.toLowerCase());

    expect(wrong).toEqual([]);
  });
});
