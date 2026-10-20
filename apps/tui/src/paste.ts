import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard, type Editor } from "@earendil-works/pi-tui";

/**
 * What ctrl+v puts in the editor, as pi has it: the paths of files copied, or of an image saved to a file the agent
 * reads by its path, else the clipboard's text; undefined when it holds none of these.
 */
export async function clipboardPaste(): Promise<readonly string[] | string | undefined> {
  const clipboard = getNativeClipboard();
  if (clipboard === undefined) throw new Error("this terminal cannot read the clipboard");
  const paths = await clipboard.getFilePaths?.();
  if (paths?.length) {
    if (paths.some((path) => /\p{Cc}/u.test(path))) throw new Error("a path on the clipboard holds control characters");
    return paths;
  }
  const image = await clipboard.getImage();
  if (image?.length) {
    const type = imageType(image);
    if (type === undefined) throw new Error("the clipboard holds an image of a kind models do not take");
    const file = join(tmpdir(), `chopin-clipboard-${randomUUID()}.${type}`);
    // Readable by its owner alone, as a screenshot may hold anything.
    await writeFile(file, image, { mode: 0o600 });
    return [file];
  }
  return (await clipboard.getText()) || undefined;
}

/** Puts `text` at the cursor, set apart by a space from any word it would otherwise run into. */
export function insertApart(editor: Editor, text: string): void {
  const { line, col } = editor.getCursor();
  const row = editor.getLines()[line] ?? "";
  const word = (char: string | undefined) => char !== undefined && !/\s/.test(char);
  editor.insertTextAtCursor(`${word(row[col - 1]) ? " " : ""}${text}${word(row[col]) ? " " : ""}`);
}

/** A path as one word of a shell command. */
export function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/** The file extension of an image models take, read from its first bytes. */
function imageType(bytes: Uint8Array): string | undefined {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "webp";
  return undefined;
}
