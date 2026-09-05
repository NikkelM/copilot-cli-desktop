import { afterEach } from 'vitest';

// Sidecar tests run without a DOM, where there is nothing to unmount and loading the
// React testing library would only cost startup time.
afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});
