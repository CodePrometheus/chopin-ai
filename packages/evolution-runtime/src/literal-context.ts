import { createHash } from "node:crypto";

import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";

/** Files and experiences are data; one variable substitution keeps the template characters in the original text intact. */
export function literalContext(assembly: PromptAssembly, name: string, text: string): { name: string; text: string } {
  const variable = `chopin_context_${createHash("sha256").update(name).digest("hex")}`;
  assembly.variables[variable] = text;
  return { name, text: `{{${variable}}}` };
}
