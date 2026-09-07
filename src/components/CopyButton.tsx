import { useCopy } from '../lib/useCopy';

/**
 * Copy this, whatever this is.
 *
 * Hidden until the block it belongs to is hovered or focused, since a transcript is mostly
 * read and a button on every block would be most of what is on screen. Focus counts as
 * well as hover, or it would be unreachable without a mouse.
 */
export function CopyButton({ text, what }: { text: string; what: string }) {
  const { copied, failed, copy } = useCopy();

  return (
    <button
      type="button"
      className="copy"
      onClick={() => copy(text)}
      aria-label={copied ? `${what} copied` : `Copy ${what}`}
      title={`Copy ${what}`}
    >
      {copied ? 'Copied' : failed ? 'Failed' : 'Copy'}
    </button>
  );
}
