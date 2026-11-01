import { CoreError } from "@weaver/core/errors";
import { assertSystemAdmin } from "@weaver/core/security/context";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import {
  fromOrganizationRole,
  PROJECT_ROLE_RANK,
  toOrganizationRole,
  type ProjectRoleName,
} from "../roles";
import {
  clampLimit,
  decodeTextIdPageCursor,
  encodePageCursor,
} from "./adminPaging";
import { notDeleted, type ProjectActor } from "./projectAccess";

type Db = PrismaClient | Prisma.TransactionClient;

export type AdminProjectOwner = { userId: string; name: string; email: string };

export type AdminProjectSummary = {
  id: string;
  name: string;
  createdAt: Date;
  isPersonal: boolean;
  memberCount: number;
  owners: AdminProjectOwner[];
  documentCount: number;
  tableCount: number;
  callerIsMember: boolean;
};

export type AdminProjectMember = {
  userId: string;
  name: string;
  email: string;
  role: ProjectRoleName;
  active: boolean;
};

export type AdminProjectDetail = AdminProjectSummary & {
  description: string | null;
  personalOwnerId: string | null;
  members: AdminProjectMember[];
};

const OWNER_ROLE = toOrganizationRole("Owner");

const projectBaseSelect = {
  id: true,
  name: true,
  createdAt: true,
  personalOwnerId: true,
  _count: { select: { documents: true, tables: true } },
} satisfies Prisma.ProjectSelect;

const memberSelect = {
  userId: true,
  role: true,
  user: { select: { name: true, email: true, banned: true } },
} satisfies Prisma.MemberSelect;

type ProjectBase = Prisma.ProjectGetPayload<{
  select: typeof projectBaseSelect;
}>;
type MemberRow = Prisma.MemberGetPayload<{ select: typeof memberSelect }>;

function summarize(
  row: ProjectBase,
  memberCount: number,
  members: MemberRow[],
  callerId: string,
): AdminProjectSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    isPersonal: row.personalOwnerId !== null,
    memberCount,
    owners: members
      .filter((m) => m.role === OWNER_ROLE)
      .map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    documentCount: row._count.documents,
    tableCount: row._count.tables,
    callerIsMember: members.some((m) => m.userId === callerId),
  };
}

export async function listAdminProjects(
  db: Db,
  actor: ProjectActor,
  input: { search?: string; limit?: number; cursor?: string },
): Promise<{ projects: AdminProjectSummary[]; nextCursor: string | null }> {
  assertSystemAdmin(actor);
  const limit = clampLimit(input.limit);
  const search = input.search?.trim();
  const clauses: Prisma.ProjectWhereInput[] = [notDeleted];
  if (search) {
    clauses.push({ name: { contains: search, mode: "insensitive" } });
  }
  if (input.cursor) {
    const [name, id] = decodeTextIdPageCursor(input.cursor);
    clauses.push({ OR: [{ name: { gt: name } }, { name, id: { gt: id } }] });
  }
  const rows = await db.project.findMany({
    where: { AND: clauses },
    select: {
      ...projectBaseSelect,
      organization: {
        select: {
          _count: { select: { members: true } },
          // Owners for the column, plus the caller's own row for the badge.
          members: {
            where: { OR: [{ role: OWNER_ROLE }, { userId: actor.userId }] },
            select: memberSelect,
          },
        },
      },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    projects: page.map((row) =>
      summarize(
        row,
        row.organization._count.members,
        row.organization.members,
        actor.userId,
      ),
    ),
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.name, last.id])
        : null,
  };
}

export async function getAdminProject(
  db: Db,
  actor: ProjectActor,
  projectId: string,
): Promise<AdminProjectDetail> {
  assertSystemAdmin(actor);
  const row = await db.project.findFirst({
    where: { id: projectId, ...notDeleted },
    select: {
      ...projectBaseSelect,
      description: true,
      organization: { select: { members: { select: memberSelect } } },
    },
  });
  if (!row) throw new CoreError("NOT_FOUND", "No such project");
  const members = row.organization.members;
  return {
    ...summarize(row, members.length, members, actor.userId),
    description: row.description,
    personalOwnerId: row.personalOwnerId,
    members: members
      .map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        role: fromOrganizationRole(m.role),
        active: !m.user.banned,
      }))
      .sort(
        (a, b) =>
          PROJECT_ROLE_RANK[b.role] - PROJECT_ROLE_RANK[a.role] ||
          a.name.localeCompare(b.name),
      ),
  };
}
