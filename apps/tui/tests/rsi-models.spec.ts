import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { Budget, completer } from "../src/rsi/models.js";

async function setup(weeklyUsd = 5) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: string[] = [];
  const budget = new Budget(join(await mkdtemp(join(tmpdir(), "chopin-models-")), "spend.jsonl"), weeklyUsd);
  const charges = async () => (await readFile(budget.path, "utf8").catch(() => "")).split("\n").filter((line) => line !== "").length;
  return { faux, calls, budget, charges, complete: completer(models, faux.getModel(), budget) };
}

const failing = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });

describe("completer", () => {
  it("tries a dropped connection again and charges each attempt", async () => {
    const { faux, complete, charges } = await setup();
    faux.setResponses([failing("Connection error."), fauxAssistantMessage("fine")]);
    expect(await complete("Hello?")).toBe("fine");
    expect(await charges()).toBe(2);
  }, 20_000);

  it("fails at once on an error trying again cannot mend, never answering with it", async () => {
    const { faux, complete, charges } = await setup();
    faux.setResponses([failing("invalid x-api-key"), fauxAssistantMessage("never asked")]);
    await expect(complete("Hello?")).rejects.toThrow("invalid x-api-key");
    expect(await charges()).toBe(1);
  });

  it("asks nothing once the week's budget is spent", async () => {
    const { faux, complete, budget, charges } = await setup(1);
    await budget.charge(1);
    faux.setResponses([fauxAssistantMessage("never asked")]);
    await expect(complete("Hello?")).rejects.toThrow("has spent $1.00 of its $1.00");
    expect(await charges()).toBe(1);
  });
});
