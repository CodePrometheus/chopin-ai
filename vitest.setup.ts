import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test runs against a chopin home of its own, never the machine's.
process.env.CHOPIN_HOME = await mkdtemp(join(tmpdir(), "chopin-test-home-"));
