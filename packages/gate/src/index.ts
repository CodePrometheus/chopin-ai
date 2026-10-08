/**
 * Discipline gates: before a guarded tool runs, check the tool-call records in the
 * session log, reject whenever a rule is unmet, and hand the gaps back to the model.
 *
 * The session log is the only source of judgment. dsh holds a runtime invariant --
 * "visible to the model means recorded" -- so everything that reaches the model must
 * be reconstructible from the log, which makes the tool-call log the single truth;
 * a model claiming "I already checked" does not count.
 *
 * Use `ctx.tools.guard()` (a monotonic guard) rather than the `tools/pre-execute`
 * waterfall: a waterfall decision can be rewritten by later listeners, while a guard's
 * denial can never flip back into permission. A gate must be the latter -- a rule
 * that another plugin can relax is not discipline.
 *
 * The guard is registered by **the line that declares the gate** (see
 * `createGateGuard`), not through a host-level registry: `ctx.tools.guard()` lands in
 * the caller's scope, so calling it from a preset line governs only the agents under
 * that preset and dies with that line's fiber. A flat host-level registry cannot do
 * this -- dsh lets two generations of the same preset coexist in one process (after
 * the composition file changes, joined sessions keep the old generation while new
 * sessions get the new one), and a flat table must collide on the second
 * registration. The service here exists only for the UI to show status; it takes no
 * part in the judgment.
 *
 * Only "successfully completed" calls count: a tool that was called but failed is as
 * good as never consulted; one failed fetch cannot satisfy "read first-hand evidence".
 *
 * Composition correctness belongs to startup, not runtime: `scripts/check-composition.mjs`
 * statically parses presets and the bundle to confirm every tool a rule names is
 * provided by some plugin. The guard does not repeat that check -- tools register in
 * layers by the scope of their declaring line, and the context the guard receives may
 * not resolve tools registered by other lines, so inferring existence from it yields
 * false positives; and presenting "not yet called" as "configuration unavailable"
 * makes the caller stop trying. The denial therefore only states what is missing.
 *
 * @module @chopin/gate
 */

import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { ToolGuard } from "@deepseek-ai/dsh-tools";

declare module "@deepseek-ai/cordis" {
  interface Context {
    chopinGates: ChopinGates;
  }
}

/** One rule: the investigator must have done something, proven by which tools were called. */
export interface GateRule {
  id: string;
  /** Shown to the model when the gate blocks a call; spells out what is missing. */
  description: string;
  /** Satisfied once any of these tools has been called successfully. */
  satisfiedByTools: readonly string[];
}

/** A set of rules and the tool they guard -- usually a mission's submission tool. */
export interface GateRegistration {
  /** Name of the guarded tool; every rule must be met before it can be called. */
  guardedTool: string;
  rules: readonly GateRule[];
}

export interface GateStatus {
  id: string;
  description: string;
  satisfied: boolean;
}

/**
 * Success state of each tool's latest call within the current user request.
 *
 * Only success counts: a tool that was called but errored is as good as never
 * consulted; one failed fetch cannot satisfy "read first-hand evidence".
 */
export function satisfiedTools(session: Session, afterSubmission?: string): ReadonlySet<string> {
  const nameByCall = new Map<string, string>();
  const latestCall = new Map<string, string>();
  const done = new Set<string>();
  const events = session.snapshotEvents();
  const reset = () => { nameByCall.clear(); latestCall.clear(); done.clear(); };
  for (const event of events) {
    if (event.type === "user/message" && event.data.source.kind === "user") {
      reset();
      continue;
    }
    if (event.type === "tool/call") {
      nameByCall.set(event.data.callId, event.data.name);
      latestCall.set(event.data.name, event.data.callId);
      done.delete(event.data.name);
      continue;
    }
    if (event.type !== "tool/result") continue;
    const result = event.data.message;
    const name = nameByCall.get(result.toolCallId);
    if (name === undefined || latestCall.get(name) !== result.toolCallId) continue;
    if (result.isError === true) done.delete(name);
    else if (name === afterSubmission) reset();
    else done.add(name);
  }
  return done;
}

/** Evaluate a rule set against the names of tools that completed successfully. */
export function evaluate(rules: readonly GateRule[], called: ReadonlySet<string>): GateStatus[] {
  return rules.map((rule) => ({
    id: rule.id,
    description: rule.description,
    satisfied: rule.satisfiedByTools.some((tool) => called.has(tool)),
  }));
}

