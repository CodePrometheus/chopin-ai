import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const execute = promisify(execFile);
const temporaryRoot = join(tmpdir(), "chopin-native-builds");
await mkdir(temporaryRoot, { recursive: true });
async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function archive(url, directory) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`native package download failed: ${response.status}`);
  const tarball = join(directory, "native.tgz");
  await writeFile(tarball, new Uint8Array(await response.arrayBuffer()), { flag: "wx" });
  await execute("tar", ["-xzf", tarball, "-C", directory]);
}

if (process.argv[2] !== undefined) {
  const profile = resolve(process.argv[2]);
  const local = createRequire(join(profile, "package.json"));
  const manifestPath = local.resolve("better-sqlite3/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const platform = `node-v${process.versions.modules}-${process.platform}-${process.arch}`;
  const target = join(dirname(manifestPath), "lib/binding", platform, "better_sqlite3.node");
  const built = join(dirname(manifestPath), "build/Release/better_sqlite3.node");
  if (await exists(target)) local(target);
  else if (await exists(built)) local(built);
  else {
    const directory = await mkdtemp(join(temporaryRoot, "database-"));
    const repository = manifest.repository.url.replace(/^git\+/, "").replace(/^git:/, "https:").replace(/\.git$/, "");
    const filename = `${manifest.name}-v${manifest.version}-${platform}.tar.gz`;
    await archive(`${repository}/releases/download/v${manifest.version}/${filename}`, directory);
    const artifact = join(directory, "build/Release/better_sqlite3.node");
    local(artifact);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(artifact, target);
  }
  console.log(`Native profile binding ready: ${platform}`);
} else {
  const runtime = createRequire(require.resolve("@deepseek-ai/dsh-session-persistence-jsonl/package.json"));
  runtime("koffi");
  const host = createRequire(require.resolve("@deepseek-ai/dsh/package.json"));
  const base = createRequire(host.resolve("@deepseek-ai/dsh-base/package.json"));
  const helper = base.resolve("@deepseek-ai/dsh-subprocess-local/package.json");
  await execute(process.execPath, [join(dirname(helper), "scripts/ensure-spawn-helper.mjs")]);
  console.log(`Native runtime bindings ready: ABI ${process.versions.modules}`);
}
