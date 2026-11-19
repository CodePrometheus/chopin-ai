import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { Command } from "@chopin-ai/core";

export const SUPERVISED_CONFIG_DIGEST = "CHOPIN_CLOUD_CONFIG_SHA256";

/** Restarts a restored service within the same protected allocation. The host owns Pod replacement. */
export async function superviseCloud(file: string, digest: string, io: Parameters<Command["run"]>[1]): Promise<number> {
  const launcher = fileURLToPath(new URL("./bin.js", import.meta.url));
  let child: ChildProcess | undefined;
  let stopping = false;
  let attempt = 0;
  const started = performance.now();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const record = (event: string, pid: number | undefined, details: object) => {
    io.out(JSON.stringify({ source: "cloud-supervisor", event, attempt, pid, at: new Date().toISOString(),
      elapsedMs: Math.floor(performance.now() - started), ...details }));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    while (!stopping) {
      attempt++;
      const service = spawn(process.execPath, [launcher, "cloud", "--config", file], {
        env: { ...process.env, [SUPERVISED_CONFIG_DIGEST]: digest },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      child = service;
      let restored = false;
      service.once("spawn", () => record("started", service.pid, {}));
      service.on("message", (message) => {
        if (restored || typeof message !== "object" || message === null ||
            !("state" in message) || message.state !== "restored" ||
            !("startupPaused" in message) || message.startupPaused !== true ||
            !("port" in message) || typeof message.port !== "number") return;
        restored = true;
        record("restored", service.pid, { port: message.port });
      });
      const [code, signal] = await once(service, "close") as [number | null, NodeJS.Signals | null];
      child = undefined;
      record("exited", service.pid, { code, signal, requested: stopping });
      if (stopping) return code ?? (signal === "SIGTERM" ? 0 : 1);
      if (!restored) return code || 1;
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
