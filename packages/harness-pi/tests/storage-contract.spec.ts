import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, it } from "vitest";
import { openSealedStore } from "../src/sealed-store.js";

describe("sealed storage contract", () => {
  const cases = createStorageConformance({
    assertions: {
      ok: assert.ok,
      strictEqual: assert.strictEqual,
      deepEqual: assert.deepStrictEqual,
      partialDeepEqual: assert.partialDeepStrictEqual,
      greaterThan: (actual, expected) => assert(actual > expected),
      rejects: async (operation, includes) => {
        await assert.rejects(operation, (error) => error instanceof Error && error.message.includes(includes));
      },
    },
    withStorage: async (use) => {
      const dir = await mkdtemp(join(tmpdir(), "chopin-storage-contract-"));
      const storage = await openSealedStore({ dir, key: randomBytes(32) });
      try { await use(storage); }
      finally { await storage.close(BACKGROUND_CONTEXT); }
    },
  });
  for (const test of cases) it(test.name, () => test.run());
});
