// @vitest-environment jsdom
import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useFocusTrap } from './useFocusTrap';

/**
 * jsdom lays nothing out, so every element reports no box and would be read as off screen.
 * Answered once here rather than per test, since what is being tested is the containment
 * rather than the measuring.
 */
beforeEach(() => {
  Element.prototype.getClientRects = function () {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  document.body.innerHTML = '';
});

function Dialog({ children }: { children?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box);
  return (
    <div ref={box} tabIndex={-1} data-testid="dialog">
      {children ?? (
        <>
          <button type="button">First</button>
          <button type="button">Second</button>
          <button type="button">Last</button>
        </>
      )}
    </div>
  );
}

/** The page the dialog is drawn over, which Tab must not reach while it is open. */
function Page({ shown, children }: { shown: boolean; children?: React.ReactNode }) {
  return (
    <>
      <button type="button">Opened it</button>
      <button type="button">Behind</button>
      {shown && <Dialog>{children}</Dialog>}
    </>
  );
}

const tab = (shiftKey = false) =>
  fireEvent.keyDown(document.activeElement ?? window, { key: 'Tab', shiftKey, bubbles: true });

describe('keeping the keyboard inside a dialog', () => {
  it('comes round to the first from the last', () => {
    render(<Page shown />);
    screen.getByText('Last').focus();

    tab();

    expect(document.activeElement).toBe(screen.getByText('First'));
  });

  it('comes round to the last from the first, going backwards', () => {
    render(<Page shown />);
    screen.getByText('First').focus();

    tab(true);

    expect(document.activeElement).toBe(screen.getByText('Last'));
  });

  it('leaves a press in the middle of the list alone', () => {
    render(<Page shown />);
    screen.getByText('First').focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);

    expect(event.defaultPrevented, 'the browser already knows where to go next').toBe(false);
  });

  it('brings the keyboard back in when it is somewhere else entirely', () => {
    render(<Page shown />);
    screen.getByText('Behind').focus();

    tab();

    expect(document.activeElement).toBe(screen.getByText('First'));
  });

  /** A dialog with nothing to press is still a dialog, and Tab must not walk out of it. */
  it('holds the surface itself when there is nothing inside to land on', () => {
    render(
      <Page shown>
        <p>Nothing to press</p>
      </Page>,
    );
    screen.getByText('Behind').focus();

    tab();

    expect(document.activeElement).toBe(screen.getByTestId('dialog'));
  });

  /**
   * At the ends on purpose: a refused control in the middle of the list is skipped by the
   * browser anyway, so counting it would change nothing and the test would say nothing. At
   * either end it decides where the keyboard comes round to.
   */
  it('does not count a refused control at the end of the list', () => {
    render(
      <Page shown>
        <button type="button">First</button>
        <button type="button">Middle</button>
        <button type="button" disabled>
          Refused
        </button>
      </Page>,
    );
    screen.getByText('Middle').focus();

    tab();

    expect(document.activeElement, 'Middle is the last one that can be pressed').toBe(screen.getByText('First'));
  });

  it('does not count a refused control at the start of it', () => {
    render(
      <Page shown>
        <button type="button" disabled>
          Refused
        </button>
        <button type="button">First</button>
        <button type="button">Last</button>
      </Page>,
    );
    screen.getByText('First').focus();

    tab(true);

    expect(document.activeElement, 'First is the first one that can be pressed').toBe(screen.getByText('Last'));
  });
});

describe('giving the keyboard back when the dialog goes', () => {
  it('returns it to whatever opened it', () => {
    const view = render(<Page shown={false} />);
    screen.getByText('Opened it').focus();

    view.rerender(<Page shown />);
    screen.getByText('Second').focus();
    view.rerender(<Page shown={false} />);

    expect(document.activeElement).toBe(screen.getByText('Opened it'));
  });

  /** An action taken in the dialog can be the thing that removes the control that raised it. */
  it('drops it rather than reaching for something that has gone', () => {
    function Vanishing({ shown, opener }: { shown: boolean; opener: boolean }) {
      return (
        <>
          {opener && <button type="button">Opened it</button>}
          {shown && <Dialog />}
        </>
      );
    }

    const view = render(<Vanishing shown={false} opener />);
    screen.getByText('Opened it').focus();
    view.rerender(<Vanishing shown opener />);

    expect(() => view.rerender(<Vanishing shown={false} opener={false} />)).not.toThrow();
  });
});

/**
 * The settings window can raise a question about leaving while it is itself open. Two
 * surfaces each trying to hold the keyboard would hand it back and forth rather than contain
 * it, so the innermost answers and the one behind stands down until it closes.
 */
describe('a dialog opened over another one', () => {
  function Both({ inner }: { inner: boolean }) {
    return (
      <>
        <button type="button">Behind</button>
        <Dialog>
          <button type="button">Outer only</button>
          {inner && (
            <Dialog>
              <button type="button">Inner first</button>
              <button type="button">Inner last</button>
            </Dialog>
          )}
        </Dialog>
      </>
    );
  }

  it('is the one that answers', () => {
    render(<Both inner />);
    screen.getByText('Inner last').focus();

    tab();

    expect(document.activeElement).toBe(screen.getByText('Inner first'));
  });

  it('hands the keyboard back to the one behind when it closes', () => {
    const view = render(<Both inner />);
    screen.getByText('Outer only').focus();
    view.rerender(<Both inner={false} />);

    screen.getByText('Outer only').focus();
    tab();

    expect(document.activeElement, 'contained by the surface that is left').toBe(screen.getByText('Outer only'));
  });
});
