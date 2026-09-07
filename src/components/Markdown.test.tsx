// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openUrl = vi.fn();

// Drawing is mermaid's business; what matters here is when it is asked and what happens
// when it refuses.
vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: (_id: string, source: string) =>
      source.includes('graph')
        ? Promise.resolve({ svg: '<svg><g>drawn</g></svg>' })
        : Promise.reject(new Error('Parse error')),
  },
}));
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

/**
 * A fenced block says what it is, and that is enough to colour it. A wall of one-colour
 * text is the thing this replaces; guessing at an unknown language would be worse.
 */
describe('code blocks', () => {
  it('marks up the parts of a block whose language it knows', () => {
    const { container } = render(<Markdown body={'```ts\nconst x: number = 1;\n```'} />);

    expect(container.querySelector('code')?.className).toContain('hljs');
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('const');
  });

  // The name on the fence is whatever the language is usually called, not the grammar's own.
  it.each(['ts', 'sh', 'yml', 'ps1', 'rs', 'py'])('knows %s by the name a reply writes', (lang) => {
    const { container } = render(<Markdown body={'```' + lang + '\nx\n```'} />);
    expect(container.querySelector('code')?.className).toContain('hljs');
  });

  it('leaves a block plain when the language is one it does not carry', () => {
    const { container } = render(<Markdown body={'```brainfuck\n+++.\n```'} />);
    expect(container.querySelectorAll('span').length).toBe(0);
  });

  it('leaves a block plain when no language was given', () => {
    const { container } = render(<Markdown body={'```\nsome output\n```'} />);
    expect(container.querySelectorAll('span').length).toBe(0);
    expect(container.querySelector('code')?.className ?? '').not.toContain('hljs');
  });

  // Inline code is a word in a sentence, not a program.
  it('leaves inline code alone', () => {
    const { container } = render(<Markdown body="the `const` keyword" />);
    expect(container.querySelectorAll('span').length).toBe(0);
  });
});

/**
 * Getting text back out. Selecting a long reply by hand is not really possible, and
 * selecting code catches the prose around it.
 */
describe('copying', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it('offers to copy a code block', async () => {
    render(<Markdown body={'```ts\nconst x = 1;\n```'} />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    expect(writeText).toHaveBeenCalledWith('const x = 1;\n');
  });

  // By the time a block is on screen it is a span per token, and reassembling those would
  // depend on how the highlighter happened to split them.
  it('copies the code as written, not as coloured', async () => {
    render(<Markdown body={'```ts\nexport function thing() {\n  return 1;\n}\n```'} />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    expect(writeText).toHaveBeenCalledWith('export function thing() {\n  return 1;\n}\n');
  });

  it('offers one button per block', async () => {
    render(<Markdown body={'```ts\none\n```\n\ntext\n\n```ts\ntwo\n```'} />);

    expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(2);
  });

  // Inline code is a word in a sentence; a button beside it would be larger than the code.
  it('offers nothing for inline code', () => {
    render(<Markdown body="the `const` keyword" />);

    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull();
  });
});

/**
 * A diagram written as text, which the terminal could only ever show as text. Mermaid is
 * mocked here: what matters is when it is asked to draw and what happens when it will not.
 */
describe('diagrams', () => {
  const flowchart = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';

  it('draws a mermaid fence rather than showing its source', async () => {
    const { container } = render(<Markdown body={flowchart} />);

    await vi.waitFor(() => expect(container.querySelector('.mermaid svg')).toBeTruthy());
  });

  // Models get mermaid wrong, and a diagram that will not parse must not take the message
  // with it - the source is what a terminal would have shown anyway.
  it('falls back to the source when it will not parse', async () => {
    render(<Markdown body={'```mermaid\nnot a diagram\n```'} />);

    expect(await screen.findByText(/not a diagram/)).toBeTruthy();
  });

  // A fence is incomplete for most of a streamed reply, and mermaid throws on incomplete
  // input: attempting per chunk means repeated failures and repeated work.
  it('waits for the whole reply before drawing', () => {
    const { container } = render(<Markdown body={flowchart} streaming />);

    expect(container.querySelector('.mermaid svg')).toBeNull();
    expect(container.textContent).toContain('graph TD');
  });

  // A block that merely looks like a diagram is still code someone wanted to read as code.
  it('leaves other code blocks alone', () => {
    const { container } = render(<Markdown body={'```ts\ngraph TD\n```'} />);

    expect(container.querySelector('.mermaid')).toBeNull();
    expect(container.querySelector('pre code')).toBeTruthy();
  });
});
