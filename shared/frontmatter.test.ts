import { describe, expect, it } from 'vitest';

import { splitFrontmatter } from './frontmatter.js';

/**
 * Both sides of the wire read frontmatter through this. The sidecar splits a page it read
 * from disk; the app splits a page being edited, so unsaved work can be previewed without a
 * round trip. Two implementations would eventually disagree about where a page begins, and
 * a page would render differently depending on whether it had been saved yet.
 */
describe('separating frontmatter from prose', () => {
  it('takes a block that opens the page', () => {
    expect(splitFrontmatter('---\ntitle: A\n---\nbody')).toEqual({ frontmatter: 'title: A', body: 'body' });
  });

  /** The blank under the closing delimiter is the block's own formatting, not the prose. */
  it('begins the body where the reading begins', () => {
    expect(splitFrontmatter('---\ntitle: A\n---\n\n# Heading').body).toBe('# Heading');
  });

  it('keeps blank lines a page genuinely opens with', () => {
    expect(splitFrontmatter('---\ntitle: A\n---\n\n\n\n# Heading').body).toBe('\n\n# Heading');
  });

  /** A rule partway down a page is prose, and reading it as frontmatter would eat the page. */
  it('leaves a rule further down the page alone', () => {
    const source = '# Heading\n\n---\n\nmore prose';

    expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
  });

  it('leaves a page whose block never closes alone', () => {
    const source = '---\ntitle: A\n\nbody that never closes it';

    expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
  });

  it('reads a block written with carriage returns', () => {
    expect(splitFrontmatter('---\r\ntitle: A\r\n---\r\nbody').body).toBe('body');
  });

  it('reads a page saved with a byte order mark', () => {
    expect(splitFrontmatter('\ufeff---\ntitle: A\n---\nbody')).toEqual({
      frontmatter: 'title: A',
      body: 'body',
    });
  });

  it('takes a page with no frontmatter as all prose', () => {
    expect(splitFrontmatter('# Just a heading')).toEqual({ frontmatter: null, body: '# Just a heading' });
  });

  /** Half-written, which is exactly what a page being edited often is. */
  it('reads a block with nothing after it', () => {
    expect(splitFrontmatter('---\ntitle: A\n---')).toEqual({ frontmatter: 'title: A', body: '' });
  });
});
