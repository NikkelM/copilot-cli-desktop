import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every component file, which is everywhere a class name is written in this app.
 *
 * The directory comes from `fileURLToPath` rather than from the URL's own pathname, which
 * is not a path on either platform: it keeps a leading slash before a Windows drive letter,
 * and stripping that by hand turns an absolute Linux path into a relative one. That is
 * exactly what happened - green here and ENOENT on the build machine.
 */
function sources(dir = fileURLToPath(new URL('.', import.meta.url))): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) found.push(path);
  }
  return found;
}

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

describe('shared form control styling', () => {
  it('uses the same button font for Prompts as Todos and Plan', () => {
    for (const selector of ['.prompts-current {', '.header-button {']) {
      const at = css.indexOf(`\n${selector}`);
      expect(at).toBeGreaterThan(-1);
      const rule = css.slice(at, css.indexOf('\n}', at));
      expect(rule).toContain('font-size: var(--font-sm);');
      expect(rule).not.toMatch(/\bfont(?:-family)?:/);
    }
  });

  it('centres reorder handles against the entire sidebar row without overlapping content', () => {
    const at = css.indexOf('.session-drag {');
    const rule = css.slice(at, css.indexOf('\n}', at));
    expect(rule).toContain('position: absolute;');
    expect(rule).toContain('top: 50%;');
    expect(rule).toContain('transform: translateY(-50%);');
    const row = css.indexOf('.session-row {');
    const rowRule = css.slice(row, css.indexOf('\n}', row));
    expect(rowRule).toContain('position: relative;');
    expect(rowRule).toContain('padding-left: 10px;');
    expect(css).not.toContain('.session-row:has(.session-drag)');
  });

  it('distinguishes prominent settings fields from compact toolbar dropdowns', () => {
    const at = css.indexOf('.app-dropdown.field {');
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf('\n}', at));
    expect(rule).toContain('padding: 6px 10px;');
    expect(rule).toContain('color: var(--text);');
    expect(rule).toContain('font-size: var(--font-md);');
    expect(css).toContain('.app-dropdown-menu.field .app-dropdown-option {');
  });

  it('separates the custom application button from its note and aligns checkbox ink with labels', () => {
    const at = css.indexOf('.directory-applications > button {');
    expect(css.slice(at, css.indexOf('\n}', at))).toContain('margin-bottom: 12px;');
    const tick = css.indexOf('.tick-row .tickbox {');
    expect(css.slice(tick, css.indexOf('\n}', tick))).toContain('transform: translateY(2px);');
  });

  it('customizes every checkbox rather than only those wrapped in tickbox', () => {
    for (const selector of [
      "input[type='checkbox']", "input[type='checkbox']:checked",
      "input[type='checkbox']:indeterminate", "input[type='checkbox']:disabled",
      "input[type='checkbox']:focus-visible",
    ]) expect(css).toContain(`${selector} {`);
    const start = css.search(/^input\[type='checkbox'\] \{/m);
    expect(css.slice(start, css.indexOf('\n}', start))).toContain('appearance: none;');
    expect(css).toContain('data:image/svg+xml');
  });

  it('leaves no native select dropdowns in production components', () => {
    const native = sources().filter((file) => /<select\b/.test(readFileSync(file, 'utf8')));
    expect(native).toEqual([]);
  });
});

describe('disk usage action styling', () => {
  it('draws visible button borders and a disabled state rather than bare reset links', () => {
    const at = css.search(/\.disk-action,\s*\.mcp-action \{/);
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf('\n}', at));
    expect(rule).toContain('border: 1px solid var(--border);');
    expect(rule).toContain('border-radius: 5px;');
    expect(rule).toContain('padding: 1px 7px;');
    expect(css).toMatch(/\.disk-action:disabled,\s*\.mcp-action:disabled \{/);
    expect(css).toContain('.disk-action.destructive {');
  });
});

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


/**
 * The price block above the model list never changes height.
 *
 * It says one of three things - three prices, a line saying there are none, or a line
 * asking the reader to point at something - and the list sits directly under it, so a
 * block that grew and shrank would shunt the rows out from under the pointer that moved it.
 *
 * It was a fixed pixel height before, which held until the text scale moved and until a
 * model with a long name wrapped the heading onto a second line.
 */
describe('the price block above the model list', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('reserves a row for every price whether or not there is one', () => {
    const rule = block('.model-prices');

    expect(rule, 'the rows should be reserved rather than measured').toMatch(
      /grid-template-rows:\s*auto repeat\(3,/,
    );
    // In the size of the text, so the block follows the scale the way its contents do.
    expect(rule).toContain('var(--font-sm)');
    expect(rule, 'a height in pixels does not follow the text scale').not.toMatch(/height:\s*\d+px/);
  });

  it('keeps the heading to one line however long the name is', () => {
    expect(block('.model-prices-head')).toContain('white-space: nowrap;');
  });

  it('spends the reserved rows when there is no price to put in them', () => {
    expect(block('.model-price.wide')).toContain('grid-row: span 3;');
  });
});


/**
 * A button that cannot be pressed says so.
 *
 * Disabling one is enough to stop it working and does nothing to how it looks, so Save sat
 * there fully lit with nothing to save for as long as it had been disabled.
 */
describe('a button with nothing to do', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('is drawn as one that cannot be pressed', () => {
    const rule = block('.confirm-actions button:disabled');

    expect(rule).toMatch(/opacity:\s*0?\.\d+/);
    expect(rule).toContain('cursor: default;');
  });

  it('does not light up under the pointer', () => {
    // A hover that still answered would undo the saying-so above.
    expect(css).toContain('.confirm-cancel:hover:not(:disabled) {');
  });
});


/**
 * Every button in a window answers the pointer.
 *
 * The one that goes through wears no class of its own, so a rule written for the others
 * left it the only button in any of these windows that did not move when pointed at.
 */
