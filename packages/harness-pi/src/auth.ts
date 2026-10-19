import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { jwtVerify } from "jose";
import type { Principal } from "./protocol.js";

/** Names the owner a credential stands for, or refuses it with `undefined`. */
export type Authenticate = (credential: string) => Principal | undefined | Promise<Principal | undefined>;

/**
 * The cookie a browser keeps its credential in, set when it first presents one as `?token=`. Browsers share cookies
 * across the ports of a host, so each service names its own by port.
 */
export function credentialCookie(request: IncomingMessage): string {
  try {
    const port = new URL(`http://${request.headers.host ?? "localhost"}`).port;
    return port === "" ? "chopin" : `chopin-${port}`;
  } catch {
    return "chopin";
  }
}

/**
 * The credential a request presents. Browsers cannot set headers on a WebSocket, so besides a bearer header it may
 * travel as `?token=` or, once a page has presented it, as a cookie.
 */
export function credentialOf(request: IncomingMessage): string | undefined {
  // Any page of the host can plant a malformed cookie; it must refuse the request, not end the service.
  try {
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const query = new URL(request.url ?? "/", "http://localhost").searchParams.get("token");
    const name = credentialCookie(request);
    const cookie = (request.headers.cookie ?? "").split(";").map((part) => part.trim().split("="))
      .find(([key]) => key === name)?.[1];
    return bearer ?? query ?? (cookie === undefined ? undefined : decodeURIComponent(cookie));
  } catch {
    return undefined;
  }
}

/** Single-user mode: whoever presents the launch token is the one local owner. */
export function launchToken(token: string, owner = "local"): Authenticate {
  const expected = Buffer.from(token);
  return (credential) => {
    const given = Buffer.from(credential);
    return given.length === expected.length && timingSafeEqual(given, expected) ? { kind: "owner", owner } : undefined;
  };
}

export interface IntegratorTokenOptions {
  /** The integrator's public key, or a key set such as one from `createRemoteJWKSet`. */
  key: Parameters<typeof jwtVerify>[1];
  issuer?: string;
  audience?: string;
}

/** Integrated mode: the integrator signs short-lived tokens, and their subject is the owner. There are no accounts here. */
export function integratorTokens(options: IntegratorTokenOptions): Authenticate {
  const verify = { ...(options.issuer && { issuer: options.issuer }), ...(options.audience && { audience: options.audience }) };
  return async (credential) => {
    try {
      const { payload } = await jwtVerify(credential, options.key, { ...verify, requiredClaims: ["sub", "exp"] });
      const owner = payload.sub;
      return typeof owner === "string" && owner !== "" && !/[\r\n]/.test(owner) ? { kind: "owner", owner } : undefined;
    } catch {
      return undefined;
    }
  };
}
