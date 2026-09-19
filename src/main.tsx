import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { adviceFor, windowOrphaned } from './lib/staleWindow';
import { loadStores } from './lib/store';

const root = document.getElementById('root') as HTMLElement;

/**
 * Render startup and render failures into the page.
 * Without this a thrown error leaves an empty document, which against the dark
 * background is indistinguishable from the app simply not having loaded.
 */
function showFatal(detail: string): void {
  root.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = `Copilot CLI Desktop failed to start.\n\n${detail}`;
  root.appendChild(pre);
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; advice: string | null }
> {
  state = { error: null as Error | null, advice: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  /**
   * Ask, once, whether this window is running code that exists nowhere.
   *
   * After the error rather than before it: a window that is fine has no reason to be
   * checking on its own server, and the answer is only worth anything beside a crash.
   */
  componentDidCatch() {
    void windowOrphaned().then((orphaned) => this.setState({ advice: adviceFor(orphaned) }));
  }

  render() {
    const { error, advice } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="fatal">
        <p>Something broke while rendering.</p>
        {/* Said before the stack, because the stack names whatever was being drawn and
            that is the wrong place to start looking when the build is the problem. */}
        {advice && <p className="fatal-advice">{advice}</p>}
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
        <pre>{error.stack ?? error.message}</pre>
      </div>
    );
  }
}

window.addEventListener('error', (event) => {
  if (!root.hasChildNodes()) showFatal(String(event.error ?? event.message));
});

window.addEventListener('unhandledrejection', (event) => {
  if (!root.hasChildNodes()) showFatal(String(event.reason));
});

/**
 * Read what the app remembers before drawing anything.
 *
 * Awaited rather than fetched as the app runs, because every hook that reads a setting does
 * so while rendering and cannot wait. One await here means all of them stay synchronous.
 *
 * A failure is swallowed by `loadStores` itself: an app with default settings beats no app.
 */
loadStores()
  .catch(() => undefined)
  .then(() => {
    try {
      ReactDOM.createRoot(root).render(
        <React.StrictMode>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </React.StrictMode>,
      );
    } catch (error) {
      showFatal(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
  });
