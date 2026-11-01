import { CoreError } from "@weaver/core/errors";
import {
  fromOrganizationRole,
  PROJECT_ROLE_RANK,
  projectRoleAtLeast,
  type ProjectRoleName,
} from "@weaver/core/roles";
import {
  hasCapability,
  mayAccessProject,
  requiredCapabilityForRole,
  type Capability,
  type SecurityContext,
} from "@weaver/core/security/context";
import type { Member, Prisma, PrismaClient, Project } from "@weaver/db/client";

type Db = PrismaClient | Prisma.TransactionClient;

export const notDeleted = {
  deletedAt: null,
} satisfies Prisma.ProjectWhereInput;

export { PROJECT_ROLE_RANK, projectRoleAtLeast };

export type ProjectActor = SecurityContext;

export type ProjectMembership = Member & { projectRole: ProjectRoleName };

export type ProjectAccess = {
  project: Project;
  membership: ProjectMembership;
  /** The actor's organization role on this project. */
  effectiveRole: ProjectRoleName;
};

/**
 * Resolve a non-deleted project and the actor's organization membership.
 * Throws NOT_FOUND for missing/soft-deleted projects, for projects outside the
 * credential's project restriction, and for non-members — including global
 * Admins, who are not content superusers (spec §6.1).
 */
export async function resolveProjectAccess(
  tx: Db,
  projectId: string,
  actor: ProjectActor,
): Promise<ProjectAccess> {
  if (!mayAccessProject(actor, projectId)) throw new CoreError("NOT_FOUND");
  const project = await tx.project.findFirst({
    where: { id: projectId, ...notDeleted },
    include: {
      organization: {
        include: { members: { where: { userId: actor.userId } } },
      },
    },
  });
  if (!project) throw new CoreError("NOT_FOUND");
  const { organization, ...bare } = project;
  const member = organization.members[0];
  if (!member) throw new CoreError("NOT_FOUND");
  const membership = {
    ...member,
    projectRole: fromOrganizationRole(member.role),
  };
  return { project: bare, membership, effectiveRole: membership.projectRole };
}

/**
 * Like resolveProjectAccess but also requires the credential capability the
 * minimum role implies (or an explicit override for role-gated reads) and the
 * role rank itself (spec §7 intersection).
 */
export async function assertProjectRole(
  tx: Db,
  projectId: string,
  actor: ProjectActor,
  min: ProjectRoleName,
  options?: { capability?: Capability },
): Promise<ProjectAccess> {
  const access = await resolveProjectAccess(tx, projectId, actor);
  const capability = options?.capability ?? requiredCapabilityForRole(min);
  if (!hasCapability(actor, capability)) {
    throw new CoreError("FORBIDDEN");
  }
  if (!projectRoleAtLeast(access.effectiveRole, min)) {
    throw new CoreError("FORBIDDEN");
  }
  return access;
}
