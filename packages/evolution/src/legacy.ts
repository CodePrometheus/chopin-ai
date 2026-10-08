import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { parse } from "yaml";

import { candidateMerged, candidateObserved, candidateRejected } from "./candidate.js";
import type { EvolutionEvent } from "./types.js";
import type { EvolutionEventStore } from "./store.js";

const LEGACY_STATES = ["pending", "promoted", "rejected", "merged"] as const;
type LegacyState = (typeof LEGACY_STATES)[number];

interface LegacyEntry {
  id: string;
  sessions?: number;
  occurrences?: number;
  proposal?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  mergedInto?: string;
  [key: string]: unknown;
}

export interface LegacyImportPlan {
  events: EvolutionEvent[];
  files: string[];
  warnings: string[];
}

export interface LegacyImportResult extends LegacyImportPlan {
  appended: number;
  skipped: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventId(path: string, content: string, step: string): string {
  return `legacy-${sha256(`${path}\0${content}\0${step}`)}`;
}

function canonicalTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

async function legacyFiles(root: string): Promise<Array<{ state: LegacyState; path: string }>> {
  const files: Array<{ state: LegacyState; path: string }> = [];
  for (const state of LEGACY_STATES) {
    const directory = state === "pending" ? root : join(root, state);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.sort()) {
      if (name.endsWith(".yaml")) files.push({ state, path: join(directory, name) });
    }
  }
  return files;
}

/** Only plans the import; the caller must explicitly run importLegacyPending to write JSONL. */
export async function planLegacyPendingImport(root: string): Promise<LegacyImportPlan> {
  const events: EvolutionEvent[] = [];
  const files: string[] = [];
  const warnings: string[] = [];
  const now = new Date().toISOString();

  for (const legacy of await legacyFiles(root)) {
    const content = await readFile(legacy.path, "utf8");
    const parsed = parse(content) as LegacyEntry;
    if (typeof parsed?.id !== "string" || parsed.id.trim() === "") {
      warnings.push(`${relative(root, legacy.path)}: missing id`);
      continue;
    }
    files.push(legacy.path);
    const occurredAt = canonicalTimestamp(parsed.firstSeenAt ?? parsed.lastSeenAt, now);
    const source = { path: relative(root, legacy.path), sha256: sha256(content), state: legacy.state };
    events.push(candidateObserved({
      eventId: eventId(legacy.path, content, "observed"),
      occurredAt,
      candidateId: parsed.id,
      actor: { kind: "import", id: "legacy-pending-yaml" },
    }, {
      signalKey: typeof parsed.key === "string" ? parsed.key : `legacy:${parsed.id}`,
      lesson: typeof parsed.lesson === "string" ? parsed.lesson : `Legacy candidate ${parsed.id}`,
      evidence: {
        evidenceId: `legacy-${sha256(`${legacy.path}\0${content}`)}`,
        class: "session-signal",
        independenceKey: `legacy:${relative(root, legacy.path)}`,
        independentUnits: Math.max(1, parsed.sessions ?? 1),
        observedAt: occurredAt,
        contentHash: `sha256:${source.sha256}`,
        summary: typeof parsed.evidence === "string" ? parsed.evidence : `${parsed.occurrences ?? 1} legacy occurrence(s)`,
        sourceRef: source.path,
      },
    }));

    if (legacy.state === "rejected") {
      events.push(candidateRejected({
        eventId: eventId(legacy.path, content, "rejected"),
        occurredAt,
        candidateId: parsed.id,
        actor: { kind: "import", id: "legacy-pending-yaml" },
      }, "imported legacy rejection"));
    } else if (legacy.state === "merged") {
      events.push(candidateMerged({
        eventId: eventId(legacy.path, content, "merged"),
        occurredAt,
        candidateId: parsed.id,
        actor: { kind: "import", id: "legacy-pending-yaml" },
      }, parsed.mergedInto ?? "unknown"));
    } else if (legacy.state === "promoted") {
      warnings.push(`${relative(root, legacy.path)}: legacy promoted state has no artifact digest or structured root cause; imported as observed`);
    }
  }
  return { events, files, warnings };
}

/** Explicitly and idempotently import legacy pending YAML; an existing event id is not appended again. */
export async function importLegacyPending(store: EvolutionEventStore, root: string): Promise<LegacyImportResult> {
  const plan = await planLegacyPendingImport(root);
  const existing = new Set((await store.readAll()).map((event) => event.eventId));
  const fresh = plan.events.filter((event) => !existing.has(event.eventId));
  await store.appendMany(fresh);
  return { ...plan, appended: fresh.length, skipped: plan.events.length - fresh.length };
}
