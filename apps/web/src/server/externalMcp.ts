import "server-only";

import { createExternalMcpTransport } from "@weaver/external-mcp";
import type { PrismaClient } from "@weaver/db/client";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import { CoreError } from "@weaver/core/errors";

export function externalMcpRuntime(ctx: {
  db: PrismaClient;
  encryptionKeys: EncryptionKeyRing | null;
}) {
  if (!ctx.encryptionKeys)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "External connection encryption is not configured",
    );
  return {
    db: ctx.db,
    ring: ctx.encryptionKeys,
    // A pre-guarded fetchImpl would double-wrap; the transport pins its own.
    transport: createExternalMcpTransport({ fetchImpl: fetch }),
    now: () => new Date(),
  };
}
