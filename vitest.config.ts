import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Both halves of the app are covered: the sidecar owns the data, the frontend owns
    // how it is presented, and most of the bugs so far have been in the seam between them.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'sidecar/**/*.test.ts', 'shared/**/*.test.ts'],
    // Node by default, since the sidecar has no DOM. Component tests opt in with a
    // `@vitest-environment jsdom` docblock.
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
  },
});