describe('how a window button answers the pointer', () => {
  it('fills the one that goes through', () => {
    const at = css.indexOf('.confirm-actions button:not(.confirm-cancel):not(.confirm-go):hover:not(:disabled) {');
    expect(at, 'the button that goes through should have a hover of its own').toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf('\n}', at))).toContain('background: var(--accent);');
  });
});

/**
 * The rows at the foot of the menu are drawn like every other row in it.
 *
 * They were set apart with a border of their own and the padding to clear it, which made
 * them taller than their neighbours and gave them square corners the moment they were
 * pointed at.
 */
describe('the rows that take a session off the list', () => {
  const rule = (() => {
    const at = css.indexOf('.session-menu-item.apart {');
    expect(at, 'the row drawn apart should be in the stylesheet').toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  })();

  it('keeps the shape of the rows around it', () => {
    expect(rule, 'a radius of its own gives it corners the others do not have').not.toContain('border-radius');
    expect(rule, 'padding of its own makes it taller than the others').not.toContain('padding');
  });

  it('is separated by a line beside it rather than one on it', () => {
    expect(rule, 'a border is part of the row, so the fill runs into it').not.toContain('border-top');
    expect(css).toContain('.session-menu-item.apart::before {');
  });

  /**
   * Archiving is undone by pressing again and deleting is not, so they are not the same
   * colour. Drawing archive in the delete red would say the two cost the same.
   */
  it('colours putting a session away apart from destroying it', () => {
    const caution = css.indexOf('.session-menu-item.caution {');
    const danger = css.indexOf('.session-menu-item.danger {');
    expect(caution, 'the lesser of the two should have a colour').toBeGreaterThan(-1);
    expect(danger, 'the one that cannot be undone should have a colour').toBeGreaterThan(-1);

    expect(css.slice(caution, css.indexOf('\n}', caution))).toContain('var(--warning)');
    expect(css.slice(danger, css.indexOf('\n}', danger))).toContain('var(--danger)');
  });
});



/**
 * Every class name put on an element is one the stylesheet answers.
 *
 * The settings window shipped with `.icon-button` on a button and no rule of that name
 * anywhere, so the gear came out as the browser's own grey chrome. Nothing failed: a class
 * that matches no rule is not an error, it is an element with no styles, and the only way
 * to notice was to look at it.
 *
 * This was written once before and removed. Seven names were set on elements and never
 * styled at the time, and a guard that needs an allowlist to pass is not guarding anything.
 * Those were markers rather than styles and have since been taken off, so the rule can be
 * the plain one: if it is worth naming, it is worth a rule (#198).
 */
/**
 * Where the keyboard is has to be visible, which means beating whatever else paints the row.
 *
 * A row that is open, current or hovered sets its own background, and several of those are
 * two or three classes deep. The cursor wash was declared near the top of the file, where a
 * tie on specificity is lost on order and a deeper selector is lost outright - so an open
 * file row, a current branch and an open tool call all showed no cursor at all.
 *
 * Checked as a rule rather than by eye, because nothing about the symptom points at the
 * cascade: the row simply looks unfocused.
 */
describe('the cursor wash', () => {
  /** The stylesheet without its comments, which otherwise contain braces and selectors. */
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

  /** Every `selector { ... }` in the file, in the order they are written. */
  const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match, order) => ({
    order,
    selectors: match[1]!.split(',').map((one) => one.trim()),
    body: match[2]!,
  }));

  const washes = rules.filter((rule) => rule.body.includes('var(--cursor-wash)'));

  /**
   * How hard a selector is to beat, counted as classes, attributes and pseudo-classes.
   *
   * Crude on purpose: no selector in this file uses an id, and the rest of CSS specificity
   * does not come up. Enough to tell `.tool.open .tool-head` from `.tool-head:focus`.
   */
  const weight = (selector: string) =>
    (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?!\()/g) ?? []).filter((part) => !part.startsWith('::')).length;

  it('is drawn somewhere, so this cannot pass by finding nothing', () => {
    expect(washes.flatMap((rule) => rule.selectors).length).toBeGreaterThan(8);
  });

  it('beats everything else that paints the rows it washes', () => {
    /*
     * Hover is left out. It says where the pointer is, which is a different question from
     * where the keyboard is, and the pointer being on the row is reason enough to show it.
     * What matters here is the states that persist: open, current, selected.
     */
    const painted = rules.filter(
      (rule) =>
        !washes.includes(rule) &&
        /(^|[^-])background\s*:/.test(rule.body) &&
        !rule.selectors.every((one) => one.includes(':hover')),
    );

    const beaten = washes.flatMap((wash) =>
      wash.selectors.flatMap((selector) => {
        // The class the cursor is on, which is the last one named before the pseudo-class.
        const row = selector.replace(/:[\w-]+$/, '').match(/\.[\w-]+$/)?.[0];
        if (!row) return [];

        // What this row is washed by, at its strongest: another selector in the same rule
        // may cover the deeper case, as the open tool call needs one of its own.
        const cover = washes
          .flatMap((rule) => rule.selectors.map((one) => ({ one, order: rule.order })))
          .filter(({ one }) => one.includes(row));

        return painted
          .flatMap((rule) => rule.selectors.map((one) => ({ one, order: rule.order })))
          .filter(({ one }) => one.includes(row) && !one.includes(':hover'))
          .filter(
            (paint) =>
              !cover.some(
                (by) => weight(by.one) > weight(paint.one) || (weight(by.one) === weight(paint.one) && by.order > paint.order),
              ),
          )
          .map(({ one }) => `${one} outranks ${selector}`);
      }),
    );

    expect([...new Set(beaten)], 'these paint over the cursor, so the row looks unfocused').toEqual([]);
  });
});

