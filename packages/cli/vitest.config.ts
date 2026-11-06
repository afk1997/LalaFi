import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['xpool-source'] },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
