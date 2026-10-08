import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { scrub } from "@chopin/ledger";

/** Background diagnostics go to their own file; log write failures are reported after the UI exits. */
export async function openDiagnostics(path: string): Promise<{ record(error: Error): void; close(): Promise<void> }> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a", 0o600);
  let pending = Promise.resolve();
  let failure: unknown;
  return {
    record(error) {
      const line = JSON.stringify({ time: new Date().toISOString(), message: scrub(error.message) }) + "\n";
      pending = pending.then(async () => { await file.write(line); }).catch((error: unknown) => { failure ??= error; });
    },
    async close() {
      await pending;
      await file.close();
      if (failure !== undefined) throw new Error("Could not persist background diagnostics", { cause: failure });
    },
  };
}
