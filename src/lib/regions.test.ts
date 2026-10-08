// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { REGIONS, focusRegion, focusToggle, inSidebar, regionOf, stepRegion, targetOf } from './regions';

/** The window as the app draws it, with every region present. */
const whole = `
  <nav data-region="sidebar">
    <input data-region="sidebar-search" />
    <div class="session-row" tabindex="-1" id="first"></div>
    <div class="session-row" tabindex="0" id="stop"></div>
  </nav>
  <ol data-region="transcript" tabindex="-1"></ol>
  <div data-region="panel" tabindex="-1"></div>
  <textarea data-region="composer"></textarea>
`;

const draw = (html: string) => {
  document.body.innerHTML = html;
};

const here = () => document.activeElement?.getAttribute('data-region') ?? document.activeElement?.id ?? null;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('finding a region', () => {
  it('aims the sidebar at the row holding the tab stop', () => {
    draw(whole);

    expect(targetOf('sidebar')?.id, 'the arrows should be ready to move from there').toBe('stop');
  });

  /** A sidebar with nothing in it is still somewhere to go, and the box is why you came. */
  it('falls back to the filter box when no row can be reached', () => {
    draw('<nav data-region="sidebar"><input data-region="sidebar-search" /></nav>');

    expect(targetOf('sidebar')?.tagName).toBe('INPUT');
  });

  it.each(REGIONS.filter((region) => region !== 'sidebar'))('finds the %s by name', (region) => {
    draw(whole);

    expect(targetOf(region)?.getAttribute('data-region')).toBe(region);
  });

  it('finds nothing for a region that is not on screen', () => {
    draw('<textarea data-region="composer"></textarea>');

    expect(targetOf('transcript')).toBeNull();
  });

  it('says so when there was nowhere to go', () => {
    draw('<textarea data-region="composer"></textarea>');

    expect(focusRegion('panel')).toBe(false);
  });
});

describe('knowing which region the focus is in', () => {
  it('names the region a focused thing sits inside', () => {
    draw(whole);

    expect(regionOf(document.querySelector('#stop'))).toBe('sidebar');
  });

  /**
   * The box is its own spot for the key that aims at it, but stepping out of it should leave
   * the sidebar rather than move down to the rows underneath.
   */
  it('counts the filter box as part of the sidebar', () => {
    draw(whole);

    expect(regionOf(document.querySelector('[data-region="sidebar-search"]'))).toBe('sidebar');
  });

  it('names nothing when the focus is outside every region', () => {
    draw('<button id="loose"></button>');

    expect(regionOf(document.querySelector('#loose'))).toBeNull();
  });
});

describe('stepping between regions', () => {
  it('walks them in order', () => {
    draw(whole);
    focusRegion('sidebar');

    stepRegion(1);
    expect(here()).toBe('transcript');

    stepRegion(1);
    expect(here()).toBe('panel');

    stepRegion(1);
    expect(here()).toBe('composer');
  });

  it('comes back round to the first', () => {
    draw(whole);
    focusRegion('composer');

    stepRegion(1);

    expect(here()).toBe('stop');
  });

  it('walks them backwards too', () => {
    draw(whole);
    focusRegion('transcript');

    stepRegion(-1);

    expect(here()).toBe('stop');
  });

  /** A panel that is not open is not a stop on the way round. */
  it('skips a region that is not on screen', () => {
    draw(whole.replace('<div data-region="panel" tabindex="-1"></div>', ''));
    focusRegion('transcript');

    stepRegion(1);

    expect(here()).toBe('composer');
  });

  it('lands somewhere on the first press when nothing is focused', () => {
    draw(whole);

    stepRegion(1);

    expect(here()).toBe('stop');
  });

  it('lands at the far end going backwards from nothing', () => {
    draw(whole);

    stepRegion(-1);

    expect(here()).toBe('composer');
  });

  it('says so when there is nowhere else to be', () => {
    draw('<textarea data-region="composer"></textarea>');
    focusRegion('composer');

    expect(stepRegion(1), 'the only region is the one already held').toBe(false);
  });
});

/**
 * Keeping the keyboard on the control that folded the sidebar away (#247).
 *
 * Both chevrons are always in the document. A hidden sidebar is only `display: none`, so the
 * one in its header is still there to be found and focusing it would focus nothing anybody
 * can see.
 */
describe('following the sidebar as it folds away and comes back', () => {
  const both = `
    <nav data-region="sidebar">
      <button class="sidebar-toggle" id="header"></button>
      <div class="session-row" tabindex="0" id="row"></div>
    </nav>
    <button class="sidebar-toggle away" id="corner"></button>
    <textarea data-region="composer"></textarea>
  `;

  it.each([
    ['the control itself', 'header'],
    ['a row beside it', 'row'],
  ])('counts %s as somewhere about to be folded away', (_what, id) => {
    draw(both);

    expect(inSidebar(document.querySelector(`#${id}`))).toBe(true);
  });

  /** Ctrl+B pressed while writing is about the view, not about going anywhere. */
  it('does not count the message box', () => {
    draw(both);

    expect(inSidebar(document.querySelector('[data-region="composer"]'))).toBe(false);
  });

  it('counts nothing at all as nowhere', () => {
    draw(both);

    expect(inSidebar(null)).toBe(false);
  });

  it('hands the keyboard to the corner once the sidebar has gone', () => {
    draw(both);

    focusToggle(true);

    expect(document.activeElement?.id).toBe('corner');
  });

  it('hands it back to the header once the sidebar returns', () => {
    draw(both);

    focusToggle(false);

    expect(document.activeElement?.id, 'the one in the header, not the corner').toBe('header');
  });

  it('says so when the control asked for is not there', () => {
    draw('<nav data-region="sidebar"><button class="sidebar-toggle" id="header"></button></nav>');

    expect(focusToggle(true), 'nothing holds the corner while the sidebar is open').toBe(false);
  });
});
