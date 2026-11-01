import { db } from "@weaver/db";
import { mcpResourceUrl } from "@weaver/config/publicUrls";
import { resolveMcpPrincipal } from "@weaver/core/security/bearer";
import type { EnrichedActor } from "@weaver/core/services/documents";
import { env } from "~/env";
import { getBearerVerifiers } from "~/server/auth/bearer";

/** Validated like an MCP request: same audience, consent and scope rules. */
export async function resolveTransferActor(
  req: Request,
): Promise<EnrichedActor & { clientId: string | null }> {
  const principal = await resolveMcpPrincipal(db, getBearerVerifiers(), {
    authorizationHeader: req.headers.get("authorization"),
    dpopProofJwt: null,
    method: req.method,
    // Same value as ~/server/auth's MCP_RESOURCE_URL, without loading Better Auth.
    url: mcpResourceUrl(env),
  });
  return {
    ...principal.security,
    name: principal.profile.name,
    email: principal.profile.email,
    clientId: principal.clientId,
  };
}
