import type { Session } from "@deepseek-ai/dsh-session";
import { canonicalJson } from "@chopin/evolution";
import type { JsonValue } from "@chopin/evolution";
import { currentRequestEvents } from "@chopin/evolution-runtime";

export function successfulCalls(session: Session | undefined): Array<{ name: string; arguments: Record<string, JsonValue> }> {
  if (session === undefined) return [];
  const calls = new Map<string, { name: string; arguments: Record<string, JsonValue>; key: string; passed: boolean }>();
  const latest = new Map<string, string>();
  const events = currentRequestEvents(session);
  for (const event of events) {
    if (event.type === "tool/call" || event.type === "tool/ptc-dispatch-start") {
      let args: Record<string, JsonValue> | undefined;
      try {
        const parsed = typeof event.data.arguments === "string" ? JSON.parse(event.data.arguments) : event.data.arguments;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, JsonValue>;
      } catch {
        // Raw call arguments that fail to parse cannot serve as evidence of a successful prerequisite.
      }
      if (args === undefined) continue;
      const id = event.type === "tool/call" ? event.data.callId : event.data.subCallId;
      const key = canonicalJson({ name: event.data.name, arguments: args });
      calls.set(id, { name: event.data.name, arguments: args, key, passed: false });
      latest.delete(key);
      latest.set(key, id);
      continue;
    }
    if (event.type !== "tool/result" && event.type !== "tool/ptc-dispatch") continue;
    const result = event.type === "tool/result" ? event.data.message : event.data;
    const id = event.type === "tool/result" ? event.data.message.toolCallId : event.data.subCallId;
    const call = calls.get(id);
    if (call !== undefined && latest.get(call.key) === id) call.passed = result.isError !== true;
  }
  return [...latest.values()].flatMap((id) => {
    const call = calls.get(id);
    return call?.passed ? [{ name: call.name, arguments: call.arguments }] : [];
  });
}
