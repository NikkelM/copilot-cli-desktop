// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Confirm } from './Confirm';
import { MergeChoice } from './MergeChoice';
import { RenamePrompt } from './RenamePrompt';
import { TagPicker } from './TagPicker';

/**
 * Seven surfaces in this app declare `aria-modal="true"`, which tells anything reading the
 * screen that focus is held within them. None of them held it until #248: Tab walked out into
 * the page behind, and the claim was one the app did not honour.
 *
 * Checked here against the real dialogs rather than only against the hook, because the hook
 * being right is no use to a surface that never calls it - which was the whole of the bug.
 */
beforeEach(() => {
  // jsdom lays nothing out, so every control would otherwise be read as off screen.
  Element.prototype.getClientRects = function () {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  document.body.innerHTML = '';
});

afterEach(cleanup);

/** Each surface, drawn with enough to have a first and last control to come round between. */
const surfaces: [string, () => void][] = [
  [
    'Confirm',
    () =>
      void render(
        <Confirm title="Delete" body="Gone for good." confirmLabel="Delete" onConfirm={() => {}} onCancel={() => {}} />,
      ),
  ],
  ['MergeChoice', () => void render(<MergeChoice onChoose={() => {}} onCancel={() => {}} />)],
  ['RenamePrompt', () => void render(<RenamePrompt current="A name" onRename={() => {}} onClose={() => {}} />)],
  [
    'TagPicker',
    () =>
      void render(
        <TagPicker
          title="A session"
          held={['hades']}
          known={['hades', 'copilot']}
          wikiTags={[]}
          onToggle={() => {}}
          onRetire={() => {}}
          onClose={() => {}}
        />,
      ),
  ],
];

describe.each(surfaces)('%s, which says it is modal', (_name, draw) => {
  const dialog = () => document.querySelector('[aria-modal="true"]') as HTMLElement;
  const reachable = () =>
    [...dialog().querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter(
      (node) => !node.hasAttribute('disabled') && node.tabIndex !== -1,
    );

  it('says so', () => {
    draw();

    expect(dialog(), 'the fixture must actually draw the surface').toBeTruthy();
  });

  it('comes round to its first control rather than letting Tab out of the back', () => {
    draw();
    const items = reachable();
    items[items.length - 1]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', bubbles: true });

    expect(document.activeElement).toBe(items[0]);
  });

  it('comes round to its last going backwards', () => {
    draw();
    const items = reachable();
    items[0]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true, bubbles: true });

    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('takes the keyboard back from the page behind it', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    draw();
    outside.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', bubbles: true });

    expect(dialog().contains(document.activeElement)).toBe(true);
  });
});

/** Closing one has to put the keyboard back, or every dialog costs the reader their place. */
describe('coming back from a dialog', () => {
  it('returns the keyboard to whatever opened it', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const view = render(<Confirm title="Delete" body="Gone." confirmLabel="Delete" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(document.activeElement, 'the dialog takes it on opening').not.toBe(opener);

    view.unmount();

    expect(document.activeElement).toBe(opener);
  });

  it('leaves the one it was given rather than reaching past it', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const view = render(<RenamePrompt current="A name" onRename={vi.fn()} onClose={vi.fn()} />);
    screen.getByDisplayValue('A name').focus();
    view.unmount();

    expect(document.activeElement).toBe(opener);
  });
});
