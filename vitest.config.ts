import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // scripts/ is scanned too: the composition check's verdicts are part of the discipline; it
    // missed once, and the whole preset failed to mount and the process would not start.
    include: ["packages/*/tests/**/*.spec.ts", "scripts/tests/**/*.spec.ts"],
  },
});
