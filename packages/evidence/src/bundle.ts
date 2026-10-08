import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Download and extract evidence bundles (log zips and other attachments), with a cache.
 * Report attachments usually hang off time-limited signed URLs, so the downloaded copy
 * is the only piece of on-site evidence that can be kept long term.
 * Cache rules:
 * - an empty file counts as a failed download (an interrupted curl leaves 0 bytes);
 * - curl --remove-on-error keeps a partial file from being treated as cached;
 * - a sentinel file marks a finished extraction; a failure midway re-extracts next time.
 *
 * The URL and the archive both come from outside, so only http(s) is fetched and an
 * archive is extracted only when it holds no symbolic links and stays within a size cap.
 */

/** Cap on the downloaded archive. */
const MAX_DOWNLOAD_BYTES = 1024 ** 3;
/** Cap on the archive's declared uncompressed size, so one bundle cannot fill the disk. */
export const MAX_EXTRACTED_BYTES = 4 * 1024 ** 3;

export interface BundlePaths {
  zipPath: string;
  extractDir: string;
}

function cacheKeyFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function bundleCacheDir(): string {
  return join(homedir(), ".chopin", "bundles");
}

/** Only http(s) is fetched; anything else, including a value curl would read as an option, is refused. */
function assertBundleUrl(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`bundle url is not a valid URL: ${url.slice(0, 200)}`);
  }
  if (protocol !== "https:" && protocol !== "http:") throw new Error(`bundle url must use http or https, got ${protocol}`);
}

/**
 * Extract an archive after checking its listing: a symbolic link could point a later entry
 * outside `extractDir`, and the declared size must stay under `maxBytes`.
 */
export async function extractBundle(zipPath: string, extractDir: string, maxBytes = MAX_EXTRACTED_BYTES): Promise<void> {
  const { stdout: listing } = await execFileAsync("unzip", ["-Z", zipPath], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const link = listing.split("\n").find((line) => line.startsWith("l"));
  if (link !== undefined) throw new Error(`bundle contains a symbolic link and was not extracted: ${link.trim()}`);
  const total = /(\d+) bytes uncompressed/.exec(listing)?.[1];
  if (total === undefined) throw new Error("bundle listing has no size total");
  if (Number(total) > maxBytes) throw new Error(`bundle expands to ${total} bytes, over the ${maxBytes}-byte limit`);
  await mkdir(extractDir, { recursive: true });
  await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", extractDir], { timeout: 120_000 });
}

export async function downloadAndExtract(url: string): Promise<BundlePaths> {
  assertBundleUrl(url);
  const key = cacheKeyFor(url);
  const dir = bundleCacheDir();
  const zipPath = join(dir, `${key}.zip`);
  const extractDir = join(dir, key);
  const sentinel = join(extractDir, ".extracted");
  await mkdir(dir, { recursive: true });

  // Reuse an existing non-empty zip; an empty file counts as a failure and is re-downloaded.
  let needDownload = true;
  try {
    const info = await stat(zipPath);
    if (info.size > 0) needDownload = false;
  } catch {
    // Not present: download it
  }
  if (needDownload) {
    await execFileAsync(
      "curl",
      ["-fSL", "--proto", "=http,https", "--proto-redir", "=http,https", "--max-filesize", String(MAX_DOWNLOAD_BYTES),
        "--remove-on-error", "-o", zipPath, url],
      { timeout: 300_000, env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", ALL_PROXY: "", all_proxy: "" } },
    );
  }

  // A sentinel means the last extraction completed fully; reuse it as is.
  let needExtract = true;
  try {
    await stat(sentinel);
    needExtract = false;
  } catch {
    // Not extracted yet, or the last attempt failed midway
  }
  if (needExtract) {
    await extractBundle(zipPath, extractDir);
    await writeFile(sentinel, new Date().toISOString(), "utf8");
  }

  return { zipPath, extractDir };
}
