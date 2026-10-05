// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WikiPageBody } from './WikiPageBody';
import type { WikiPage, WikiPageContent } from '../../shared/protocol';

/**
 * How often the renderer actually runs, which is the thing being measured here.
 *
 * Its own file because the real renderer has to be replaced to count its runs, and the
 * tests for what a page looks like need the real one.
 */
let drawn = 0;

vi.mock('./Markdown', async () => {
  const { memo } = await import('react');
  return {
    // Memoised exactly as the real one is: what is being tested is whether the props this
    // component hands it let that memo hold.
    Markdown: memo(function Markdown() {
      drawn += 1;
      return <div data-testid="markdown" />;
    }),
  };
});

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const PAGES: WikiPage[] = [{ path: 'a.md', title: 'A' }];
const PAGE = { path: 'a.md', source: '# A' } as WikiPageContent;

beforeEach(() => {
  drawn = 0;
});

/**
 * Rendering a page parses the whole of it, and this component is drawn inside an app that
 * re-renders on every streamed event and on every frame of a drag. An arrow built in the
 * body would be a new prop each time, so the memo would never hold and every one of those
 * would reparse the page. That is what made dragging the column's edge stutter.
 */
describe('not drawing the page again for nothing', () => {
  const draw = (onOpen: () => void, onEdit: () => void) => (
    <WikiPageBody page={PAGE} pages={PAGES} source="# A" raw={false} loading={false} onEdit={onEdit} onOpen={onOpen} />
  );

  it('draws it once to begin with', () => {
    const [onOpen, onEdit] = [vi.fn(), vi.fn()];
    render(draw(onOpen, onEdit));

    expect(drawn).toBe(1);
  });

  it('does not draw it again when nothing about the page changed', () => {
    const [onOpen, onEdit] = [vi.fn(), vi.fn()];
    const { rerender } = render(draw(onOpen, onEdit));

    for (let again = 0; again < 5; again += 1) rerender(draw(onOpen, onEdit));

    expect(drawn).toBe(1);
  });

  it('draws it again when the page itself changes', () => {
    const [onOpen, onEdit] = [vi.fn(), vi.fn()];
    const { rerender } = render(draw(onOpen, onEdit));

    rerender(
      <WikiPageBody
        page={PAGE}
        pages={PAGES}
        source="# Something else"
        raw={false}
        loading={false}
        onEdit={onEdit}
        onOpen={onOpen}
      />,
    );

    expect(drawn).toBe(2);
  });
});
