import { loadEncryptionKeyRing } from "@weaver/core/security/encryption";
import { CoreError } from "@weaver/core/errors";
import type { RemoteRuntimeDeps } from "@weaver/core/services/remoteInstances/types";
import { appPublicUrl, mcpResourceUrl } from "@weaver/config/publicUrls";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import type { PrismaClient } from "@weaver/db/client";
import { env } from "~/env";

function allowedOrigins(): string[] {
  return (env.WEAVER_OUTBOUND_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function remoteRuntime(ctx: {
  db: PrismaClient;
  encryptionKeys: EncryptionKeyRing | null;
}): RemoteRuntimeDeps {
  if (!ctx.encryptionKeys)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Remote instance encryption is not configured (WEAVER_ENCRYPTION_KEYS)",
    );
  return {
    db: ctx.db,
    ring: ctx.encryptionKeys,
    fetchImpl: fetch,
    now: () => new Date(),
    selfBaseUrl: appPublicUrl(env),
    // Same value as ~/server/auth's MCP_RESOURCE_URL, without loading Better Auth.
    mcpResourceUrl: mcpResourceUrl(env),
    allowedOrigins: allowedOrigins(),
  };
}

/** For route handlers, which have no tRPC context. */
export function remoteRuntimeFromEnv(db: PrismaClient): RemoteRuntimeDeps {
  return remoteRuntime({ db, encryptionKeys: loadEncryptionKeyRing() });
}
