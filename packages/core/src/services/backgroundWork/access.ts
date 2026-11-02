import { Prisma } from "@weaver/db/client";
import { CoreError } from "../../errors";
import type { WorkAudience } from "../../jobs/backgroundWorkSchema";
import { toOrganizationRole } from "../../roles";
import {
  hasCapability,
  type UserSecurityContext,
} from "../../security/context";

export type WorkQueryAccess = {
  actor: UserSecurityContext;
  audience: WorkAudience;
  projectId?: string;
  windowStart?: Prisma.Sql;
};

export function assertBackgroundWorkRead(actor: UserSecurityContext): void {
  if (
    actor.authenticationMethod !== "session" ||
    !hasCapability(actor, "content:read")
  ) {
    throw new CoreError("FORBIDDEN");
  }
}

export function visibleProjectsSql(access: WorkQueryAccess): Prisma.Sql {
  const allowed = access.actor.allowedProjectIds;
  return Prisma.sql`
    SELECT p.id, p.name,
      m.role IN (${toOrganizationRole("Owner")}, ${toOrganizationRole("Maintainer")}) AS "canMaintain",
      m.role = ${toOrganizationRole("Owner")} AS "isOwner"
    FROM "Project" p
    JOIN "Member" m ON m."organizationId" = p."organizationId"
    WHERE p."deletedAt" IS NULL AND m."userId" = ${access.actor.userId}::uuid
      ${allowed === "all-accessible" ? Prisma.empty : Prisma.sql`AND p.id = ANY(${[...allowed]}::uuid[])`}
      ${access.projectId ? Prisma.sql`AND p.id = ${access.projectId}::uuid` : Prisma.empty}
  `;
}
