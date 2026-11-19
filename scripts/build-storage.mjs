import { spawn } from "node:child_process";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const debug = process.argv.includes("--debug");
const args = ["build", "--locked", "--manifest-path", "crates/storage/Cargo.toml", "--target-dir", "target/storage", "-p", "chopin-storage-node", ...(debug ? [] : ["--release"])];
const child = spawn("cargo", args, { cwd: root, stdio: "inherit" });
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
if (code !== 0) throw new Error(`the native storage build failed: ${code}`);
const library = process.platform === "darwin" ? "libchopin_storage_node.dylib" : process.platform === "win32" ? "chopin_storage_node.dll" : "libchopin_storage_node.so";
const destination = join(root, "packages/harness-pi/native");
await mkdir(destination, { recursive: true });
await copyFile(join(root, "target/storage", debug ? "debug" : "release", library), join(destination, "chopin-storage.node"));