describe('class names', () => {  /** Every `.name` the stylesheet mentions, wherever in a selector it appears. */
  const styled = new Set(
    [...css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]!),
  );

  /** Where a balanced `{...}` ends, given where it starts. Quotes inside are stepped over. */
  function closes(source: string, from: number): number {
    let depth = 0;
    for (let at = from; at < source.length; at += 1) {
      const char = source[at]!;
      if (char === '"' || char === "'" || char === '`') {
        at = ends(source, at);
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}' && (depth -= 1) === 0) return at;
    }
    return source.length;
  }

  /** Where the string opening at `from` ends, stepping over escapes and interpolations. */
  function ends(source: string, from: number): number {
    const quote = source[from]!;
    for (let at = from + 1; at < source.length; at += 1) {
      if (source[at] === '\\') at += 1;
      else if (quote === '`' && source[at] === '$' && source[at + 1] === '{') at = closes(source, at + 1);
      else if (source[at] === quote) return at;
    }
    return source.length;
  }

  /**
   * The text of every string in a fragment, interpolations dropped but looked inside.
   *
   * `` `row ${chosen ? 'is-open' : ''}` `` names two classes and one expression, and taking
   * the fragment apart is the only way to get the first and third without the second.
   *
   * A name that runs into an interpolation is joined back to what comes out of it, since
   * `` `activity-${state}` `` is a name built in two halves rather than one called
   * `activity-`. Where the value is not a literal - a plain variable - the name cannot be
   * known here, and half of one is not offered in its place.
   */
  function literals(source: string): string[] {
    const found: string[] = [];
    for (let at = 0; at < source.length; at += 1) {
      const quote = source[at]!;
      if (quote !== '"' && quote !== "'" && quote !== '`') continue;

      const stop = ends(source, at);
      let text = '';
      for (let scan = at + 1; scan < stop; scan += 1) {
        if (source[scan] === '\\') scan += 1;
        else if (quote === '`' && source[scan] === '$' && source[scan + 1] === '{') {
          const inner = closes(source, scan + 1);
          const parts = literals(source.slice(scan + 2, inner));
          const joins = /\S$/.test(text);
          // Glued to what came before it, so `a-${x}` is one name and `a ${x}` is two.
          if (joins) {
            const stem = text.slice(text.lastIndexOf(' ') + 1);
            text = text.slice(0, text.lastIndexOf(' ') + 1);
            // Nothing literal came out of the interpolation - a plain variable - so only
            // the family can be checked: some rule must be named for this stem, even
            // though which of them this will be cannot be known from here.
            found.push(...(parts.length > 0 ? parts.map((part) => stem + part) : [`${stem}*`]));
          } else found.push(...parts);
          text += ' ';
          scan = inner;
        } else text += source[scan];
      }
      found.push(text);
      at = stop;
    }
    return found;
  }

  /**
   * Every class name written into JSX, and the file it was written in.
   *
   * Read from the source rather than by rendering, which would mean driving every component
   * into every state it has. Only literals are collected: a name built from a value at
   * runtime cannot be checked here, and missing one is better than inventing one.
   */
  const used = new Map<string, string>();
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8');
    for (const found of text.matchAll(/className=/g)) {
      const at = found.index! + found[0].length;
      const fragment = text[at] === '{' ? text.slice(at + 1, closes(text, at)) : text.slice(at, ends(text, at) + 1);
      for (const literal of literals(fragment)) {
        for (const name of literal.split(/\s+/)) if (name) used.set(name, file.split(/[\\/]/).pop()!);
      }
    }
  }

  it('styles every one it sets on an element', () => {
    // A trailing star is a family rather than a name: `activity-${state}` cannot say which
    // of its rules it will want, only that the stylesheet should have some.
    const missing = ([name]: [string, string]) =>
      name.endsWith('*')
        ? ![...styled].some((known) => known.startsWith(name.slice(0, -1)))
        : !styled.has(name);
    const unstyled = [...used].filter(missing).map(([name, file]) => `${name} in ${file}`);

    expect(unstyled, 'set on an element but never styled, so the element has none').toEqual([]);
  });

  it('has names to check, so this cannot pass by finding nothing', () => {
    expect(used.size).toBeGreaterThan(100);
    expect(styled.size).toBeGreaterThan(100);
  });
});


/**
 * A settings category longer than the window can scroll.
 *
 * A grid item will not shrink below its content without being told to, so the column
 * holding the categories grew past the window it sits in and the part meant to scroll never
 * had a height to fill. Nothing failed: with little in a category it looked right, and it
 * only showed once one held more than would fit (#202).
 */
describe('a category that does not fit', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('lets the column shrink to the window it sits in', () => {
    expect(block('.settings-main'), 'a grid item will not shrink below its content').toContain('min-height: 0;');
  });

  it('scrolls the settings rather than the window around them', () => {
    const body = block('.settings-body');

    expect(body).toContain('overflow-y: auto;');
    // Without this the flex item does the same thing one level further in.
    expect(body).toContain('min-height: 0;');
  });

  /**
   * Every control sits at the right-hand end of its row, which is where the scrollbar is.
   * Reserved whether or not one is showing, so moving between a category that scrolls and
   * one that does not leaves the controls where they were.
   */
  it('keeps the controls clear of the scrollbar', () => {
    const body = block('.settings-body');

    expect(body).toMatch(/padding-right:\s*\d+px/);
    expect(body).toContain('scrollbar-gutter: stable;');
  });
});

/**
 * A group of nested CLI settings is one box, and opening it must not move the heading.
 *
 * The same trap the delete row fell into: a border on the row itself makes it a pixel
 * taller than the rows around it, so the heading shifted every time it was opened. The line
 * belongs to what was opened rather than to what opened it.
 */
describe('a group of nested CLI settings', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('is drawn as one box around the heading and what it holds', () => {
    expect(block('.cli-group')).toMatch(/border:\s*1px solid var\(--border\)/);
  });

  it('draws the line under the heading on what the heading opened', () => {
    expect(block('.cli-group-body')).toMatch(/border-top:\s*1px solid var\(--border\)/);
  });

  it('does not put that line on the heading, which would move it on opening', () => {
    expect(block('.cli-group-head'), 'a border here changes the height between shut and open').not.toContain(
      'border-bottom',
    );
  });

  /** Or the hover fill would round away from the line it runs into. */
  it('squares the heading where it meets what it opened', () => {
    expect(block(".cli-group-head[aria-expanded='true']")).toContain('border-radius: 8px 8px 0 0;');
  });
});
/**
 * A section heading has to read as the start of a group rather than as one more setting.
 *
 * Twice now it has been set one step above the names under it, which on this scale is about
 * a pixel and invisible. Guarded as a hierarchy rather than as exact sizes, so the three can
 * all move together without this having an opinion about where they land.
 */
