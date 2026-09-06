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
   * A reply is text from a model, not markup to be trusted. Replies do use HTML, and
   * `<details>` especially, so it is allowed through a schema rather than shown as tags -
   * which means what that schema refuses is worth pinning down.
   */
  it('keeps the HTML a reply legitimately uses', () => {
    const { container } = render(
      <Markdown body={'<details><summary>More</summary>\n\nhidden\n\n</details>\n\nPress <kbd>Ctrl</kbd>'} />,
    );

    expect(container.querySelector('details summary')?.textContent).toBe('More');
    expect(container.querySelector('kbd')?.textContent).toBe('Ctrl');
  });

  it('refuses the HTML that could act', () => {
    const { container } = render(
      <Markdown
        body={'<script>window.stolen = 1</script>\n\n<img src=x onerror="window.stolen = 2">\n\n<iframe src="https://example.com"></iframe>\n\nafter'}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('onerror')).toBeNull();
    // The text around it survives: refusing markup is not the same as dropping the reply.
    expect(container.textContent).toContain('after');
  });

  it('renders maths rather than its source', () => {
    const { container } = render(<Markdown body={'Inline $E = mc^2$ and more'} />);

    // The source stays in the MathML annotation, which is what a screen reader reads, so
    // it is the drawn output that says whether this worked.
    expect(container.querySelector('.katex-html')).not.toBeNull();
    expect(container.querySelector('.katex-display')).toBeNull();
  });

  // Delimiters on their own lines are what makes maths a block rather than part of a
  // sentence, and only the block form is centred and given room.
  it('tells block maths from inline', () => {
    const { container } = render(<Markdown body={'Then:\n\n$$\n\\int_0^1 x\\,dx\n$$'} />);
    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('turns emoji shortcodes into emoji', () => {
    const { container } = render(<Markdown body="ship it :rocket:" />);
    expect(container.textContent).toBe('ship it 🚀');
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
