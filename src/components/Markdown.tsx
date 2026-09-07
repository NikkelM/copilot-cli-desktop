import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkGemoji from 'remark-gemoji';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';
import { openUrl } from '@tauri-apps/plugin-opener';

import { scopeAnchors } from '../lib/scopeAnchors';
import { aliases, languages } from '../lib/highlight';
import { CopyButton } from './CopyButton';
import { Mermaid } from './Mermaid';
import 'katex/dist/katex.min.css';

/**
 * The text of a block, as it was written.
 *
 * Taken from the parsed node rather than the rendered element: by the time a block is on
 * screen it has been cut into a span per token, and reassembling those would depend on how
 * the highlighter happened to split them.
 */
function textOf(node: unknown): string {
  const element = node as { type?: string; value?: string; children?: unknown[] } | undefined;
  if (!element) return '';
  if (element.type === 'text') return element.value ?? '';

  return (element.children ?? []).map(textOf).join('');
}

/**
 * The source of a block that says it is a diagram, or null for anything else.
 *
 * Read from the fence's own language rather than guessed from the content: a block that
 * merely looks like mermaid is still a block of code someone wanted to read as code.
 */
function mermaidIn(node: unknown): string | null {
  const pre = node as { children?: { tagName?: string; properties?: { className?: unknown } }[] } | undefined;
  const code = pre?.children?.find((child) => child.tagName === 'code');
  if (!code) return null;

  const classes = Array.isArray(code.properties?.className) ? (code.properties.className as string[]) : [];
  return classes.includes('language-mermaid') ? textOf(code) : null;
}

/**
 * What HTML a reply may bring with it.
 *
 * Replies do use HTML, and `<details>` in particular: showing the tags as text was worse
 * than useless. The default schema is GitHub's, which covers that and strips scripts,
 * event handlers and javascript: URLs. The additions are the class names remark-math
 * marks its output with, which rehype-katex needs to find afterwards.
 */
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ['className', 'math', 'math-inline']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'math', 'math-display']],
  },
};

/**
 * A message, rendered as the markdown it was written as.
 *
 * Replies are written to be read as markdown, so showing the source leaves headings,
 * emphasis and lists as punctuation to read past.
 */
export const Markdown = memo(function Markdown({
  body,
  anchor,
  streaming,
}: {
  body: string;
  anchor?: string;
  /** Still arriving, so anything that needs the whole of it should wait. */
  streaming?: boolean;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkGemoji]}
        // Order matters: raw HTML is parsed, then sanitised, and only then is maths turned
        // into markup - the other way round and its output would be stripped again.
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, schema],
          // After sanitising, so the classes it marks tokens with survive, and with an
          // explicit set of languages: an unknown one is left plain rather than guessed at.
          [rehypeHighlight, { languages, aliases }],
          rehypeKatex,
          ...(anchor ? ([rehypeSlug, scopeAnchors(anchor)] as const) : []),
        ]}
        components={{
          // A block of code is the thing most often wanted out of a reply, and selecting it
          // by hand catches the line numbers of whatever is around it.
          pre: ({ children, node }) => {
            const diagram = mermaidIn(node);
            // A picture written as text, which the terminal could only ever show as text.
            if (diagram !== null) return <Mermaid source={diagram} streaming={streaming} />;

            return (
              <div className="block">
                <CopyButton text={textOf(node)} what="code" />
                <pre>{children}</pre>
              </div>
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                // A link within the reply is a place in this window, not a document for
                // the operating system to make sense of.
                if (href?.startsWith('#')) {
                  event.preventDefault();
                  document.getElementById(href.slice(1))?.scrollIntoView({ block: 'center' });
                  return;
                }

                // Only an address the system can actually act on is handed to it. A path
                // relative to the working directory means a file, which is #78's to open.
                if (href && /^[a-z][a-z0-9+.-]*:/i.test(href)) {
                  event.preventDefault();
                  void openUrl(href);
                  return;
                }

                // Anything else would navigate the webview away from the only window there
                // is, with no way back.
                event.preventDefault();
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
});
