import { createBearerVerifiers, type BearerVerifiers } from "@weaver/auth";

import { auth, MCP_RESOURCE_URL, OAUTH_ISSUER_URL } from "~/server/auth";

let verifiers: BearerVerifiers | undefined;

/** Builds the singleton bearer verifiers for web API-key entry points. */
export function getBearerVerifiers(): BearerVerifiers {
  return (verifiers ??= createBearerVerifiers(auth, {
    issuer: OAUTH_ISSUER_URL,
    audience: MCP_RESOURCE_URL,
  }));
}
