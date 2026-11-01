import { Prisma, type PrismaClient } from "@weaver/db/client";
import { CoreError } from "../../errors";
import {
  MAX_CATALOG_BYTES,
  MAX_ENABLED_EXTERNAL_TOOLS,
} from "../../externalMcp/limits";

export async function lockExternalOwner(
  tx: Prisma.TransactionClient,
  ownerId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`weaver:external-capacity:${ownerId}`}, 0))::text`,
  );
}
export function assertCatalogCapacity(definitions: unknown[]) {
  if (
    definitions.length > MAX_ENABLED_EXTERNAL_TOOLS ||
    Buffer.byteLength(JSON.stringify(definitions)) > MAX_CATALOG_BYTES
  )
    throw new CoreError(
      "PRECONDITION_FAILED",
      "External tool catalog capacity exceeded. Disable tools before enabling more.",
    );
}
export async function loadRuntimeCatalog(
  db: PrismaClient | Prisma.TransactionClient,
  ownerId: string,
) {
  const tools = await db.externalMcpTool.findMany({
    where: {
      enabled: true,
      presentInCatalog: true,
      connection: { ownerId, enabled: true },
    },
    omit: { discoveredDefinition: true },
    include: {
      connection: {
        select: { id: true, name: true, revision: true, timeoutMs: true },
      },
    },
    orderBy: [{ connectionId: "asc" }, { remoteName: "asc" }],
    take: MAX_ENABLED_EXTERNAL_TOOLS + 1,
  });
  assertCatalogCapacity(tools.map((tool) => tool.reviewedDefinition));
  const connections = new Map<
    string,
    (typeof tools)[number]["connection"] & { tools: typeof tools }
  >();
  for (const tool of tools) {
    let connection = connections.get(tool.connectionId);
    if (!connection) {
      connection = { ...tool.connection, tools: [] };
      connections.set(tool.connectionId, connection);
    }
    connection.tools.push(tool);
  }
  return [...connections.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}
