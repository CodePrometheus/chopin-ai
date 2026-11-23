import { createHash } from "node:crypto";
import { defineDocFamily } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { PublishedArtifactSchema, type ArtifactContentPage, type GoalArtifact, type PublishedArtifact } from "./contracts.js";
import type { GoalStore } from "./store.js";

export const ArtifactToolSchema = Type.Unsafe<PublishedArtifact>(PublishedArtifactSchema);

type FileVersion = { device: string; inode: string; size: string; modifiedNs: string; changedNs: string };
export type ArtifactRecord = {
  metadata: PublishedArtifact;
  path: string;
  captureOperationId: string;
  sourceTaskId: number;
  version: FileVersion;
  pageBytes: number;
};

export const ArtifactDoc = defineDocFamily<{ published: ArtifactRecord[] }, null>({
  kind: "chopin.goal-artifact", version: 1, scope: "session", family: true,
  initial: () => ({ published: [] }), checkpointWhen: () => true,
});

export const ArtifactContentDoc = defineDocFamily<{ data: string | null }, null>({
  kind: "chopin.goal-artifact-content", version: 1, scope: "session", family: true,
  initial: () => ({ data: null }), checkpointWhen: () => true,
});

export function artifactPath(path: string): boolean {
  return !/[\\\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function artifactDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Each decimal 64-bit value and its delimiter require at most 21 bytes.
export const CAPTURE_HEADER_BYTES = 5 * 21;
// Account for the complete JSON envelope within the uncompressed wire part bound.
const PAGE_ENVELOPE_BYTES = JSON.stringify({offset: Number.MAX_SAFE_INTEGER, data: "", nextOffset: Number.MAX_SAFE_INTEGER}).length;
export const MAX_ARTIFACT_PAGE_BYTES = Math.floor((16 * 1024 * 1024 - PAGE_ENVELOPE_BYTES) / 4) * 3;

export function capturedArtifact(raw: Buffer, maximum: number): { version: FileVersion; bytes: Buffer } {
  const end = raw.indexOf(10);
  if (end < 0 || end >= CAPTURE_HEADER_BYTES) throw new Error("artifact has no complete capture version");
  const header = raw.subarray(0, end).toString("latin1");
  const [device, inode, size, modifiedNs, changedNs] = header.split(" ");
  if (!/^\d+ \d+ \d+ -?\d+ -?\d+$/.test(header) || device === undefined || inode === undefined ||
    size === undefined || modifiedNs === undefined || changedNs === undefined) throw new Error("invalid artifact capture version");
  const bytes = raw.subarray(end + 1);
  if (bytes.length > maximum || String(bytes.length) !== size) throw new Error("artifact capture did not return its complete bytes");
  return { version: { device, inode, size, modifiedNs, changedNs }, bytes };
}

export function artifactPageKey(artifactId: string, offset: number): string {
  return `${artifactId}:${offset}`;
}

export async function verifyPublishedArtifact(store: GoalStore, goal: string, artifact: GoalArtifact, sourceTaskId: number, context: Context): Promise<void> {
  const publications = (await store.harness.snapshot(ArtifactDoc, goal, context))?.published ?? [];
  if (!publications.some((entry) => entry.metadata.goalId === goal && entry.sourceTaskId === sourceTaskId
    && entry.path === artifact.path && entry.metadata.sha256 === artifact.sha256)) {
    throw new Error("the successful tool task has no matching published artifact");
  }
}

async function readArtifacts(store: GoalStore, goal: string, context: Context): Promise<ArtifactRecord[]> {
  const snapshot = await store.snapshot(goal, context);
  if (snapshot.status !== "completed") return [];
  const publications = (await store.harness.snapshot(ArtifactDoc, goal, context))?.published ?? [];
  if (publications.some(({metadata}) => metadata.goalId !== goal)) throw new Error("the artifact belongs to another goal");
  return publications;
}

export async function artifactList(store: GoalStore, goal: string, context: Context): Promise<PublishedArtifact[]> {
  return (await readArtifacts(store, goal, context)).map(({metadata}) => metadata);
}

export async function artifactContent(store: GoalStore, goal: string, artifactId: string, offset: number, context: Context): Promise<ArtifactContentPage | null> {
  const publication = (await readArtifacts(store, goal, context)).find(({metadata}) => metadata.artifactId === artifactId);
  if (publication === undefined) return null;
  const {pageBytes, metadata: {sizeBytes}} = publication;
  if (offset % pageBytes !== 0 || (offset !== 0 && offset >= sizeBytes)) return null;
  const data = (await store.harness.snapshot(ArtifactContentDoc, artifactPageKey(artifactId, offset), context))?.data;
  if (data == null) throw new Error("the published artifact page is missing");
  const bytes = Buffer.from(data, "base64url");
  if (bytes.toString("base64url") !== data || bytes.length !== Math.min(pageBytes, sizeBytes - offset)) {
    throw new Error("the published artifact page differs from its record");
  }
  const end = offset + bytes.length;
  return { offset, data, nextOffset: end < sizeBytes ? end : null };
}

// The worker opens only ordinary files beneath the admitted workspace directory.
export const READ_ARTIFACT = String.raw`
import os, stat, sys
path, limit = sys.argv[1], int(sys.argv[2])
parts = path.split("/")
if any(part in ("", ".", "..") for part in parts):
    raise ValueError("invalid artifact path")
directory = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
try:
    for part in parts[:-1]:
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        os.close(directory)
        directory = child
    fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as source:
        original = os.fstat(source.fileno())
        if not stat.S_ISREG(original.st_mode) or original.st_size > limit:
            raise ValueError("artifact is not an eligible file")
        output = source.read(original.st_size + 1)
        final = os.fstat(source.fileno())
        if len(output) != original.st_size or (original.st_size, original.st_mtime_ns, original.st_ctime_ns) != (final.st_size, final.st_mtime_ns, final.st_ctime_ns):
            raise ValueError("artifact changed during capture")
        version = (original.st_dev, original.st_ino, original.st_size, original.st_mtime_ns, original.st_ctime_ns)
        sys.stdout.buffer.write((" ".join(map(str, version)) + "\n").encode("ascii"))
        sys.stdout.buffer.write(output)
finally:
    os.close(directory)
`;
