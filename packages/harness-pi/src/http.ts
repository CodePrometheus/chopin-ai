import { open, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import type { TLSSocket } from "node:tls";
import { credentialCookie, type Authenticate } from "./auth.js";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * The HTTP side of the service: it turns a credential presented in the address into a cookie, then serves the web
 * app from `root`, if any. Data only ever travels over the authenticated WebSocket.
 */
export function httpHandler(authenticate: Authenticate, root: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    if (token !== null) {
      if ((await authenticate(token)) === undefined) return void response.writeHead(401).end("unauthorized");
      url.searchParams.delete("token");
      // The credential moves into a cookie, so it stays neither in the address bar nor in the history. A relative
      // redirect never leaves this service, and keeps any path a proxy in front adds.
      response.writeHead(303, {
        location: `./${url.pathname.slice(url.pathname.lastIndexOf("/") + 1)}${url.search}`,
        // With no Path, the browser keeps the cookie for the page's own directory, so services a proxy serves under
        // different paths of one host each keep their own.
        "set-cookie": `${credentialCookie(request)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict${overTls(request) ? "; Secure" : ""}`,
      });
      return void response.end();
    }
    const pathname = decoded(url.pathname);
    const file = root === undefined || pathname === undefined ? undefined : await asset(resolve(root), pathname);
    if (file === undefined) return void response.writeHead(404).end("not found");
    const handle = await open(file).catch(() => undefined);
    if (handle === undefined) return void response.writeHead(404).end("not found");
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    // A client that leaves mid-download closes the file with it.
    pipeline(handle.createReadStream(), response, () => {});
  };
}

/**
 * The file a path names inside `root`, and the app's page for the root itself; the page loads its files relative to
 * where it is, so it is served nowhere else.
 */
async function asset(root: string, pathname: string): Promise<string | undefined> {
  const path = join(root, pathname === "/" ? "index.html" : pathname);
  if (relative(root, path).split(sep)[0] === "..") return undefined;
  return (await stat(path).catch(() => undefined))?.isFile() === true ? path : undefined;
}

function decoded(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

/** Whether the browser reached the service over TLS, itself or through a proxy that says so. */
function overTls(request: IncomingMessage): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return proto === "https" || (request.socket as TLSSocket).encrypted === true;
}
