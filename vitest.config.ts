import { cpus } from 'node:os';

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * How many test files to run at once.
 *
 * Vitest defaults to one worker per core, which on this project is a bad trade: each worker
 * loads jsdom and React, and the machine running the suite is usually also running the app
 * and a Copilot server. Measured on sixteen cores with the app up, the whole suite took
 * 114.6s at the default, 60.0s at eight, and 50.8s at four - it is not that fewer workers
 * are merely safer, they are more than twice as fast, because oversubscribed memory thrashes.
 *
 * A quarter of the cores, floored at two so a small machine still runs things in parallel
 * and capped at six because the curve is flat past four and starts climbing again.
 */
const workers = Math.max(2, Math.min(6, Math.round(cpus().length / 4)));

export default defineConfig({
  plugins: [react()],
  test: {
    // Both halves of the app are covered: the sidecar owns the data, the frontend owns
    // how it is presented, and most of the bugs so far have been in the seam between them.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'sidecar/**/*.test.ts', 'shared/**/*.test.ts'],
    // Node by default, since the sidecar has no DOM. Component tests opt in with a
    // `@vitest-environment jsdom` docblock.
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    maxWorkers: workers,
  },
});
