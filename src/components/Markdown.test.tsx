// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => openUrl(url) }));

const { Markdown } = await import('./Markdown');

describe('Markdown', () => {
  it('renders emphasis as emphasis rather than as punctuation', () => {
    const { container } = render(<Markdown body="a **bold** claim" />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.textContent).not.toContain('**');
  });

  it('renders headings, lists and tables', () => {
    const { container } = render(
      <Markdown body={'## Findings\n\n- first\n- second\n\n| a | b |\n| - | - |\n| 1 | 2 |'} />,
    );

    expect(container.querySelector('h2')?.textContent).toBe('Findings');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelectorAll('table th')).toHaveLength(2);
  });

  it('keeps a code block as code', () => {
    const { container } = render(<Markdown body={'```ts\nconst x = 1;\n```'} />);
    expect(container.querySelector('pre code')?.textContent).toContain('const x = 1;');
  });

  /**
   * A reply is text from a model, not markup to be trusted. react-markdown ignores raw
   * HTML unless told otherwise, and this is here so that stays true if plugins change.
   */
  it('does not render raw HTML', () => {
    const { container } = render(<Markdown body={'<img src=x onerror="alert(1)">\n\nafter'} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('after');
  });

  // The webview is the app: following a link inside it leaves nowhere to go back to.
  it('opens a link outside the app rather than navigating to it', async () => {
    openUrl.mockClear();
    render(<Markdown body="[the docs](https://example.com/docs)" />);

    await userEvent.click(screen.getByRole('link', { name: 'the docs' }));

    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('leaves plain text alone', () => {
    const { container } = render(<Markdown body="just a sentence" />);
    expect(container.textContent).toBe('just a sentence');
  });
});
