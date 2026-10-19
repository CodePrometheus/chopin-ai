import { spawn } from "node:child_process";

/** Opens `url` in the user's browser; where none can be started, the caller still prints the address. */
export function openBrowser(url: URL): void {
  const [command, ...args] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  const child = spawn(command as string, [...args, url.href], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
