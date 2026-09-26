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
 * The row that deletes a session is drawn like every other row in the menu.
 *
 * It was set apart with a border of its own and the padding to clear it, which made it
 * taller than its neighbours and gave it square corners the moment it was pointed at.
 */
describe('the row that loses something', () => {
  const rule = (() => {
    const at = css.indexOf('.session-menu-item.destructive {');
    expect(at, 'the destructive row should be in the stylesheet').toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  })();

  it('keeps the shape of the rows around it', () => {
    expect(rule, 'a radius of its own gives it corners the others do not have').not.toContain('border-radius');
    expect(rule, 'padding of its own makes it taller than the others').not.toContain('padding');
  });

  it('is separated by a line beside it rather than one on it', () => {
    expect(rule, 'a border is part of the row, so the fill runs into it').not.toContain('border-top');
    expect(css).toContain('.session-menu-item.destructive::before {');
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
describe('class names', () => {
  /** Every `.name` the stylesheet mentions, wherever in a selector it appears. */
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
