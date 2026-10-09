// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { step, stepRows, within } from './roving';

const draw = (html: string) => {
  document.body.innerHTML = html;
  return document.querySelector('.box') as HTMLElement;
};

/** A plain list of controls, the shape the changes panel and the branch menu have. */
const flat = `
  <div class="box">
    <ul>
      <li><button class="row">One</button></li>
      <li><button class="row">Two</button></li>
      <li><button class="row">Three</button></li>
    </ul>
  </div>
`;

/** Rows holding several controls each, the shape the queue and the subagents list have. */
const grid = `
  <div class="box">
    <ol>
      <li class="row"><button>1a</button><button>1b</button></li>
      <li class="row"><button>2a</button><button>2b</button></li>
      <li class="row"><button>3a</button><button>3b</button></li>
    </ol>
  </div>
`;

const press = (label: string) => (screen(label) as HTMLElement).focus();
const screen = (label: string) =>
  [...document.querySelectorAll('button')].find((node) => node.textContent === label) ?? null;
const here = () => (document.activeElement as HTMLElement | null)?.textContent ?? null;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('walking a list of controls', () => {
  it('goes to the next one', () => {
    const box = draw(flat);
    press('One');

    expect(step(box, '.row', 1)).toBe(true);
    expect(here()).toBe('Two');
  });

  it('goes back to the one before', () => {
    const box = draw(flat);
    press('Two');

    step(box, '.row', -1);

    expect(here()).toBe('One');
  });

  it('comes round the end', () => {
    const box = draw(flat);
    press('Three');

    step(box, '.row', 1);

    expect(here()).toBe('One');
  });

  it('comes round the start', () => {
    const box = draw(flat);
    press('One');

    step(box, '.row', -1);

    expect(here()).toBe('Three');
  });

  it.each([
    ['first', 'One'],
    ['last', 'Three'],
  ] as const)('jumps to the %s', (end, landing) => {
    const box = draw(flat);
    press('Two');

    step(box, '.row', end);

    expect(here()).toBe(landing);
  });

  /** Arriving from outside, which is what a region key or a press on the panel itself does. */
  it.each([
    [1, 'One'],
    [-1, 'Three'],
  ] as const)('starts at the end it is heading away from, going %s', (by, landing) => {
    const box = draw(flat);

    step(box, '.row', by);

    expect(here()).toBe(landing);
  });

  it('says there was nowhere to go when the list is empty', () => {
    const box = draw('<div class="box"><ul></ul></div>');

    expect(step(box, '.row', 1), 'so the key is left to whatever else wanted it').toBe(false);
  });

  it('walks past a control that is refused', () => {
    const box = draw(`
      <div class="box">
        <button class="row">One</button>
        <button class="row" disabled>Refused</button>
        <button class="row">Three</button>
      </div>
    `);
    press('One');

    step(box, '.row', 1);

    expect(here()).toBe('Three');
  });
});

describe('what a list holds', () => {
  it('leaves out the ones that cannot be reached', () => {
    const box = draw(`
      <div class="box">
        <button class="row">One</button>
        <button class="row" disabled>Refused</button>
        <button class="row" tabindex="-1">Passed over</button>
      </div>
    `);

    expect(within(box, '.row').map((node) => node.textContent)).toEqual(['One']);
  });
});

describe('walking rows that hold several controls each', () => {
  it('lands on the first control of the next row', () => {
    const box = draw(grid);
    press('1b');

    expect(stepRows(box, '.row', 'button', 1)).toBe(true);
    expect(here(), 'the row below, from its start').toBe('2a');
  });

  it('lands on the first control of the row above', () => {
    const box = draw(grid);
    press('3b');

    stepRows(box, '.row', 'button', -1);

    expect(here()).toBe('2a');
  });

  it('comes round the end', () => {
    const box = draw(grid);
    press('3a');

    stepRows(box, '.row', 'button', 1);

    expect(here()).toBe('1a');
  });

  /** Left and right are the plain walk, given one row to work in. */
  it('walks along a row without leaving it', () => {
    draw(grid);
    press('2a');
    const row = (document.activeElement as HTMLElement).closest('.row') as HTMLElement;

    step(row, 'button', 1);

    expect(here()).toBe('2b');
  });

  it('says there was nowhere to go when a row holds nothing reachable', () => {
    const box = draw('<div class="box"><ol><li class="row"><span>Nothing</span></li></ol></div>');

    expect(stepRows(box, '.row', 'button', 1)).toBe(false);
  });
});
