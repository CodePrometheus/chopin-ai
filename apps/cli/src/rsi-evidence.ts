import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { improvementDigest } from "@chopin/evolution";
import type { JsonValue } from "@chopin/evolution";
import { scrub } from "@chopin/ledger";
import type { ProjectTask } from "./rsi-project.js";

function resultEvidence(content: ReadonlyArray<{ type: string; text?: string }>) {
  const text = content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
  const digest = improvementDigest(text);
  try {
    const value = JSON.parse(scrub(text)) as JsonValue;
    const encoded = JSON.stringify(value);
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    return { digest, format: "json", kind, ...(encoded.length <= 800 ? { value } : {
      chars: encoded.length,
      ...(value && typeof value === "object" && !Array.isArray(value) ? { keys: Object.keys(value).slice(0, 16) } : {}),
    }) };
  } catch { return { digest, format: "text", chars: text.length }; }
}

interface OperationEvidence {
  sequence: number;
  tool: string;
  argumentsDigest: string;
  argumentKeys: string[];
  path?: string;
  parentSequence?: number;
  nested: boolean;
  nestedCalls: number;
  status: "pending" | "returned" | "failed";
  result?: ReturnType<typeof resultEvidence>;
}

/** Pass on only the operational evidence of declared tasks; order of occurrence is not a causal conclusion. */
export function executionEvidence(task: ProjectTask, strategyDigest: string, events: readonly SessionEvent[], output: Record<string, string>) {
  const calls = new Map<string, OperationEvidence>();
  const failures: Array<Record<string, unknown>> = [];
  for (const [sequence, event] of events.entries()) {
    if (event.type === "tool/call" || event.type === "tool/ptc-dispatch-start") {
      const value = event.data.arguments;
      let args: unknown;
      try { args = typeof value === "string" ? JSON.parse(value) : value; } catch { continue; }
      const path = args && typeof args === "object" && "file_path" in args ? args.file_path : undefined;
      const parent = event.type === "tool/ptc-dispatch-start" ? calls.get(event.data.parentCallId) : undefined;
      if (parent) parent.nestedCalls++;
      calls.set(event.type === "tool/call" ? event.data.callId : event.data.subCallId, {
        sequence, tool: event.data.name, argumentsDigest: improvementDigest(args),
        argumentKeys: args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args).sort().slice(0, 16).map(key => scrub(key).slice(0, 100)) : [],
        ...(typeof path === "string" && (Object.hasOwn(task.files, path) || task.writable.includes(path)) ? { path } : {}),
        nested: event.type === "tool/ptc-dispatch-start", nestedCalls: 0, status: "pending",
        ...(parent ? { parentSequence: parent.sequence } : {}),
      });
    }
    if (event.type === "tool/result" || event.type === "tool/ptc-dispatch") {
      const results = event.type === "tool/result" ? [{ ...event.data.message, id: event.data.message.toolCallId }]
        : [{ ...event.data, id: event.data.subCallId }];
      for (const result of results) {
        const call = calls.get(String(result.id));
        if (!call) continue;
        call.status = result.isError ? "failed" : "returned";
        call.result = resultEvidence(result.content);
        if (result.isError) failures.push({ ...call, message: scrub(result.content.flatMap(item => item.type === "text" ? [item.text] : [])
          .join("\n")).slice(0, 900) });
      }
    }
  }
  return { schemaVersion: 2, strategyDigest, taskDigest: improvementDigest(task), sourceDigest: improvementDigest(output),
    applicability: "Evidence belongs to these exact task and strategy versions; causal explanations require reproduction. A returned operation is not a claim of semantic success.",
    operations: [...calls.values()].slice(-16), failures: failures.slice(0, 6),
    files: [...new Set([...Object.keys(task.files), ...task.writable])].filter(path => task.files[path] !== output[path]).map(path => ({
      path, before: improvementDigest(task.files[path] ?? null), after: improvementDigest(output[path] ?? null),
    })) };
}
