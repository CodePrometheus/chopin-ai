import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface UltraStateEvent {
  version: 1;
  eventId: string;
  order: number;
  sessionId: string;
  state: "active" | "restore-pending" | "restored";
  generation: string;
  provider: string;
  model: string;
  effort?: string;
  createdAt: string;
}

const EVENT_FILE = /^(\d{16})-([0-9a-f-]+)\.jsonl$/;
const MAX_EVENT_BYTES = 16 * 1024;
const STATE_RANK = { active: 0, "restore-pending": 1, restored: 2 } as const;

export class UltraStateCorruptError extends Error {
  constructor(path: string, message: string) {
    super(`Ultra state ${path}: ${message}`);
    this.name = "UltraStateCorruptError";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value === "") throw new Error(`${field} must be a non-empty string`);
}

function parseEvent(value: unknown, expectedSessionId: string, expectedOrder: number, expectedEventId: string): UltraStateEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("event must be an object");
  const event = value as Partial<UltraStateEvent>;
  if (event.version !== 1) throw new Error("version must be 1");
  nonEmpty(event.eventId, "eventId");
  if (event.eventId !== expectedEventId) throw new Error("eventId does not match the event filename");
  if (event.order !== expectedOrder) throw new Error("order does not match the event filename");
  nonEmpty(event.sessionId, "sessionId");
  if (event.sessionId !== expectedSessionId) throw new Error("sessionId does not match the state directory identity");
  if (event.state !== "active" && event.state !== "restore-pending" && event.state !== "restored") {
    throw new Error("state is invalid");
  }
  nonEmpty(event.generation, "generation");
  nonEmpty(event.provider, "provider");
  nonEmpty(event.model, "model");
  if (event.effort !== undefined) nonEmpty(event.effort, "effort");
  nonEmpty(event.createdAt, "createdAt");
  if (Number.isNaN(Date.parse(event.createdAt))) throw new Error("createdAt must be an ISO timestamp");
  return event as UltraStateEvent;
}

/** One immutable, atomically published JSONL event file per state transition. */
export class UltraStateStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {}

  append(input: Omit<UltraStateEvent, "version" | "eventId" | "order" | "createdAt">): Promise<UltraStateEvent> {
    return this.enqueue(async () => {
      const sessionDir = this.sessionDir(input.sessionId);
      await this.ensureDirectory(sessionDir);
      const files = await this.eventFiles(sessionDir);
      const previous = files.at(-1)?.order ?? 0;
      const order = Math.max(Date.now(), previous + 1);
      const event: UltraStateEvent = {
        version: 1,
        eventId: randomUUID(),
        order,
        ...input,
        createdAt: new Date().toISOString(),
      };
      const body = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(body, "utf8") > MAX_EVENT_BYTES) {
        throw new UltraStateCorruptError(sessionDir, `event exceeds ${MAX_EVENT_BYTES} bytes`);
      }

      const filename = `${String(order).padStart(16, "0")}-${event.eventId}.jsonl`;
      const finalPath = join(sessionDir, filename);
      const temporary = join(sessionDir, `.${filename}.tmp-${process.pid}-${randomUUID()}`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(body, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, finalPath);
        await this.syncDirectory(sessionDir);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return event;
    });
  }

  latest(sessionId: string): Promise<UltraStateEvent | undefined> {
    return this.enqueue(async () => {
      const sessionDir = this.sessionDir(sessionId);
      if (!(await exists(sessionDir))) return undefined;
      const generations = new Map<string, { first: number; latest: UltraStateEvent }>();
      const files = await this.eventFiles(sessionDir);
      for (const [index, file] of files.entries()) {
        const event = await this.readEvent(sessionDir, sessionId, file);
        const generation = generations.get(event.generation);
        if (generation === undefined) {
          if (event.state !== "active") {
            throw new UltraStateCorruptError(join(sessionDir, file.filename), "generation must begin with active state");
          }
          generations.set(event.generation, { first: index, latest: event });
        } else if (STATE_RANK[event.state] >= STATE_RANK[generation.latest.state]) {
          generation.latest = event;
        }
      }
      return [...generations.values()].sort((left, right) => left.first - right.first).at(-1)?.latest;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(operation);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private sessionDir(sessionId: string): string {
    return join(this.dir, createHash("sha256").update(sessionId).digest("hex"));
  }

  private async eventFiles(sessionDir: string): Promise<Array<{ filename: string; order: number; eventId: string }>> {
    const files = await readdir(sessionDir);
    return files.flatMap((filename) => {
      if (filename.startsWith(".") && filename.includes(".tmp-")) return [];
      const match = EVENT_FILE.exec(filename);
      if (match?.[1] === undefined) {
        if (filename.endsWith(".jsonl")) throw new UltraStateCorruptError(join(sessionDir, filename), "invalid event filename");
        return [];
      }
      const order = Number(match[1]);
      if (!Number.isSafeInteger(order) || order < 1) {
        throw new UltraStateCorruptError(join(sessionDir, filename), "invalid event order");
      }
      return [{ filename, order, eventId: match[2] as string }];
    }).sort((left, right) => left.order - right.order || left.filename.localeCompare(right.filename));
  }

  private async readEvent(
    sessionDir: string,
    sessionId: string,
    file: { filename: string; order: number; eventId: string },
  ): Promise<UltraStateEvent> {
    const path = join(sessionDir, file.filename);
    const body = await readFile(path, "utf8");
    if (!body.endsWith("\n") || body.slice(0, -1).includes("\n")) {
      throw new UltraStateCorruptError(path, "event file must contain exactly one terminated JSON line");
    }
    if (Buffer.byteLength(body, "utf8") > MAX_EVENT_BYTES) {
      throw new UltraStateCorruptError(path, `event exceeds ${MAX_EVENT_BYTES} bytes`);
    }
    try {
      return parseEvent(JSON.parse(body), sessionId, file.order, file.eventId);
    } catch (error) {
      throw new UltraStateCorruptError(path, error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureDirectory(sessionDir: string): Promise<void> {
    const parent = dirname(this.dir);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    await Promise.all([
      this.syncDirectory(parent),
      this.syncDirectory(this.dir),
      this.syncDirectory(sessionDir),
    ]);
  }

  private async syncDirectory(path: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
