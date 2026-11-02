import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, WikiAgent } from "@weaver/db/client";
import { CoreError } from "../errors";

type Db = PrismaClient | Prisma.TransactionClient;

export const WIKI_AGENT_NAME = "Wiki agent";

export function wikiAgentEmail(
  agentId: string,
): `wiki-agent+${string}@weaver.invalid` {
  return `wiki-agent+${agentId}@weaver.invalid`;
}

export function getLiveWikiAgent(
  db: Db,
  projectId: string,
): Promise<WikiAgent | null> {
  return db.wikiAgent.findFirst({ where: { projectId, revokedAt: null } });
}

/** Returns the project's live agent, creating one if none. Callers authorize; the partial unique index settles races. */
export async function createWikiAgent(
  db: Db,
  projectId: string,
): Promise<WikiAgent> {
  await db.wikiAgent.createMany({
    data: [{ id: randomUUID(), projectId, name: WIKI_AGENT_NAME }],
    skipDuplicates: true,
  });
  const live = await getLiveWikiAgent(db, projectId);
  if (!live)
    throw new CoreError("CONFLICT", "wiki agent was revoked concurrently");
  return live;
}

/** Revoked rows stay so old commits resolve; there is no regenerate. */
export async function revokeWikiAgent(
  db: Db,
  input: { projectId: string; now?: Date },
): Promise<void> {
  await db.wikiAgent.updateMany({
    where: { projectId: input.projectId, revokedAt: null },
    data: { revokedAt: input.now ?? new Date() },
  });
}
