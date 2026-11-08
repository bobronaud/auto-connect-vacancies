import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  envDir: false,
  test: {
    include: ['test/**/*.test.ts'],
    env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? resolve('.data/browsers') },
  },
});
