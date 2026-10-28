import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentService } from "@chopin-ai/harness-pi";
import { writeWhole } from "../home.js";

const OWNER = "local";
const MARKS = "exported.json";

/**
 * Writes each conversation changed since it was last written as an ACP transcript in `directory`, one file per
 * conversation, so the loop reads what it learns from without opening the project's store. Says how many it wrote.
 */
export async function exportTranscripts(service: AgentService, directory: string): Promise<number> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const marksFile = join(directory, MARKS);
  const marks = await readFile(marksFile, "utf8").then((text) => JSON.parse(text) as Record<string, number>, () => ({} as Record<string, number>));
  let written = 0;
  for (const changed of await service.changedSince(OWNER, marks, BACKGROUND_CONTEXT)) {
    await writeWhole(join(directory, `${changed.id}.jsonl`), changed.transcript.map((entry) => `${JSON.stringify(entry)}\n`).join(""), 0o600);
    marks[String(changed.id)] = changed.modified;
    written += 1;
  }
  if (written > 0) await writeWhole(marksFile, JSON.stringify(marks), 0o600);
  return written;
}
