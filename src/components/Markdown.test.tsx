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

/**
 * A reply refers to its own sections, and those links are places in this window rather
 * than documents for the operating system to puzzle over. Handing every href to the opener
 * sent anchors and relative paths to it, which was the bug this fixes.
 */
describe('links within a reply', () => {
  it('gives headings anchors to reach', () => {
    const { container } = render(<Markdown body={'## Findings\n\ntext'} anchor="m1" />);
    expect(container.querySelector('h2')?.id).toBe('m1-findings');
  });

  // Replies reuse the same headings constantly; without scoping, a link would jump to
  // whichever reply came first in the transcript.
  it('keeps one reply\u2019s anchors out of another\u2019s', () => {
    const first = render(<Markdown body="## Findings" anchor="m1" />);
    const second = render(<Markdown body="## Findings" anchor="m2" />);

    expect(first.container.querySelector('h2')?.id).not.toBe(second.container.querySelector('h2')?.id);
  });

  it('points a link at the heading in its own reply', () => {
    const { container } = render(<Markdown body={'## Findings\n\n[see](#findings)'} anchor="m1" />);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('#m1-findings');
  });

  it('scrolls to a heading rather than asking the system to open it', async () => {
    openUrl.mockClear();
    const { container } = render(<Markdown body={'## Findings\n\n[see](#findings)'} anchor="m1" />);
    const heading = container.querySelector('h2')!;
    const scrolled = vi.fn();
    heading.scrollIntoView = scrolled;
    document.body.append(container);

    await userEvent.click(screen.getByRole('link', { name: 'see' }));

    expect(scrolled).toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  // A path relative to the working directory names a file, which is a different feature.
  it('does not hand a relative path to the system', async () => {
    openUrl.mockClear();
    render(<Markdown body="[notes](./notes.md)" anchor="m1" />);

    await userEvent.click(screen.getByRole('link', { name: 'notes' }));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('still opens a real address outside the app', async () => {
    openUrl.mockClear();
    render(<Markdown body="[docs](https://example.com/docs)" anchor="m1" />);

    await userEvent.click(screen.getByRole('link', { name: 'docs' }));
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs');
  });
});
