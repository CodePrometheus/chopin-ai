import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidFile, readJson, readJsonLines, readJsonObject } from "../src/index.js";

describe("JSON files", () => {
  it("names a file that is not what it should hold, by its name and line alone, never quoting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-json-"));
    const file = join(dir, "kept.json");
    expect(await readJson(file)).toBeUndefined();
    expect(await readJsonLines(file)).toEqual([]);
    await writeFile(file, "Bearer json-password");
    await expect(readJson(file)).rejects.toThrow(new InvalidFile(`${file} is not valid JSON`));
    await writeFile(file, '{"a": 1}\n\n{"b": "json-password"\n');
    await expect(readJsonLines(file)).rejects.toThrow(new InvalidFile(`${file} is not valid JSON at line 3`));
    await writeFile(file, '{"a": 1}\n\n{"b": 2}\n');
    expect(await readJsonLines(file)).toEqual([{ a: 1 }, { b: 2 }]);
    await writeFile(file, '["json-password"]');
    await expect(readJsonObject(file, "settings object")).rejects.toThrow(new InvalidFile(`${file} holds no settings object`));
    await writeFile(file, '{"model": "a/b"}');
    expect(await readJsonObject(file, "settings object")).toEqual({ model: "a/b" });
  });
});
