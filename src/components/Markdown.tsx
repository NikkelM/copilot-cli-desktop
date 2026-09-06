import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkGemoji from 'remark-gemoji';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { openUrl } from '@tauri-apps/plugin-opener';
import 'katex/dist/katex.min.css';

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
export const Markdown = memo(function Markdown({ body }: { body: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkGemoji]}
        // Order matters: raw HTML is parsed, then sanitised, and only then is maths turned
        // into markup - the other way round and its output would be stripped again.
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema], rehypeKatex]}
        components={{
          // A link would otherwise navigate the webview away from the app, with no way
          // back: this is a window onto sessions, not a browser.
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) void openUrl(href);
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
