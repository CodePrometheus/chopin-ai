import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-tools";

/** A new human request delimits one maintenance budget; auto-continue messages do not reset it. */
export function currentRequestEvents(session: Pick<Session, "snapshotEvents">): readonly SessionEvent[] {
  const events = session.snapshotEvents();
  const start = events.findLastIndex((event) => event.type === "user/message" && event.data.source.kind === "user");
  return events.slice(start + 1);
}

export function maintenanceCallCount(session: Pick<Session, "snapshotEvents">): number {
  return currentRequestEvents(session).filter((event) =>
    (event.type === "tool/call" || event.type === "tool/ptc-dispatch-start") && event.data.name.startsWith("evolution_")).length;
}

export function completedTask(session: Pick<Session, "snapshotEvents">, guardedTools: readonly string[]) {
  const names = new Set(guardedTools);
  const calls = new Map<string, string>();
  let latestSubmission: string | undefined;
  let completion: { callId: string; tool: string; seq: number; occurredAt: string } | undefined;
  for (const event of currentRequestEvents(session)) {
    if (event.type === "tool/call" || event.type === "tool/ptc-dispatch-start") {
      const id = event.type === "tool/call" ? event.data.callId : event.data.subCallId;
      calls.set(id, event.data.name);
      if (names.has(event.data.name)) { latestSubmission = id; completion = undefined; }
      continue;
    }
    if (event.type !== "tool/result" && event.type !== "tool/ptc-dispatch") continue;
    const result = event.type === "tool/result" ? event.data.message : event.data;
    const id = event.type === "tool/result" ? event.data.message.toolCallId : event.data.subCallId;
    const tool = calls.get(id);
    if (id !== latestSubmission || tool === undefined || !names.has(tool)) continue;
    completion = result.isError ? undefined : { callId: String(id), tool, seq: event.seq, occurredAt: new Date(event.time).toISOString() };
  }
  return completion;
}
