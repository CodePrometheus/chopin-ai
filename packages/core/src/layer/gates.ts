/**
 * A call to `tool` is refused until every tool in `requires` has completed successfully earlier in the same
 * session. What counts is the tool-call record, never the model's account of what it did.
 */
export interface GateRule {
  tool: string;
  requires: string[];
  /** Shown to the model when the call is refused. */
  reason: string;
}

export function parseGates(value: unknown, source: string, problems: string[]): GateRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`${source}: expected a list of gate rules`);
    return [];
  }
  return value.flatMap((rule: unknown, index) => {
    const { tool, requires, reason } = (typeof rule === "object" && rule !== null ? rule : {}) as Record<string, unknown>;
    const valid = typeof tool === "string" && tool !== "" && typeof reason === "string" && reason !== ""
      && Array.isArray(requires) && requires.length > 0 && requires.every((r) => typeof r === "string" && r !== "");
    if (!valid) {
      problems.push(`${source}[${index}]: a gate rule needs a tool, a non-empty requires list and a reason`);
      return [];
    }
    return [{ tool, requires: requires as string[], reason }];
  });
}

/** The rules that refuse a call to `tool`, given the tools that have succeeded so far. */
export function unmetGates(rules: readonly GateRule[], tool: string, succeeded: ReadonlySet<string>): GateRule[] {
  return rules.filter((rule) => rule.tool === tool && rule.requires.some((required) => !succeeded.has(required)));
}

/** Why a call is refused: any required tool that is not registered, then each unmet rule's reason. */
export function gateRefusal(unmet: readonly GateRule[], registered: ReadonlySet<string>): string {
  return [...checkGates(unmet, registered), ...unmet.map((rule) => rule.reason)].join("\n");
}

/**
 * Configuration errors against the tools actually registered. A gate on a tool nobody can satisfy would refuse
 * forever, so it is an error rather than an ordinary refusal.
 */
export function checkGates(rules: readonly GateRule[], registered: ReadonlySet<string>): string[] {
  return rules.flatMap((rule) => [
    ...(registered.has(rule.tool) ? [] : [`gate on ${rule.tool}: no such tool`]),
    ...rule.requires.filter((r) => !registered.has(r)).map((r) => `gate on ${rule.tool}: requires ${r}, which no tool provides`),
  ]);
}
