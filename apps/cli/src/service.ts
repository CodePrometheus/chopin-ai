/**
 * The unattended process layer: install chopin as a resident launchd service.
 *
 * Scheduling was never what was missing: dsh ships `schedule`, so an agent can arrange
 * "run triage once at 2am every day" from inside a session; `ralph` handles long goals;
 * `dsh-client-auto-continue` resumes a round cut off by a timeout or a 5xx. What was missing
 * is the layer beneath all of those: **who restarts the process itself when it dies**. HMR
 * calls `loader.exit()` on purpose when it hits a framework-level change, counting on an
 * outside supervisor; the same goes for a machine reboot.
 *
 * launchd over pm2: native to macOS, starts at login, restarts on crash, adds no extra runtime.
 *
 * This only writes the plist and never runs `launchctl` for you: installing a system service is your call.
 *
 * @module @chopin/cli/service
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The service label in launchd, also the plist file name. */
export const SERVICE_LABEL = "ai.chopin.daemon";
/** Explicit deployment-supervision flag in the service's launch arguments. */
export const EVOLUTION_SUPERVISOR_FLAG = "--chopin-evolution-supervisor";

/** Only UI runs need deployment supervision; management, help and config diagnostics run nothing in the background. */
export function shouldSuperviseInvocation(args: readonly string[]): boolean {
  const commands = new Set(["help", "install", "service", "plugin", "experience", "evolution-reconcile", "evolution-supervise"]);
  if (commands.has(args[0] ?? "")) return false;
  const diagnostics = new Set(["-h", "--help", "-V", "--version", "--dump-config", "--dump-default-config"]);
  return !args.some((argument) => diagnostics.has(argument));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlArray(values: readonly string[]): string {
  return values.map((v) => `    <string>${escapeXml(v)}</string>`).join("\n");
}

function xmlDict(entries: readonly (readonly [string, string])[]): string {
  return entries.map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`).join("\n");
}

export interface ServicePlan {
  /** Where the plist is written. */
  path: string;
  /** The full command the service runs. */
  argv: readonly string[];
  /** Environment variables passed to the service (no secrets: credentials live in dsh's credential store). */
  env: readonly (readonly [string, string])[];
  /** Log paths for stdout and stderr. */
  logs: { out: string; err: string };
}

/**
 * Work out what the service should look like on this machine.
 *
 * Every path is absolute: launchd does not inherit your shell, so `chopin`, `node` and
 * `pnpm` all have to be findable on their own. PATH explicitly includes the current node's
 * directory, otherwise commands like `pnpm test` in declarative toolsets are not found.
 * @param mainScript - Absolute path of chopin's own entry script.
 * @param port - Port the daemon listens on.
 * @returns The complete service plan.
 */
export function planService(mainScript: string, port: number): ServicePlan {
  const logDir = join(homedir(), ".chopin", "logs");
  const nodeDir = join(process.execPath, "..");
  const env: (readonly [string, string])[] = [
    ["PATH", [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")],
    ["HOME", homedir()],
  ];
  for (const key of [
    "DSH_HOME",
    "CHOPIN_LLM_PROXY",
    "CHOPIN_LEDGER_DIR",
    "CHOPIN_GITHUB_REPO",
    "CHOPIN_REPO_PATH",
    "CHOPIN_EVOLUTION_EVENTS",
    "CHOPIN_EVOLUTION_ARTIFACTS",
    "CHOPIN_EVOLUTION_RECEIPTS",
  ]) {
    const value = process.env[key]?.trim();
    if (value !== undefined && value !== "") env.push([key, value]);
  }
  return {
    path: join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    argv: [process.execPath, mainScript, "web", "--port", String(port), "--no-open", EVOLUTION_SUPERVISOR_FLAG],
    env,
    logs: { out: join(logDir, "daemon.out.log"), err: join(logDir, "daemon.err.log") },
  };
}

/**
 * Write the plist to disk.
 * @param plan - The plan computed by {@link planService}.
 */
export async function writeServicePlist(plan: ServicePlan): Promise<void> {
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await mkdir(join(homedir(), ".chopin", "logs"), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${xmlArray(plan.argv)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${xmlDict(plan.env)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(plan.logs.out)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(plan.logs.err)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homedir())}</string>
</dict>
</plist>
`;
  await writeFile(plan.path, plist, "utf8");
}

export async function installService(mainScript: string, argv: readonly string[]): Promise<void> {
  const portIndex = argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 3080;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid --port ${String(argv[portIndex + 1])}`);

  const plan = planService(mainScript, port);
  await writeServicePlist(plan);

  console.log(`wrote ${plan.path}`);
  console.log(`  runs   ${plan.argv.slice(1).join(" ")}`);
  console.log(`  logs   ${plan.logs.out}`);
  console.log(`         ${plan.logs.err}`);
  console.log(`  env    ${plan.env.map(([k]) => k).join(", ")}`);
  console.log("");
  console.log("Load it (survives crashes and reboots):");
  console.log(`  launchctl bootstrap gui/$UID ${plan.path}`);
  console.log("");
  console.log("Other things you will want:");
  console.log(`  launchctl kickstart -k gui/$UID/${SERVICE_LABEL}   # restart after a rebuild`);
  console.log(`  launchctl bootout gui/$UID/${SERVICE_LABEL}        # stop and unload`);
  console.log("");
  console.log("With the daemon up, ask an agent to schedule its own recurring work —");
  console.log("dsh's schedule_create is already mounted, e.g. \"run triage_run once at 2am every day\".");
}