describe('the settings headings', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  const SCALE = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'];
  const step = (selector: string) => {
    const rule = block(selector);
    const at = SCALE.findIndex((name) => rule.includes(`font-size: var(--font-${name})`));
    expect(at, `${selector} should take a size from the scale`).toBeGreaterThan(-1);
    return at;
  };

  it('sets a section heading well clear of the names under it', () => {
    expect(
      step('.settings-subhead') - step('.settings-label'),
      'one step apart is about a pixel, which is why this was raised twice',
    ).toBeGreaterThanOrEqual(2);
  });

  it('keeps the category name above the sections inside it', () => {
    expect(step('.settings-head h3')).toBeGreaterThan(step('.settings-subhead'));
  });

  /** The line is what says a section started, so it belongs to every one after the first. */
  it('divides each section from the one before it', () => {
    expect(block('.settings-subhead')).toMatch(/border-top:\s*1px solid var\(--border\)/);
    expect(block('.settings-body > .settings-subhead:first-child')).toContain('border-top: none;');
  });
});

describe('update settings actions', () => {
  const block = (selector: string) => {
    const at = css.indexOf(selector);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('gives the update and Debug action rows real flex spacing', () => {
    const actions = block('.app-update-actions,');
    expect(actions).toContain('display: flex;');
    expect(actions).toContain('gap: 12px;');
  });

  it('makes update buttons larger than the compact shared disk action', () => {
    const actions = block('.app-update-actions .disk-action,');
    expect(actions).toContain('min-height: 34px;');
    expect(actions).toContain('padding: 6px 12px;');
    expect(actions).toContain('font-size: var(--font-md);');
  });

  it('leaves space between the primary update actions and the ready note', () => {
    expect(block('.app-update-actions {')).toContain('margin: 18px 0 16px;');
    expect(block('.app-update-ready-note {')).toContain('margin-top: 4px;');
  });
});
/**
 * The controls on an MCP row sit beside what they act on.
 *
 * Elsewhere in these lists a long description takes the room that is left and the toggle is
 * pushed to the end. A server's url is short, so the same rule left the controls stranded
 * across an empty half of the window (#24).
 */
describe('the MCP server rows', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('stops pushing the toggle to the far edge', () => {
    expect(block('.mcp-row .environment-toggle')).toContain('margin-left: 0;');
  });

  it('lets the url stop growing, so it does not push them either', () => {
    expect(block('.mcp-row .environment-description')).toContain('flex: 0 1 auto;');
  });

  /**
   * They borrowed `settings-reset`, which is a bare link in the settings window and reads
   * as unstyled text out here. Drawn like the toggle beside them instead.
   */
  it('draws its buttons like the toggle beside them', () => {
    const rule = block('.mcp-action');

    expect(rule).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(rule).toContain('border-radius:');
  });

  it('greys out a button with nothing to do', () => {
    expect(block('.mcp-action:disabled')).toContain('opacity:');
  });
});
/**
 * The buttons on one row are all the same height.
 *
 * The toggle took the browser's own font for buttons while the ones beside it took the
 * app's, and the two carry different line heights - so a row of controls that should have
 * been level was a pixel out (#24).
 */
describe('the controls on a row', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('gives every one of them the same font to measure against', () => {
    for (const selector of ['.environment-toggle', '.mcp-action']) {
      expect(block(selector), `${selector} should take the app's font`).toContain('font: inherit;');
    }
  });

  /** Without it the next section starts immediately under the button. */
  it('keeps the add button clear of what follows it', () => {
    const rule = block('.mcp-add');
    const margin = /margin:\s*[\d.]+\w*\s+[\d.]+\w*\s+([\d.]+)/.exec(rule);

    expect(margin, 'the add button should set a margin on all four sides').toBeTruthy();
    expect(Number(margin![1]), 'it needs room below it').toBeGreaterThan(0);
  });
});

/**
 * The branch indicator opens the same picker the source control panel does (#102), so the
 * two sit in different type: the header is monospace and the panel is a heading with
 * letter-spacing. The menu has to read the same from either.
 */
describe('the branch picker', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('states its own type rather than taking the monospace it drops out of', () => {
    const rule = block('.repo-branch-menu');
    expect(rule, 'the menu should name a font family').toContain('font-family:');
    expect(rule, 'and it should not be the monospace of the path').not.toContain('ui-monospace');
  });

  /** The caret is the only thing saying the branch opens rather than navigates. */
  it('lays the header indicator out as a row, so the caret sits beside the name', () => {
    const rule = block('.branch.link');
    expect(rule).toContain('inline-flex');
    expect(rule, 'the caret should line up with the name').toContain('align-items: center;');
  });

  it('positions the menu against the control it drops out of', () => {
    expect(block('.repo-branches'), 'the wrapper anchors the menu').toContain('position: relative;');
    expect(block('.repo-branch-menu'), 'the menu hangs off it').toContain('position: absolute;');
  });
});

/**
 * The row a search result landed on. It is drawn flat: a translucent glow around it was
 * tried and read as ragged, because a shadow is drawn outside the row and laid a second
 * layer over whatever tint it reached (#30).
 */
