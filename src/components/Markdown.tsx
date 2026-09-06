import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * A message, rendered as the markdown it was written as.
 *
 * Replies are written to be read as markdown, so showing the source leaves headings,
 * emphasis and lists as punctuation to read past. Raw HTML is not rendered: agent output
 * is not trusted markup, and nothing needs it.
 */
export const Markdown = memo(function Markdown({ body }: { body: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
