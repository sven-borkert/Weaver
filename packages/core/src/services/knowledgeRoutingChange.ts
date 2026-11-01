import type { Prisma, PrismaClient } from "@weaver/db/client";

import type { SecurityContext } from "../security/context";
import { enqueueReconcileForLiveProjects } from "./knowledgeReconciliation";

export const LAST_ROUTING_CHANGE_SETTING = "knowledge.lastRoutingChange";

export type KnowledgeRoutingChangeRecord = {
  userId: string;
  indexFingerprint: string;
  at: string;
};

type RoutingResolver = (
  db: PrismaClient,
) => Promise<{ configFingerprint: string } | null>;

/** Runs an admin LLM change and queues reconciliation when the knowledge index identity changed. */
export async function withKnowledgeRoutingChange<T>(
  db: PrismaClient,
  actor: SecurityContext,
  resolve: RoutingResolver,
  change: () => Promise<T>,
): Promise<{ result: T; reindexProjects: number }> {
  const before = (await resolve(db))?.configFingerprint ?? null;
  const result = await change();
  const after = (await resolve(db))?.configFingerprint ?? null;
  if (after === null || after === before) return { result, reindexProjects: 0 };
  const record: KnowledgeRoutingChangeRecord = {
    userId: actor.userId,
    indexFingerprint: after,
    at: new Date().toISOString(),
  };
  const value = record as unknown as Prisma.InputJsonObject;
  await db.systemSetting.upsert({
    where: { key: LAST_ROUTING_CHANGE_SETTING },
    create: {
      key: LAST_ROUTING_CHANGE_SETTING,
      value,
      updatedById: actor.userId,
    },
    update: { value, updatedById: actor.userId },
  });
  return { result, reindexProjects: await enqueueReconcileForLiveProjects(db) };
}
