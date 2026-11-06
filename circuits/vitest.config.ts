import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // snarkjs/ffjavascript spawn worker threads; keep files in one process each.
    pool: "forks",
  },
});
