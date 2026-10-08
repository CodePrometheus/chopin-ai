import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.e2e.ts"],
    // A real composition boots a child process, an order of magnitude slower than unit tests.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
