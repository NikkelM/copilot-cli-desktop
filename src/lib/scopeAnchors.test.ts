import type { Element, Root } from 'hast';
import { describe, expect, it } from 'vitest';

import { scopeAnchors } from './scopeAnchors';

/**
 * The plugin run over a tree, the way the pipeline runs it.
 *
 * Built by hand rather than parsed: the ids come from rehype-slug, which runs before this
 * and is not what is under test, and the app's markdown pipeline lives inside
 * react-markdown rather than in a unified instance a test could borrow.
 */
function element(tagName: string, properties: Element['properties'], children: Element['children'] = []): Element {
  return { type: 'element', tagName, properties, children };
}

function run(nodes: Element[], prefix = 'm1'): Root {
  const tree: Root = { type: 'root', children: nodes };
  scopeAnchors(prefix)()(tree);
  return tree;
}

const first = (tree: Root) => (tree.children[0] as Element).properties;

describe("keeping one reply's anchors out of another's", () => {
  it('prefixes an id', () => {
    expect(first(run([element('h2', { id: 'findings' })])).id).toBe('m1-findings');
  });

  it('prefixes a link that points within the document', () => {
    expect(first(run([element('a', { href: '#findings' })])).href).toBe('#m1-findings');
  });

  // The whole reason for the plugin: two replies with the same heading would otherwise
  // both claim #findings, and every link to it would land on whichever came first.
  it('gives the same heading in two replies different ids', () => {
    expect(first(run([element('h2', { id: 'findings' })], 'm1')).id).toBe('m1-findings');
    expect(first(run([element('h2', { id: 'findings' })], 'm2')).id).toBe('m2-findings');
  });

  it('leaves a link to somewhere else alone', () => {
    const href = 'https://example.com/#findings';
    expect(first(run([element('a', { href })])).href).toBe(href);
  });

  it('leaves a relative link alone', () => {
    expect(first(run([element('a', { href: './notes.md' })])).href).toBe('./notes.md');
  });

  it('rewrites a nested element, not just a top-level one', () => {
    const tree = run([element('div', {}, [element('h3', { id: 'two' })])]);
    const nested = (tree.children[0] as Element).children[0] as Element;

    expect(nested.properties.id).toBe('m1-two');
  });

  it('scopes both ends of an element that is a target and a link at once', () => {
    const props = first(run([element('a', { id: 'here', href: '#there' })]));

    expect(props.id).toBe('m1-here');
    expect(props.href).toBe('#m1-there');
  });

  it('leaves an element with neither an id nor an href untouched', () => {
    expect(first(run([element('p', { className: ['lead'] })]))).toEqual({ className: ['lead'] });
  });

  // An id that is not a string is not an anchor, and hast properties allow both shapes.
  it('ignores a non-string id', () => {
    expect(first(run([element('li', { id: 3 as unknown as string })])).id).toBe(3);
  });

  it('survives an element with no properties at all', () => {
    const bare = { type: 'element', tagName: 'br', children: [] } as unknown as Element;
    const tree: Root = { type: 'root', children: [bare] };

    expect(() => scopeAnchors('m1')()(tree)).not.toThrow();
  });
});
