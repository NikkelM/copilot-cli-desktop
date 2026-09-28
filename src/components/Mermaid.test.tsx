// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Mermaid } from './Mermaid';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * A diagram written as text, drawn (#90).
 *
 * Mermaid is the one dependency this app calls that nothing else covers, and it is loaded on
 * demand so a build proves only that it bundles. These tests are about the contract between
 * this component and that library: what it is asked for, and what is done with the answer.
 *
 * The library itself is stubbed rather than run. Mermaid draws by measuring text, which jsdom
 * cannot do - every layout there is zero by zero - so a real render would be asserting about
 * a browser that is not present. What matters here is ours: that the source survives a
 * failure, that a streamed fence is left alone, and that a reply which changes is redrawn.
 */
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

const GRAPH = 'graph TD;\n  A-->B;';

describe('drawing a diagram', () => {
  it('draws what mermaid gives back', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg><title>drawn</title></svg>' });

    render(<Mermaid source={GRAPH} />);

    await waitFor(() => expect(document.querySelector('.mermaid svg')).toBeTruthy());
  });

  /**
   * Models get mermaid wrong, and a diagram that will not parse must not take the message
   * with it. The source is what a terminal would have shown anyway, so it is not a last
   * resort - it is the same answer, undrawn.
   */
  it('keeps the source when the diagram will not parse', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2'));

    render(<Mermaid source={GRAPH} />);

    await waitFor(() => expect(screen.getByText(/graph TD/)).toBeTruthy());
    expect(document.querySelector('.mermaid')).toBeNull();
  });

  /**
   * A fence is incomplete for most of a streamed reply, and mermaid throws on incomplete
   * input. Waiting avoids both the failures and the work.
   *
   * Given time to have asked before asserting it did not. Loading mermaid is asynchronous,
   * so a synchronous check passes whether the guard is there or not - which it did, until
   * this waited.
   */
  it('asks for nothing while the reply is still arriving', async () => {
    render(<Mermaid source={GRAPH} streaming />);

    await new Promise((settle) => setTimeout(settle, 20));

    expect(mermaid.render).not.toHaveBeenCalled();
    expect(screen.getByText(/graph TD/)).toBeTruthy();
  });

  it('draws it once the reply has finished', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg />' });
    const { rerender } = render(<Mermaid source={GRAPH} streaming />);

    rerender(<Mermaid source={GRAPH} />);

    await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
  });

  /** Mermaid insists on an id, and two diagrams on one page must not be given the same one. */
  it('gives each diagram an id of its own', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg />' });

    render(
      <>
        <Mermaid source={GRAPH} />
        <Mermaid source={'graph LR;\n  C-->D;'} />
      </>,
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    const [first, second] = mermaid.render.mock.calls.map((call) => call[0] as string);
    expect(first).not.toBe(second);
  });

  it('draws it again when the diagram changes', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg />' });
    const { rerender } = render(<Mermaid source={GRAPH} />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());

    rerender(<Mermaid source={'graph LR;\n  C-->D;'} />);

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(mermaid.render.mock.calls[1]?.[1]).toContain('graph LR');
  });

  /**
   * A drawing already on screen is about the diagram that produced it.
   *
   * When an edited reply brings one that will not parse, keeping the old picture would put
   * a diagram under text that no longer describes it - which is worse than the source,
   * because it looks right.
   */
  it('lets go of a drawing when the diagram that replaces it will not parse', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg><title>drawn</title></svg>' });
    const { rerender } = render(<Mermaid source={GRAPH} />);
    await waitFor(() => expect(document.querySelector('.mermaid svg')).toBeTruthy());

    mermaid.render.mockRejectedValue(new Error('Parse error on line 2'));
    rerender(<Mermaid source={'graph LR;\n  broken('} />);

    await waitFor(() => expect(document.querySelector('.mermaid')).toBeNull());
    expect(screen.getByText(/broken\(/)).toBeTruthy();
  });

  /**
   * Diagrams are built into SVG in the browser and never pass through the sanitiser the rest
   * of a reply goes through, so the settings that keep that safe are worth asserting rather
   * than trusting. `suppressErrorRendering` is the other one that matters: without it a
   * diagram that fails is drawn as an error graphic into a div outside React's tree, which
   * nothing then takes away.
   *
   * The module is reset first. Mermaid is set up once and never again - it is the largest
   * thing the renderer pulls in, and the promise that loads it is held at module level - so
   * by the time any later test looks, the call it wants has already happened.
   */
  it('asks mermaid to be strict, and to draw nothing when it fails', async () => {
    vi.resetModules();
    mermaid.initialize.mockClear();
    mermaid.render.mockResolvedValue({ svg: '<svg />' });
    const { Mermaid: Fresh } = await import('./Mermaid');

    render(<Fresh source={GRAPH} />);

    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalledOnce());
    const config = mermaid.initialize.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.securityLevel).toBe('strict');
    expect(config.suppressErrorRendering).toBe(true);
    expect(config.startOnLoad).toBe(false);
  });

  // The largest thing the renderer pulls in, and most sessions hold no diagram at all.
  it('sets mermaid up once, however many diagrams there are', async () => {
    vi.resetModules();
    mermaid.initialize.mockClear();
    mermaid.render.mockResolvedValue({ svg: '<svg />' });
    const { Mermaid: Fresh } = await import('./Mermaid');

    render(
      <>
        <Fresh source={GRAPH} />
        <Fresh source={'graph LR;\n  C-->D;'} />
      </>,
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(mermaid.initialize).toHaveBeenCalledOnce();
  });
});
