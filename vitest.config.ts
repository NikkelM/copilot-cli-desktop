import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Both halves of the app are covered: the sidecar owns the data, the frontend owns
    // how it is presented, and most of the bugs so far have been in the seam between them.
    include: ['src/**/*.test.ts', 'sidecar/**/*.test.ts', 'shared/**/*.test.ts'],
    environment: 'node',
  },
});
