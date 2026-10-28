#!/usr/bin/env node
import { coreCommands, runCli } from "@chopin-ai/core";
import { errorChain } from "@chopin-ai/harness-pi/protocol";
import { acpCommand } from "./acp.js";
import { chatCommand } from "./chat.js";
import { daemonCommand } from "./daemon.js";
import { loginCommand } from "./login.js";
import { useConfiguredProxy } from "./network.js";
import { evolveCommand, evolveCorrectionsCommand, evolveLogCommand, evolveReviewCommand, evolveStatusCommand, evolveUndoCommand } from "./rsi/evolve.js";
import { serveCommand } from "./serve.js";

const argv = process.argv.slice(2);
// The terminal and the service it starts both reach providers through the configured proxy. A bare `chopin` opens
// the conversation; `chopin help` lists every command.
process.exitCode = await useConfiguredProxy().then(() => runCli(argv.length === 0 ? ["chat"] : argv, {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}, [
  chatCommand, acpCommand, loginCommand, serveCommand, daemonCommand,
  // The longer names first, since a command is the first whose words the arguments start with.
  evolveStatusCommand, evolveLogCommand, evolveUndoCommand, evolveCorrectionsCommand, evolveReviewCommand, evolveCommand,
  ...coreCommands,
])).catch((error: unknown) => {
  process.stderr.write(`chopin: ${errorChain(error)}\n`);
  return 1;
});
