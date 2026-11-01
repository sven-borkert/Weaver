import type { PrismaClient } from "@weaver/db/client";
import type { WorkAudience } from "../../jobs/backgroundWorkSchema";
import type { SecurityContext } from "../../security/context";
import { assertBackgroundWorkRead } from "../backgroundWork/access";
import { assertProjectRole, projectRoleAtLeast } from "../projectAccess";
export type DashboardAccess = {
  actor: SecurityContext;
  projectId?: string;
  workAudience: WorkAudience;
};
export const assertDashboardRead = assertBackgroundWorkRead;
export async function resolveDashboardAccess(
  db: PrismaClient,
  actor: SecurityContext,
  projectId?: string,
): Promise<DashboardAccess> {
  assertDashboardRead(actor);
  const project = projectId
    ? await assertProjectRole(db, projectId, actor, "Viewer")
    : null;
  return {
    actor,
    projectId,
    workAudience:
      project && projectRoleAtLeast(project.effectiveRole, "Maintainer")
        ? "projects"
        : "mine",
  };
}
