import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/tests/**/*.spec.{ts,tsx}"],
    passWithNoTests: true,
  },
});
