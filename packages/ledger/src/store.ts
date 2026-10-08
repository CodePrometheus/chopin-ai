import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { normalizeErrorString } from "./normalize.js";
import type { DefectRecord } from "./types.js";

/** Record ids are file names, so only a lowercase slug is accepted: no id can name a path outside the store. */
const RECORD_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function assertRecordId(id: string): void {
  if (!RECORD_ID.test(id)) {
    throw new Error(`invalid record id ${JSON.stringify(String(id).slice(0, 80))}: use a lowercase slug of letters, digits and dashes`);
  }
}

/**
 * File-backed defect ledger: one YAML per defect in a git-versioned directory.
 * Lookup is exact match on the normalized key only. Fuzzy/semantic search is deliberately
 * absent: a false recurrence link poisons the root-cause judgement worse than no memory would.
 */
export class LedgerStore {
  constructor(private readonly dir: string) {}

  async load(id: string): Promise<DefectRecord | undefined> {
    assertRecordId(id);
    try {
      const text = await readFile(join(this.dir, `${id}.yaml`), "utf8");
      return parse(text) as DefectRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async loadAll(): Promise<DefectRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: DefectRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".yaml")) continue;
      const text = await readFile(join(this.dir, name), "utf8");
      records.push(parse(text) as DefectRecord);
    }
    return records;
  }

  /** Look up recurrence history by raw error string (normalized first), exact match. */
  async findByError(rawError: string): Promise<DefectRecord[]> {
    const { key } = normalizeErrorString(rawError);
    const all = await this.loadAll();
    return all.filter((r) => r.errorKey === key);
  }

  /**
   * Persist one record. Writing is an explicit, approved action:
   * callers may only call this after the user has approved the root cause.
   */
  async save(record: DefectRecord): Promise<void> {
    assertRecordId(record.id);
    await mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const next: DefectRecord = { ...record, updatedAt: now, createdAt: record.createdAt || now };
    await writeFile(join(this.dir, `${record.id}.yaml`), stringify(next), "utf8");
  }
}
