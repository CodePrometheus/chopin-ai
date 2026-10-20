import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The editor the user set, as pi takes it: VISUAL, then EDITOR, then the system's own. */
export function editorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
}

/** `text` as the user left it in their own editor; undefined when the editor did not end cleanly. */
export async function editElsewhere(text: string, command = editorCommand()): Promise<string | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "chopin-editor-"));
  const file = join(directory, "message.md");
  try {
    await writeFile(file, text);
    const [program = "", ...args] = command.split(" ");
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(program, [...args, file], { stdio: "inherit", shell: process.platform === "win32" });
      child.on("error", () => resolve(null));
      child.on("close", resolve);
    });
    return code === 0 ? (await readFile(file, "utf8")).replace(/^﻿/, "").replace(/\n$/, "") : undefined;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