describe('the row a search landed on', () => {
  const rule = () => {
    const at = css.indexOf('.entry.found {');
    expect(at, '.entry.found should be in the stylesheet').toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('is tinted rather than haloed', () => {
    expect(rule()).toContain('background:');
    expect(rule(), 'a shadow around it stacks with what it overlaps').not.toContain('box-shadow');
  });

  // An outline is drawn outside the box, so nothing on the page moves when it appears.
  it('is outlined in a way that moves nothing', () => {
    expect(rule()).toContain('outline:');
    expect(rule(), 'a border would widen the row').not.toMatch(/\bborder:/);
  });
});

/**
 * A marked row is drawn wider than its own text, which needs room inside the list. The room
 * is made by padding the list and pulling it back by the same amount, so the text stays
 * where it was and nothing can spill past it into a scrollbar.
 */
describe('room for a row to be drawn around', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  const sides = (rule: string, property: string) => {
    const shorthand = new RegExp(`${property}:\\s*([^;]+);`).exec(rule)?.[1]?.trim().split(/\s+/) ?? [];
    const left = new RegExp(`${property}-left:\\s*(-?[\\d.]+)px`).exec(rule)?.[1];
    const right = new RegExp(`${property}-right:\\s*(-?[\\d.]+)px`).exec(rule)?.[1];
    const fromShorthand = shorthand.length >= 2 ? shorthand[1] : shorthand[0];
    return {
      left: Number((left ?? (shorthand.length === 4 ? shorthand[3] : fromShorthand))?.replace('px', '')),
      right: Number((right ?? fromShorthand)?.replace('px', '')),
    };
  };

  it('pads a row and pulls it back by the same amount, so no text moves', () => {
    const rule = block('.entry');
    const padding = sides(rule, 'padding');
    const margin = sides(rule, 'margin');

    expect(padding.left, 'a row is padded').toBeGreaterThan(0);
    expect(margin.left, 'and pulled back by what it was padded').toBe(-padding.left);
    expect(margin.right).toBe(-padding.right);
  });

  it('gives the list the room the rows reach into', () => {
    const rule = block('.transcript');
    const padding = sides(rule, 'padding');
    const entry = sides(block('.entry'), 'padding');

    expect(padding.left, 'or a marked row would overflow the list').toBeGreaterThanOrEqual(entry.left);
    expect(padding.right).toBeGreaterThanOrEqual(entry.right);
  });
});

/**
 * A marked row reaches past its own text on every side. At the sides it reaches into padding
 * the list keeps for it and is pulled back by what it took; above and below there is nothing
 * to reach into but its neighbours, so it makes room rather than covering them.
 */
describe('a marked row reaching past its text', () => {
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  const box = (selector: string, property: string) => {
    const parts = new RegExp(`\\n\\s+${property}:\\s*([^;]+);`).exec(rule(selector))?.[1]?.trim().split(/\s+/);
    expect(parts, `${selector} should set ${property}`).toBeTruthy();
    const value = (at: number) => Number(parts![at]!.replace('px', ''));
    return { vertical: value(0), horizontal: parts!.length > 1 ? value(1) : value(0) };
  };

  it('makes room above and below rather than covering what is there', () => {
    const plain = box('.entry', 'padding');
    const marked = box('.entry.found', 'padding');
    const room = box('.entry.found', 'margin').vertical;
    const offset = Number(/outline-offset:\s*([\d.]+)px/.exec(rule('.entry.found'))?.[1] ?? 0);

    expect(marked.vertical, 'it reaches above and below the text').toBeGreaterThan(plain.vertical);
    expect(room, 'and stands clear of its neighbours rather than over them').toBeGreaterThan(0);
    // The line is drawn outside the box, so the room has to hold that as well as the box.
    expect(room, 'with room for the line drawn around it').toBeGreaterThan(offset);
  });

  it('reaches into the list at the sides, and gives back what it took', () => {
    const marked = box('.entry.found', 'padding');
    const pull = box('.entry.found', 'margin');

    expect(marked.horizontal, 'the sides are already padded by every row').toBe(box('.entry', 'padding').horizontal);
    expect(pull.horizontal).toBe(-marked.horizontal);
  });
});

/**
 * A name somebody else chose, kept to its row (#221).
 *
 * The app draws a lot of names it did not pick: session titles, plugin and server names,
 * page titles, file paths. Every one of them is as long as somebody else decided, and one
 * long enough pushes whatever shares its row - a status, a toggle, a Remove button - out of
 * a panel that is already narrow.
 *
 * Nearly all of them were already held. Two were not, and nothing said so: `.environment-name`
 * had no rule at all and `.wiki-result-title` had one that said nothing about width.
 */
