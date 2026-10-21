import { resolve } from "node:path";
import { loadLayer } from "./layer/layer.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** A `chopin` subcommand; `name` may span several words, such as `layer check`. */
export interface Command {
  name: string;
  /** Its arguments, as shown in the usage. */
  args: string;
  summary: string;
  /** @returns The process exit code. */
  run(args: readonly string[], io: CliIo): Promise<number>;
}

export const coreCommands: readonly Command[] = [{
  name: "layer check",
  args: "<dir>",
  summary: "validate a mutable layer directory",
  run: async (args, io) => {
    if (args.length !== 1) return usageError(io, "layer check <dir>");
    return layerCheck(resolve(args[0] ?? ""), io);
  },
}];

/** @returns The process exit code. */
export async function runCli(argv: readonly string[], io: CliIo, commands: readonly Command[] = coreCommands): Promise<number> {
  const command = commands.find((c) => c.name.split(" ").every((word, i) => argv[i] === word));
  if (command !== undefined) return command.run(argv.slice(command.name.split(" ").length), io);
  const asked = argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "");
  const usage = ["usage: chopin <command>", "", "commands:", ...commands.flatMap((c) => [`  ${c.name} ${c.args}`.trimEnd(), `      ${c.summary}`])];
  (asked ? io.out : io.err)(usage.join("\n"));
  return asked ? 0 : 2;
}

function usageError(io: CliIo, usage: string): number {
  io.err(`usage: chopin ${usage}`);
  return 2;
}

async function layerCheck(directory: string, io: CliIo): Promise<number> {
  const result = await loadLayer(directory);
  if (!result.ok) {
    for (const problem of result.problems) io.err(problem);
    return 1;
  }
  const { instructions, skills, mcpServers, gates } = result.layer;
  io.out([
    `instructions: ${instructions === undefined ? "none" : "AGENTS.md"}`,
    `skills: ${skills.map((s) => s.name).join(", ") || "none"}`,
    `mcp servers: ${Object.keys(mcpServers).join(", ") || "none"}`,
    `gate rules: ${gates.length}`,
  ].join("\n"));
  return 0;
}
