import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';

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

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <pre className="fatal">{`Something broke while rendering.\n\n${error.stack ?? error.message}`}</pre>;
  }
}

window.addEventListener('error', (event) => {
  if (!root.hasChildNodes()) showFatal(String(event.error ?? event.message));
});

window.addEventListener('unhandledrejection', (event) => {
  if (!root.hasChildNodes()) showFatal(String(event.reason));
});

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