describe('names the app did not choose the length of', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    if (at === -1) throw new Error(`no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };

  /**
   * Held to one line, or allowed to wrap onto more.
   *
   * Two answers rather than one: a sidebar row has the height to wrap into and a title reads
   * better whole, while a row of chips and buttons has only its width. What is not an answer
   * is neither, which is the row growing until something falls off the end of it.
   */
  const held = (selector: string) => {
    const rule = block(selector);
    return /text-overflow:\s*ellipsis/.test(rule) || /overflow-wrap|word-break|white-space:\s*pre-wrap/.test(rule);
  };

  it.each([
    ['.session-title'],
    ['.subagent-name'],
    ['.environment-name'],
    ['.environment-description'],
    ['.wiki-folder-name'],
    ['.wiki-result-title'],
    ['.queue-text'],
    ['.bin-title'],
    ['.changes-path'],
  ])('%s is held to its row', (selector) => {
    expect(held(selector), 'so a long one cannot push its row around').toBe(true);
  });

  /**
   * Ellipsis needs somewhere to happen.
   *
   * A flex child will not shrink below its content without being told to, so `overflow:
   * hidden` on its own does nothing and the row grows anyway. This is the half that is easy
   * to leave out, because the rule looks complete without it.
   */
  it.each([['.environment-name'], ['.environment-description'], ['.wiki-result-title']])(
    '%s may shrink, so the ellipsis it asks for can happen',
    (selector) => {
      expect(block(selector)).toMatch(/min-width:\s*0/);
    },
  );
});

/**
 * Where the keyboard is, in the app's own terms (#63).
 *
 * Left to the browser this was a black rectangle, which on a dark list reads as damage.
 * The ring is kept rather than removed - somebody moving through the list by keyboard has
 * nothing else to go on - while a pointer is stopped from raising one at all.
 */
describe('focus on a session row', () => {
  it('says where the keyboard is, in the accent rather than the browser default', () => {
    const at = css.indexOf('.session:focus-visible');
    expect(at, 'a focusable row should say where the keyboard is').toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf('}', at))).toContain('var(--accent)');
  });

  /** Shift-clicking down a list is a range, not a sentence. */
  it('keeps a drag down the list from selecting its text', () => {
    // Anchored at the start of a line, or this finds the selector inside
    // `.session-line .session {` and reads the wrong block.
    const at = css.indexOf('\n.session {');
    expect(at, '.session should be in the stylesheet').toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf('\n}', at))).toContain('user-select: none');
  });
});

/**
 * The box that says whether a row is picked (#63).
 *
 * It sits on the same flex line as the title, and a title is as long as somebody's first
 * prompt - 303 characters on this machine. Anything on that line that can give way will.
 */
describe('the box on a row being picked over', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} should be in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('keeps its width against a title that wants all of it', () => {
    expect(block('.session-check')).toContain('flex-shrink: 0');
  });

  /** A border on a box sized in pixels would otherwise take two of them off the inside. */
  it('is the size it says it is, border and all', () => {
    expect(block('.session-check')).toContain('box-sizing: content-box');
  });

  it('looks different once it is ticked', () => {
    expect(block('.session-check.on')).toContain('var(--accent)');
  });

  /**
   * Five actions in a column the reader has dragged as narrow as they like.
   *
   * Laid out in one line they would be squeezed until each read as three letters and a
   * gap, which is not offering them at all.
   */
  it('lets the actions in the bar wrap instead of squeezing them', () => {
    expect(block('.selecting-actions')).toContain('flex-wrap: wrap');
  });
});

/**
 * A transcript row where something was lost for good (#7).
 *
 * Truncation finishes successfully, so by status it is a success and takes the success
 * colour - a green tick beside "337 messages dropped", which says the opposite of what
 * happened.
 */
describe('a row that lost something', () => {
  it('does not wear the colour of a row that went well', () => {
    const at = css.indexOf('.tool.lossy .tool-status {');
    expect(at, 'a lossy row should say so').toBeGreaterThan(-1);

    const rule = css.slice(at, css.indexOf('\n}', at));
    expect(rule).toContain('var(--warning)');
    expect(rule, 'success is what it must not look like').not.toContain('var(--success)');
  });
});

/**
 * The mark beside the note count, which sat visibly above the words next to it (#35).
 *
 * It was a text glyph in a monospace family, inside a row whose text inherits the UI font.
 * Two fonts means two sets of metrics, and centring their boxes does not centre what is
 * drawn inside them.
 */
describe('the mark on the notes count', () => {
  const rule = (() => {
    const at = css.indexOf('.header-notes-mark {');
    expect(at, 'the mark should be in the stylesheet').toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  })();

  it('centres what it holds rather than resting it on a baseline', () => {
    expect(rule).toContain('align-items: center');
  });

  /** A family of its own is the whole cause: the mark is drawn now, so it needs none. */
  it('does not take a font of its own', () => {
    expect(rule, 'a second font is a second set of metrics').not.toContain('font-family');
  });
});

/**
 * A class with two rules in one stylesheet is a class whose first rule is mostly dead.
 *
 * `.tag-count` was written twice - once for the filter that counts sessions, once for the
 * picker that counts wiki pages - and the later one silently won. The two wanted the same
 * thing, so the second was deleted; this keeps the question from being reopened by accident.
 */
describe('a class written twice', () => {
  /** Only where the class is the whole selector: `.tag.on .tag-count` is a different rule. */
  const declarations = (name: string) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(new RegExp(`(^|\\n)\\s*\\${name}\\s*\\{`, 'g'))].length;

  it('styles the tag count in one place', () => {
    expect(declarations('.tag-count')).toBe(1);
  });

  /** The counter has to be able to find something, or every answer of one is luck. */
  it('has a selector to count, so this cannot pass by finding nothing', () => {
    expect(declarations('.tag-from-wiki-label')).toBe(1);
  });
});

/**
 * A suggested tag is drawn as the tags in use beside it are (#35).
 *
 * They sit in the same list, and one that is shorter and narrower than its neighbours reads
 * as a different kind of thing rather than as the same thing not yet chosen.
 *
 * It was first a single button, which had half the inset of everything around it: a tag in
 * use is a pill holding a button, so its spacing is the padding of both. Restating that sum
 * was the wrong fix twice over - it was also written at the specificity of the rule it meant
 * to correct, so the cascade settled it on source order and the correction never applied.
 * Building it from the same parts needs no sum at all, which is what the component test now
 * pins.
 */
describe('a tag suggested from the wiki', () => {
  it('restates none of the pill spacing it gets from being built the same way', () => {
    const at = css.indexOf('.tag-from-wiki .tag-name {');
    expect(at, 'the count inside the name should still be styled').toBeGreaterThan(-1);

    const rule = css.slice(at, css.indexOf('\n}', at));
    expect(rule, 'the pill and the button inside it already provide this').not.toContain('padding');
  });
});

/**
 * What a session last said, clamped to the lines a reader asked for (#240).
 *
 * `overflow: hidden` clips at the padding box rather than at the last line, so any bottom
 * padding on a clamped element is space the line after the clamp gets painted in. It showed
 * as a half-height line under every preview, which is what this is here to stop.
 */
describe('the clamped preview on a session row', () => {
  const block = () => {
    const at = css.indexOf('.session-said {');
    return css.slice(at, css.indexOf('}', at));
  };

  it('keeps the gap below it outside anything that can be painted in', () => {
    expect(block()).toMatch(/margin:[^;]*8px/);
  });

  it('pads it sideways only', () => {
    expect(block()).toMatch(/padding:\s*0 14px;/);
  });

  it('clips what the clamp leaves out', () => {
    expect(block()).toContain('overflow: hidden');
  });

  /** Both halves of the clamp, which does nothing without either. */
  it('lays the lines out in a box that can be clamped', () => {
    expect(block()).toContain('display: -webkit-box');
    expect(block()).toContain('-webkit-box-orient: vertical');
  });

  /**
   * How many lines is a setting, so it is set on the element. Chromium takes a plain number
   * here and not a `var()` that resolves to one, which is a row that clamps and one that
   * does not.
   */
  it('leaves how many lines to the element rather than fixing it here', () => {
    expect(block()).not.toContain('-webkit-line-clamp');
  });
});

/**
 * The column a note is read in, beside the session it is about (#35).
 *
 * A third column of the app's grid rather than something inside the session pane, so the
 * transcript keeps its own width and the edge between them can be taken hold of.
 */
describe('the notes column', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };

  /** Zero until something is in it, so a child that comes and goes needs no second grid. */
  it('takes no width at all while nothing is open', () => {
    expect(block('.app')).toMatch(/grid-template-columns:[^;]*1fr 0;/);
  });

  it('takes its own column once a note is open', () => {
    expect(block('.app.with-notes')).toMatch(/grid-template-columns:[^;]*var\(--notes-used\)/);
  });

  /**
   * The session keeps a fifth of the window whatever the two side columns are doing, and
   * the notes take what is left after the sidebar rather than having a ceiling of their own.
   * Dragging the sidebar wider therefore leaves the notes less, not the session.
   */
  it('leaves the session a fifth of the window', () => {
    expect(block('.app.with-notes')).toContain('calc(80vw - var(--sidebar-used))');
  });

  it('is measured against what the sidebar is actually taking', () => {
    expect(block('.app')).toMatch(/--sidebar-used:\s*min\(var\(--sidebar-column\), \d+vw\)/);
  });

  it('never gives the notes more than the window has left', () => {
    expect(block('.app.with-notes')).toMatch(/--notes-used:\s*min\(var\(--notes-column\), calc\(/);
  });

  it('has a default to fall back on when nobody has dragged it', () => {
    expect(css).toMatch(/--notes-column:\s*calc\(var\(--font-base\)/);
  });

  it('scrolls its page rather than the whole column', () => {
    expect(block('.notes-body')).toContain('overflow-y: auto');
  });

  /**
   * Two of the four things in the column come and go. A grid assigning rows by position
   * would put the page in whichever row was left, and an `auto` row is only as tall as its
   * content - which is what made the editor a few lines tall inside a full-height column.
   */
  it('lays its contents out so the page takes what is left, however many rows there are', () => {
    expect(block('.notes')).toContain('flex-direction: column');
    expect(block('.notes')).not.toContain('grid-template-rows');
  });

  it('gives the page the space the head and the picker do not use', () => {
    expect(block('.notes-body')).toMatch(/flex:\s*1/);
  });

  /** Without the floor it grows the column to fit the page instead of scrolling. */
  it('lets the page scroll rather than growing to fit it', () => {
    expect(block('.notes-body')).toContain('min-height: 0');
  });

  it('fills the column with the editor, as the browser fills its pane', () => {
    expect(block('.notes-body .wiki-source')).toContain('height: 100%');
  });

  it('refuses to be widened by a long line in the page it holds', () => {
    expect(block('.notes')).toContain('min-width: 0');
  });
});

/** The edge between the session and its notes, which mirrors the sidebar's (#35). */
describe('the notes grip', () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('sits on the column it resizes, not beside it', () => {
    expect(block('.notes-grip')).toContain('right: var(--notes-used)');
  });

  it('is centred over the boundary rather than pushed off it', () => {
    expect(block('.notes-grip')).toContain('margin-right: -4px');
  });

  it('says what it does when pointed at', () => {
    expect(block('.notes-grip')).toContain('cursor: col-resize');
  });

  it('sits over what it divides rather than under it', () => {
    expect(block('.notes-grip')).toContain('position: absolute');
  });

  /** Both grips take their position from the width the grid gave the column, not a copy. */
  it('takes its position from the same width the grid uses', () => {
    expect(block('.sidebar-grip')).toContain('left: var(--sidebar-used)');
  });
});

/**
 * The box the match number is typed into (#209).
 *
 * A control nobody can see is one nobody tries, and the whole point of this one is that it
 * can be typed into. It was drawn as plain text that only became a box when pointed at.
 */
/**
 * The two controls on a subagent row (#260).
 *
 * The star and the cross were a pair of buttons with their own padding, their own font size
 * and one of them its own line height, so they came out at different heights from each other
 * and from the name beside them. They share a box now, as the session rows' own controls do.
 */
describe('the controls on a subagent row', () => {
  const shared = () => {
    const found = /\.subagent-keep,\s*\.subagent-dismiss \{/.exec(css);
    expect(found, 'the two should still be shaped together').not.toBeNull();
    return css.slice(found!.index, css.indexOf('\n}', found!.index));
  };

  it('gives both the same box, so the glyphs sit on one line', () => {
    expect(shared()).toContain('place-items: center');
    expect(shared()).toMatch(/width:\s*calc\(/);
  });

  /**
   * What made them differ: a line height and a padding set on one and not the other, back
   * when nothing else held their boxes equal. Size is no longer among them - see below.
   */
  it.each(['.subagent-keep {', '.subagent-dismiss {'])('leaves %s nothing that changes its box', (selector) => {
    const at = css.indexOf(`\n${selector}`);
    expect(at, `${selector} should still be styled`).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf('\n}', at));

    for (const property of ['line-height', 'padding', 'width']) {
      expect(rule, `${selector} should take its ${property} from the pair`).not.toContain(`${property}:`);
    }
  });

  /**
   * The star keeps the pair's size and the cross is stepped down from it.
   *
   * A full cross drawn at the star's size is the heavier of the two marks, and the control
   * that gets rid of a row should not be the louder one. Only the ink changes: the box is
   * the pair's and the row stretches both, so the two still sit on one line.
   *
   * Pinned as a relationship rather than as two names, so moving either one up or down the
   * scale is free and equalising them is not.
   */
  it('draws the cross smaller than the star', () => {
    const multiplier = (step: string) => {
      const found = new RegExp(`--font-${step}:\\s*calc\\(var\\(--font-base\\) \\* ([\\d.]+)\\)`).exec(css);
      expect(found, `--font-${step} should still be a step on the scale`).not.toBeNull();
      return Number(found![1]);
    };

    const sizeIn = (rule: string) => {
      const at = css.indexOf(`\n${rule}`);
      expect(at, `${rule} should still be styled`).toBeGreaterThan(-1);
      const found = /font-size:\s*var\(--font-([a-z]+)\)/.exec(css.slice(at, css.indexOf('\n}', at)));
      expect(found, `${rule} should set a size from the scale`).not.toBeNull();
      return multiplier(found![1]);
    };

    expect(sizeIn('.subagent-item .subagent-dismiss {')).toBeLessThan(sizeIn('.subagent-keep,'));
  });

  /**
   * Hover and selection belong to the row, not to the button inside it. Those two controls
   * sit outside that button, so lighting the button alone left them in a darker strip at the
   * end of the row and drew a seam down the list.
   */
  it('lights the whole row rather than the button inside it', () => {
    expect(css).toMatch(/\.subagent-item\[aria-selected='true'\] \{[^}]*background:/);
    expect(css).toMatch(/\.subagent-item:hover \{[^}]*background:/);
  });

  it('leaves the button unlit, so there is nothing to draw a seam', () => {
    expect(css, 'the row carries the mark now').not.toContain('.subagent.selected');
    expect(css).not.toMatch(/\.subagent:hover \{[^}]*background:/);
  });
});

/**
 * How a delegated run went, beside the way back out of it.
 *
 * It borrowed the sidebar's meta line, which is set a size larger - and two words of
 * different sizes side by side sit on different baselines however their boxes are aligned.
 */
describe('the state of a delegated run', () => {
  const sizeOf = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `${selector} should still be styled`).toBeGreaterThan(-1);
    return /font-size:\s*([^;]+);/.exec(css.slice(at, css.indexOf('\n}', at)))?.[1]?.trim();
  };

  it('is set like the button it stands next to, so the pair reads as one line', () => {
    expect(sizeOf('.subagent-state')).toBe(sizeOf('.changes-action'));
  });

  /**
   * The button's border and padding make its box taller than the bare word beside it, so
   * centring the boxes puts the word that has no border low. Baselines are what the eye
   * reads as level.
   */
  it('lines the pair up on the baseline rather than through the middle', () => {
    const at = css.indexOf('\n.subagent-head {');
    expect(at, 'the row should still be styled').toBeGreaterThan(-1);

    expect(css.slice(at, css.indexOf('\n}', at))).toContain('align-items: baseline');
  });

  /**
   * The model the run was given sits in the same row, and it is a third small grey word.
   * Without a box of its own it reads as part of the state beside it rather than as a
   * separate fact.
   */
  it('gives the model a box, so it does not read as part of the state', () => {
    const at = css.indexOf('\n.subagent-model {');
    expect(at, 'the model should still be styled').toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf('\n}', at));

    expect(rule).toContain('border: 1px solid var(--border)');
    expect(rule, 'a box with no padding is a line drawn on the text').toMatch(/padding:\s*\d/);
    expect(sizeOf('.subagent-model'), 'it should sit below the state, not compete with it').not.toBe(
      sizeOf('.subagent-state'),
    );
  });

  /**
   * What puts the model and the changes at the far end of the row rather than against the
   * way back out. Both headers hang their controls on it, so losing it moves two of them.
   */
  it('pushes the controls to the far end of the row', () => {
    const at = css.indexOf('\n.header-controls {');
    expect(at, 'the controls should still be styled').toBeGreaterThan(-1);

    expect(css.slice(at, css.indexOf('\n}', at))).toContain('margin-left: auto');
  });
});

describe('the match number in the find bar', () => {
  const rule = () => {
    const at = css.indexOf('.find-at {');
    expect(at, 'the number should still be styled').toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('carries a border of its own rather than waiting to be pointed at', () => {
    expect(rule()).toContain('border: 1px solid var(--border)');
    expect(rule(), 'a transparent border is a box nobody can see').not.toContain('transparent');
  });

  it('is filled like the box of words beside it, so the two read as a pair', () => {
    expect(rule()).toContain('background: var(--bg)');
  });
});

/**
 * The find bar's own size (#209).
 *
 * A bar the width of the conversation is a bar whose controls sit a screen apart, with the
 * count and the buttons nowhere near the words being typed.
 */
describe('the find bar', () => {
  const rule = () => {
    const at = css.indexOf('.find-bar {');
    expect(at, 'the bar should still be styled').toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('takes its own width rather than the list it sits in', () => {
    expect(rule()).toMatch(/width:\s*min\(/);
  });

  /** Fixed, until the pane is narrower than it - at which point the pane wins. */
  it('gives way when there is less room than it wants', () => {
    expect(rule()).toContain('100%');
  });

  it('sits at the end of the row, where a find box belongs', () => {
    expect(rule()).toContain('margin-left: auto');
  });

  /** Too narrow for one row, so the parts have to be allowed to fall onto the next. */
  it('lets its controls wrap rather than squeezing them', () => {
    expect(rule()).toContain('flex-wrap: wrap');
  });

  /**
   * Above everything the transcript paints into its own corners.
   *
   * The time and the copy button sit at a layer of their own on each message, and they come
   * after the bar in the list - so at the same layer they won the tie and were drawn through
   * it. Nothing here creates a stacking context between them, so the numbers are compared
   * directly and the bar has to be the larger.
   */
  it.each(['.message-meta {', '.block .copy {'])('is drawn above %s', (selector) => {
    const layer = (start: string) => {
      const at = css.indexOf(start);
      expect(at, `${start} should still be styled`).toBeGreaterThan(-1);
      const found = /z-index:\s*(\d+)/.exec(css.slice(at, css.indexOf('\n}', at)));
      expect(found, `${start} should still declare a layer`).not.toBeNull();
      return Number(found![1]);
    };

    expect(layer('.find-bar {')).toBeGreaterThan(layer(selector));
  });
});
