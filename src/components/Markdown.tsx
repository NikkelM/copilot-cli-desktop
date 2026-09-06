import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkGemoji from 'remark-gemoji';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import { openUrl } from '@tauri-apps/plugin-opener';

import { scopeAnchors } from '../lib/scopeAnchors';
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
export const Markdown = memo(function Markdown({ body, anchor }: { body: string; anchor?: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkGemoji]}
        // Order matters: raw HTML is parsed, then sanitised, and only then is maths turned
        // into markup - the other way round and its output would be stripped again.
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, schema],
          rehypeKatex,
          ...(anchor ? ([rehypeSlug, scopeAnchors(anchor)] as const) : []),
        ]}
        components={{
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
