import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { jwtVerify } from "jose";
import type { Principal } from "./protocol.js";

/** Names the owner a credential stands for, or refuses it with `undefined`. */
export type Authenticate = (credential: string) => Principal | undefined | Promise<Principal | undefined>;

/** The credential a request presents: a bearer header, or `?token=` from a client that cannot set headers. */
export function credentialOf(request: IncomingMessage): string | undefined {
  // An address that cannot be read presents nothing; it must refuse the request, not end the service.
  try {
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    return bearer ?? new URL(request.url ?? "/", "http://localhost").searchParams.get("token") ?? undefined;
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
