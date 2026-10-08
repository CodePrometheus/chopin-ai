import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@chopin/evolution-runtime";
import { assertCapabilityManifest, canonicalJson, IMPROVER_TOOL, improvementDigest } from "@chopin/evolution";
import type { CapabilityManifest, JsonObject, JsonValue } from "@chopin/evolution";
import { SandboxedPlugin, PluginExecutionError } from "@chopin/plugin-sandbox";
import { improverContractFixtures } from "@chopin/evolution-runtime/improver-template";
import { verifyCapabilityFixtures } from "@chopin/plugin-sandbox";

export interface TrialCase { id: string; input: JsonObject; expected: JsonValue }
export class TrialSourceError extends Error {}
export interface TrialTask {
  id: string;
  description: string;
  manifest: CapabilityManifest;
  starter: string;
  publicCases: TrialCase[];
  hiddenCases: TrialCase[];
}
export interface Config {
  phase: string;
  mode: "solve" | "improve";
  workspace: string;
  taskFile?: string;
  taskDigest?: string;
  outputDirectory: string;
}

export const name = "chopin-rsi-trial";
export const inject = ["tools", "systemPrompt", "chopinEvolution"];

export async function writeTrialRecord(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
}

export async function readTrialTask(path: string, expectedDigest: string): Promise<TrialTask> {
  const task: TrialTask = JSON.parse(await readFile(path, "utf8"));
  if (improvementDigest(task) !== expectedDigest) throw new Error("sealed task changed");
  assertCapabilityManifest(task.manifest);
  if (!task.id || !task.description || !Array.isArray(task.publicCases) || !Array.isArray(task.hiddenCases)) throw new Error("invalid trial task");
  return task;
}

async function noSymlinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("trial workspace contains a symbolic link");
    if (entry.isDirectory()) await noSymlinks(join(directory, entry.name));
  }
}

