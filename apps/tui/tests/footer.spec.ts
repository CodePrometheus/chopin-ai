import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { tokens, usageText, whereText } from "../src/footer.js";

const answer = (input: number, output: number, cost: number, stopReason = "stop") => ({
  role: "assistant", content: [], stopReason,
  usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
});
const view = (...messages: unknown[]) => {
  const answers = messages.flatMap((message) => ((message as { role: string }).role === "assistant" ? [(message as ReturnType<typeof answer>).usage] : []));
  return { entries: messages.map((message, id) => ({ id, model: [message] })), docs: { "pi.usage": { models: Object.fromEntries(answers.map((usage, index) => [`m/${index}`, usage])), tools: {} } } } as unknown as ConversationView;
};

describe("the footer", () => {
  it("sums what the conversation used, as its store keeps it, and shows how full the context is, as pi does", () => {
    const used = usageText(view({ role: "user", content: "Hi." }, answer(12_000, 300, 0.01), answer(15_000, 450, 0.02)), 200_000, false);
    expect(used).toBe("↑27k ↓750 $0.030 7.7%/200k");
    // A compaction takes answers out of the context, never out of what was spent.
    const compacted = { ...view(answer(15_000, 450, 0.02)), docs: view(answer(12_000, 300, 0.01), answer(15_000, 450, 0.02)).docs } as ConversationView;
    expect(usageText(compacted, 200_000, false)).toBe("↑27k ↓750 $0.030 7.7%/200k");
    expect(usageText(view(answer(0, 0, 0)), 200_000, true)).toBe("$0.000 (sub) 0.0%/200k");
    expect(usageText(view(), undefined, false)).toBe("");
  });

  it("writes token counts short, and the home directory as ~", () => {
    expect([999, 1_500, 12_345, 2_500_000, 25_000_000].map(tokens)).toEqual(["999", "1.5k", "12k", "2.5M", "25M"]);
    expect(whereText(`${process.env.HOME}/project`, "main")).toBe("~/project (main)");
    expect(whereText("/srv/project", undefined, "fix the build")).toBe("/srv/project • fix the build");
  });
});