/** Human-facing opening of the denial text. */
export const GATE_DENIAL_HEADER = "Rejected by ";
/** Machine-facing trailer prefix of the denial text, followed by comma-separated unmet rule ids. */
export const GATE_DENIAL_TRAILER = "gates-unmet:";

/** Structured reading of one gate denial. */
export interface GateDenial {
  /** Unmet rule ids, in the order they were denied. */
  unmet: string[];
}

/**
 * Denial reason: states only what is missing, never how to do it -- that is the
 * playbook's job. The last line is a machine-readable list of rule ids; signal
 * extraction clusters on it and never parses the human-facing part.
 */
function renderDenial(unmet: readonly GateStatus[]): string {
  const lines = unmet.map((gate) => `- ${gate.id}: ${gate.description}`);
  return [
    `${GATE_DENIAL_HEADER}${unmet.length} unmet investigation gate(s):`,
    ...lines,
    "Satisfy them with real tool calls. Only the tool-call log counts; stating that you already did this does not.",
    `${GATE_DENIAL_TRAILER} ${unmet.map((gate) => gate.id).join(",")}`,
  ].join("\n");
}

/** Read a gate denial out of tool result text; returns undefined when it is not one. */
export function parseGateDenial(text: string): GateDenial | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(GATE_DENIAL_TRAILER)) continue;
    const unmet = trimmed.slice(GATE_DENIAL_TRAILER.length).split(",").map((id) => id.trim()).filter((id) => id !== "");
    return unmet.length === 0 ? undefined : { unmet };
  }
  return undefined;
}

/** Shape check for a rule set: an empty set or a rule that can never be met should blow up at registration. */
function validateRules(guardedTool: string, rules: readonly GateRule[]): readonly GateRule[] {
  if (rules.length === 0) throw new Error(`gate registration for ${guardedTool} carries no rules`);
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new Error(`duplicate gate rule id ${rule.id} for ${guardedTool}`);
    seen.add(rule.id);
    if (rule.satisfiedByTools.length === 0) {
      throw new Error(`gate rule ${rule.id} names no satisfying tool, so it can never be met`);
    }
  }
  return Object.freeze([...rules]);
}

/**
 * Build a guard for the caller to register with its own `ctx.tools.guard()` -- it
 * lands in the caller's scope and governs only the agents under that layer.
 */
export function createGateGuard(registration: GateRegistration): ToolGuard {
  const { guardedTool } = registration;
  const rules = validateRules(guardedTool, registration.rules);
  return (execution) => {
    if (execution.name !== guardedTool) return undefined;
    if (execution.agent === undefined) {
      return `${guardedTool} is gated and requires an owning agent session to read the tool-call log from`;
    }
    const unmet = evaluate(rules, satisfiedTools(execution.agent.session, guardedTool)).filter((gate) => !gate.satisfied);
    if (unmet.length === 0) return undefined;
    return renderDenial(unmet);
  };
}

/**
 * Gate status service for display. It only answers "how many gates has this agent
 * passed" and takes no part in the judgment -- that lives in the guards each line
 * registers itself. The same tool name may be announced more than once (each
 * generation of a preset announces once); later announcements override earlier
 * ones, and disposal only deletes when the entry is still its own.
 */
export class ChopinGates extends Service {
  private readonly rules = new Map<string, readonly GateRule[]>();

  constructor(ctx: Context) {
    super(ctx, "chopinGates");
  }

  announce(registration: GateRegistration): () => void {
    const rules = validateRules(registration.guardedTool, registration.rules);
    return this.ctx.effect(() => {
      this.rules.set(registration.guardedTool, rules);
      return () => {
        if (this.rules.get(registration.guardedTool) === rules) this.rules.delete(registration.guardedTool);
      };
    });
  }

  /** Submission tools currently announced with gates. One successful call to any of them is a gate-verified delivery. */
  guardedTools(): string[] {
    return [...this.rules.keys()].sort();
  }

  /** An agent's current gate status, for the persistent UI display and for reports to cite. */
  status(guardedTool: string, agent: Agent): GateStatus[] {
    const rules = this.rules.get(guardedTool);
    if (rules === undefined) return [];
    return evaluate(rules, satisfiedTools(agent.session, guardedTool));
  }
}

// The cordis loader resolves Service-class plugins by default export; this one is the framework contract.
export default ChopinGates;