export async function evaluateTrialSource(workspace: string, manifest: CapabilityManifest, cases: readonly TrialCase[]) {
  const entry = join(workspace, "index.mjs");
  const source = await readFile(entry, "utf8");
  const sourceDigest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  const plugin = await SandboxedPlugin.inspect(entry, manifest.id, manifest.version);
  if (canonicalJson(plugin.inspection.manifest) !== canonicalJson(manifest)) throw new TrialSourceError("target manifest or generation origin differs");
  const tool = manifest.provides.tools[0];
  if (tool === undefined) throw new Error("target has no tool");
  const results = [];
  for (const test of cases) {
    try {
      const actual = await plugin.executeTool(tool, { callId: randomUUID(), arguments: test.input });
      results.push({ id: test.id, passed: canonicalJson(actual) === canonicalJson(test.expected), actual });
    } catch (error) {
      if (!(error instanceof PluginExecutionError)) throw error;
      results.push({ id: test.id, passed: false, error: error.name });
    }
  }
  return { sourceDigest, casesDigest: improvementDigest(cases), passed: results.filter((item) => item.passed).length,
    total: results.length, results };
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.mode !== "solve" && config.mode !== "improve") throw new Error("invalid trial mode");
  const workspace = await realpath(config.workspace);
  await noSymlinks(workspace);
  const outputDirectory = await realpath(config.outputDirectory);
  if (!relative(workspace, outputDirectory).startsWith(`..${sep}`)) throw new Error("trial controls must be outside the workspace");
  const task = config.mode === "solve" ? await readTrialTask(config.taskFile!, config.taskDigest!) : undefined;
  const sourceDirectory = config.mode === "solve" ? workspace : join(workspace, "candidate");
  const writable = new Set(["index.mjs", "capability.json", "capability.tests.json"].map((file) => join(sourceDirectory, file)));
  const allowed = new Set(["read", "write", "edit", "rsi_target", "rsi_check", "rsi_submit"]);
  if (config.mode === "improve") for (const name of [
    "evolution_improver_read", "evolution_improver_plan", "evolution_improver_propose", "evolution_artifact_stage",
    "evolution_queue", "evolution_deployment_retry", "evolution_approve",
  ]) allowed.add(name);
  ctx.tools.guard((execution) => {
    if (!allowed.has(execution.name)) return "This tool is outside the sealed trial scope.";
    if (execution.agent?.session.header.cwd === undefined || resolve(execution.agent.session.header.cwd) !== workspace) return "The trial workspace changed.";
    if (execution.name === "read" || execution.name === "write" || execution.name === "edit") {
      const value = (execution.arguments as { file_path?: unknown }).file_path;
      if (typeof value !== "string" || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return "Use a plain local file path.";
      const path = resolve(workspace, value);
      const rel = relative(workspace, path);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return "The file is outside the trial workspace.";
      if (execution.name !== "read" && !writable.has(path)) return "Only the assigned capability files may be changed.";
    }
    return undefined;
  });
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const result = await next();
    result.tools = result.tools.filter((tool) => allowed.has(tool.name));
    if (config.mode === "solve") result.contexts = result.contexts.filter((item) =>
      !["chopin:evolution-queue", "chopin:maintenance", "chopin:experience"].includes(item.name)
      && !item.name.startsWith("chopin:experience:"));
    return result;
  });
  ctx.systemPrompt.section({ name: "chopin:rsi-trial", order: 9_100,
    text: "This task's requirements are fixed and user-approved. Work only on its assigned capability files. Use rsi_target, rsi_check and rsi_submit; ordinary delivery tools are out of scope. Shell, delegation, evaluator changes and budget changes are forbidden." });
  if (task !== undefined) ctx.effect(() => ctx.chopinEvolution.registerImprovementWork(() => [{
    key: "assigned-task", action: "improve-capability", targetId: task.manifest.id,
    detail: task.description.slice(0, 1_000), evidenceUnits: 1,
  }]));
  let targetManifest: CapabilityManifest | undefined;
  let checked: { sourceDigest: string; passed: boolean; reportPath: string } | undefined;
  let submitted = false;
  const output: ToolDefinition["output"] = { schema: { type: "object", additionalProperties: true },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] };
  ctx.tools.register({ name: "rsi_target", description: "Read the assigned target, exact origin and public examples.",
    parameters: { type: "object", additionalProperties: false, properties: {} }, output,
    async execute(_args, execution) {
      if (task === undefined) return { directory: "candidate", ...(await ctx.chopinEvolution.readImprover(execution.agent)) };
      const plan = await ctx.chopinEvolution.planImprovement(execution.agent!);
      targetManifest = { ...task.manifest, lineage: { ...task.manifest.lineage, improvementId: plan.id } };
      const source = task.starter.replace("__MANIFEST__", JSON.stringify(targetManifest));
      return JSON.parse(JSON.stringify({ description: task.description, manifest: targetManifest, starter: source, examples: task.publicCases }));
    } });
  ctx.tools.register({ name: "rsi_check", description: "Run fixed public checks on the assigned source. Hidden checks are not exposed.",
    parameters: { type: "object", additionalProperties: false, properties: {} }, output,
    async execute() {
      let report;
      if (config.mode === "solve") {
        if (targetManifest === undefined) throw new Error("Read rsi_target first.");
        report = await evaluateTrialSource(workspace, targetManifest, task!.publicCases);
      } else {
        const manifest = JSON.parse(await readFile(join(sourceDirectory, "capability.json"), "utf8")) as CapabilityManifest;
        assertCapabilityManifest(manifest);
        if (manifest.provides.tools.length !== 1 || manifest.provides.tools[0] !== IMPROVER_TOOL) throw new Error("The candidate is not the assigned improver role.");
        const entry = join(sourceDirectory, "index.mjs");
        const plugin = await SandboxedPlugin.inspect(entry, manifest.id, manifest.version);
        if (canonicalJson(plugin.inspection.manifest) !== canonicalJson(manifest)) throw new Error("candidate manifest differs");
        const result = await verifyCapabilityFixtures(plugin, improverContractFixtures());
        report = { sourceDigest: `sha256:${createHash("sha256").update(await readFile(entry)).digest("hex")}`,
          passed: result.passed ? result.checks.length : result.checks.filter((check) => check.status === "pass").length,
          total: result.checks.length, results: result.checks };
      }
      const path = join(outputDirectory, `public-${randomUUID()}.json`);
      await writeTrialRecord(path, report);
      checked = { sourceDigest: report.sourceDigest, passed: report.passed === report.total, reportPath: path };
      if (!checked.passed) throw new Error(`Public checks failed: ${JSON.stringify(report.results).slice(0, 6_000)}`);
      return report;
    } });
  ctx.tools.register({ name: "rsi_submit", description: "Submit the checked source for independent evaluation and end this turn. This does not declare improvement proven.",
    parameters: { type: "object", additionalProperties: false, properties: {} }, output,
    async execute(_args, execution) {
      if (submitted) throw new Error("This phase was already submitted.");
      const digest = `sha256:${createHash("sha256").update(await readFile(join(sourceDirectory, "index.mjs"))).digest("hex")}`;
      if (!checked?.passed || checked.sourceDigest !== digest) throw new Error("Run fixed checks on the current source before submitting.");
      const record = { phase: config.phase, sessionId: String(execution.agent!.session.id), sourceDigest: digest,
        manifest: targetManifest ?? JSON.parse(await readFile(join(sourceDirectory, "capability.json"), "utf8")),
        publicReport: checked.reportPath, submittedAt: new Date().toISOString(), mode: config.mode };
      await writeTrialRecord(join(outputDirectory, "submission.json"), record);
      submitted = true;
      execution.concludeTurn();
      return { submitted: true, independentEvaluation: "pending", sourceDigest: digest };
    } });
  ctx.on("agent/pre-step", (_event, next) => submitted ? Promise.resolve({ kind: "reject" }) : next());
}
