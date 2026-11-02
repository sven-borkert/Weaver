import type { PrismaClient } from "@weaver/db/client";
import { requestKnowledgeJob } from "../jobs/queue";
import {
  assertSystemAdmin,
  type UserSecurityContext,
} from "../security/context";
import { enqueueProjectReconcile } from "./knowledgeReconciliation";
import { assertProjectRole } from "./projectAccess";

export type KnowledgeReconciliationResult = {
  enqueued: boolean;
  job: "project.reconcile" | "system.reconcile";
};

export async function enqueueKnowledgeReconciliation(
  db: PrismaClient,
  input: { projectId?: string },
  actor: UserSecurityContext,
): Promise<KnowledgeReconciliationResult> {
  assertSystemAdmin(actor);
  if (input.projectId) {
    await assertProjectRole(db, input.projectId, actor, "Maintainer");
    return {
      enqueued: await enqueueProjectReconcile(input.projectId),
      job: "project.reconcile",
    };
  }
  return {
    enqueued: (await requestKnowledgeJob("system.reconcile", {})) !== null,
    job: "system.reconcile",
  };
}
