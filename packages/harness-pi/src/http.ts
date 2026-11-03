import type { IncomingMessage, ServerResponse } from "node:http";
import { credentialOf, type Authenticate } from "./auth.js";

/**
 * Whether the service has work in hand, as `GET /status` tells whoever runs it, so a workspace is reclaimed only once
 * it has none. Asking is not using: it keeps nothing awake.
 */
export function statusHandler(authenticate: Authenticate, busy: () => Promise<boolean>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const credential = credentialOf(request);
    if (credential === undefined || (await authenticate(credential)) === undefined) return void response.writeHead(401).end("unauthorized");
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ busy: await busy() }));
  };
}
