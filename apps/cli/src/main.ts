#!/usr/bin/env node
/** Command dispatch and child process lifecycle; management commands load on demand. */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repoRoot, PROFILES, dshHome, llmProxy, proxiedEnv, ensureStdio, preloadArgs, objcQuietEnv, dshBin } from "./environment.js";
import { EVOLUTION_SUPERVISOR_FLAG, shouldSuperviseInvocation } from "./service.js";

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv.filter((argument) => argument !== EVOLUTION_SUPERVISOR_FLAG);
  if (argv[0] === "experience") {
    const { experienceStatuses, readExperienceEvents, renderExperienceStatus } = await import("@chopin/evolution-runtime/status");
    const events = await readExperienceEvents(process.env.CHOPIN_EVOLUTION_EVENTS
      ?? join(homedir(), ".chopin", "evolution", "events.jsonl"));
    const id = argv[1];
    if (argv.length > 2) throw new Error("usage: chopin experience [artifact-id|--json]");
    const items = experienceStatuses(events);
    const selected = id === undefined || id === "--json" ? items : items.filter((item) => item.id === id);
    if (id !== undefined && id !== "--json" && selected.length === 0) throw new Error("experience not found");
    console.log(id === "--json" ? JSON.stringify(selected, null, 2) : renderExperienceStatus(selected, id !== undefined));
    return;
  }
  if (argv[0] === "evolution-reconcile") {
    const { reconcileEvolutionGeneration } = await import("./evolution.js");
    const generation = argv[1];
    if (generation === undefined) throw new Error("usage: chopin evolution-reconcile <generation>");
    const configIndex = argv.indexOf("--config");
    const configPath = configIndex >= 0 && argv[configIndex + 1] !== undefined
      ? resolve(argv[configIndex + 1] as string)
      : join(repoRoot, "config", "evolution-reconcile.cordis.yml");
    const result = await reconcileEvolutionGeneration(configPath, generation);
    console.log(JSON.stringify(result, null, 2));
    if (result.failedRequestIds.length > 0) process.exitCode = 1;
    return;
  }
  if (argv[0] === "evolution-supervise") {
    const { startEvolutionSupervisor, superviseEvolution } = await import("./evolution.js");
    const eventsFile = process.env.CHOPIN_EVOLUTION_EVENTS
      ?? join(homedir(), ".chopin", "evolution", "events.jsonl");
    const input = {
      eventsFile,
      mainScript: fileURLToPath(import.meta.url),
      configPath: join(repoRoot, "config", "evolution-reconcile.cordis.yml"),
      onError: (error: Error) => console.error(`chopin evolution supervisor: ${error.message}`),
    };
    if (argv.includes("--once")) {
      const results = await superviseEvolution(input);
      console.log(JSON.stringify({ processed: results.length, results }, null, 2));
      if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
      return;
    }
    const supervisor = await startEvolutionSupervisor(input);
    console.log(JSON.stringify({ watching: eventsFile }, null, 2));
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await supervisor.stop();
    return;
  }
  if (argv[0] === "service") {
    const { installService } = await import("./service.js");
    await installService(fileURLToPath(import.meta.url), argv.slice(1));
    return;
  }
  if (argv[0] === "install") {
    const { install } = await import("./installation.js");
    await install(argv.includes("--prepare-only"));
    return;
  }
  // `dsh --profile <name>` already means "start this profile's app": the installed UI bundle
  // decides which UI starts; dsh's own `web` subcommand is only an alias for `--profile web`
  // and cannot be stacked. So chopin's `web` just picks the profile and is then stripped.
  // The app's own arguments pass through untouched.
  const [head, ...rest] = argv;
  const profile = head === "web" ? PROFILES.web : PROFILES.tui;
  const forwarded = head === "web" ? rest : argv;
  const profileDir = join(dshHome(), "profiles", profile.name);
  await ensureStdio();
  const childArgs = [...(await preloadArgs()), await dshBin(), "--profile", profile.name, ...forwarded];
  const childEnv = {
    ...proxiedEnv(await llmProxy()),
    ...objcQuietEnv(),
    // The preload resolves the profile's copy of MemOS through this: chopin's packages are
    // linked in, so resolution from this package's real path cannot find it.
    CHOPIN_PROFILE_DIR: profileDir,
  };
  const diagnostics = shouldSuperviseInvocation(argv)
    ? await (await import("./diagnostics.js")).openDiagnostics(join(dshHome(), "logs", "chopin-supervisor.jsonl")) : undefined;
  const evolutionSupervisor = diagnostics !== undefined
    ? await (await import("./evolution.js")).startEvolutionSupervisor({
        eventsFile: process.env.CHOPIN_EVOLUTION_EVENTS ?? join(homedir(), ".chopin", "evolution", "events.jsonl"),
        mainScript: fileURLToPath(import.meta.url),
        configPath: join(repoRoot, "config", "evolution-reconcile.cordis.yml"),
        onError: (error) => diagnostics.record(error),
      })
    : undefined;
  const stopSupervisor = async () => {
    try { await evolutionSupervisor?.stop(); }
    finally { await diagnostics?.close(); }
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, childArgs, { stdio: "inherit", env: childEnv });
  } catch (error) {
    await stopSupervisor();
    throw error;
  }
  // A spawn failure arrives as the child's error event, not through main()'s promise; without
  // this listener it is a crash with no context. EBADF is trickier: it throws synchronously
  // inside spawn() and never reaches here, so the real defense is ensureStdio() above.
  if (evolutionSupervisor === undefined) {
    child.on("error", (err) => {
      console.error(`chopin: failed to start dsh (profile ${profile.name}): ${err.message}`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal !== null) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
    return;
  }

  let stopping = false;
  const stopSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const removeStopHandlers = () => {
    for (const signal of stopSignals) process.off(signal, stopFromSignal);
  };
  const stopFromSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
    void stopSupervisor().catch((error: unknown) => {
      console.error(`chopin: background shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      removeStopHandlers();
      process.kill(process.pid, signal);
    });
  };
  for (const signal of stopSignals) process.once(signal, stopFromSignal);
  child.once("error", (error) => {
    if (stopping) return;
    stopping = true;
    console.error(`chopin: failed to start dsh (profile ${profile.name}): ${error.message}`);
    void stopSupervisor().catch((error: unknown) => {
      console.error(`chopin: background shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => process.exit(1));
  });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    stopping = true;
    removeStopHandlers();
    void stopSupervisor().then(() => {
      if (signal !== null) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    }, (error: unknown) => {
      console.error(`chopin: background shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  });
}

main().catch((err: unknown) => {
  console.error(`chopin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
