import { db } from "@weaver/db";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import { applyMcpOperation } from "@weaver/core/services/mcpOperations";

async function main(): Promise<unknown> {
  const [userId, email, projectId, idempotencyKey, title, summary] =
    process.argv.slice(2);
  if (
    !userId ||
    !email ||
    !projectId ||
    !idempotencyKey ||
    !title ||
    !summary
  ) {
    process.exit(2);
  }
  const security = createApiKeySecurityContext({
    userId,
    globalRole: "User",
    keyId: `worker-${userId}`,
    permissions: { mcp: ["use"], content: ["read", "write"] },
    projectIds: [],
  });
  const actor = { ...security, name: "Worker", email };

  try {
    return {
      status: "fulfilled",
      result: await applyMcpOperation(db, actor, {
        idempotencyKey,
        toolName: "create_document",
        operation: {
          kind: "document.create",
          projectId,
          folderPath: [],
          title,
          markdown: title,
        },
        summary,
      }),
    };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      details?: { reason?: unknown };
    };
    return {
      status: "rejected",
      code: typeof failure.code === "string" ? failure.code : null,
      reason:
        typeof failure.details?.reason === "string"
          ? failure.details.reason
          : null,
    };
  } finally {
    await db.$disconnect();
  }
}

void main().then(
  (outcome) => {
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    process.exit(0);
  },
  () => process.exit(1),
);
