import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/helpers/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
  },
});
