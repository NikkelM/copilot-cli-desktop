import { useEffect, useState } from 'react';

/**
 * Loaded the first time a diagram appears, and never again.
 *
 * Mermaid is larger than everything else the renderer pulls in put together, and most
 * sessions contain no diagrams at all. Importing it on demand keeps that weight off every
 * session that never needs it, which is the point of an app whose premise is a small
 * footprint.
 */
let loading: Promise<typeof import('mermaid').default> | null = null;

function mermaid() {
  return (loading ??= import('mermaid').then(({ default: instance }) => {
    instance.initialize({
      startOnLoad: false,
      theme: 'dark',
      // Mermaid arrives with a palette of its own, which is nobody's dark but its own.
      themeVariables: {
        background: '#0d1117',
        primaryColor: '#161b22',
        primaryTextColor: '#e6edf3',
        primaryBorderColor: '#30363d',
        lineColor: '#8b949e',
        secondaryColor: '#161b22',
        tertiaryColor: '#0d1117',
        fontFamily: 'inherit',
      },
      // Diagrams are built into SVG in the browser and so never pass through the sanitiser
      // the rest of a reply goes through. Mermaid has a history of label-based injection,
      // so it runs at its strictest rather than trusting what the model wrote.
      securityLevel: 'strict',
      // Without this, a diagram that will not parse is still drawn - as an error graphic,
      // into a div appended to the body - and the exception is thrown before mermaid
      // removes it. The div is outside React's tree, so nothing ever takes it away, and
      // every failed attempt leaves another one pinned under the app.
      suppressErrorRendering: true,
    });
    return instance;
  }));
}

/** Only one id per diagram on the page, and mermaid insists on having one. */
let drawn = 0;

/**
 * A diagram written as text, drawn.
 *
 * The terminal can only show the source, so the agent writes one and the reader imagines
 * it. Falling back to the source is deliberate rather than a last resort: models get
 * mermaid wrong, and a diagram that will not parse must not take the message with it.
 */
export function Mermaid({ source, streaming }: { source: string; streaming?: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    // A fence is incomplete for most of a streamed reply, and mermaid throws on incomplete
    // input. Waiting for the reply to finish avoids both the failures and the work.
    if (streaming) return;

    let current = true;
    mermaid()
      .then((instance) => instance.render(`diagram-${++drawn}`, source))
      .then(({ svg: drawing }) => current && setSvg(drawing))
      // The source is worth more than an error message, and is what a terminal would have
      // shown anyway.
      .catch(() => current && setSvg(null));

    return () => {
      current = false;
    };
  }, [source, streaming]);

  if (!svg) return <pre className="mermaid-source">{source}</pre>;

  // Built by mermaid at its strictest setting rather than taken from the reply.
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
