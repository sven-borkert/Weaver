import { unlinkUserFromProjectTraining } from "./projectTraining";
import type { UserAdministrator } from "@weaver/auth";
import { captureError, emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { CoreError } from "@weaver/core/errors";
import { assertSystemAdmin } from "@weaver/core/security/context";
import { Prisma, type PrismaClient, type Role } from "@weaver/db/client";
import {
  fromOrganizationRole,
  toOrganizationRole,
  type ProjectRoleName,
} from "../roles";
import {
  clampLimit,
  decodeTimestampIdPageCursor,
  encodePageCursor,
} from "./adminPaging";
import { revokeAllOAuthGrantsForUser } from "./oauthConsents";
import { ensurePersonalWorkspace } from "./personalWorkspace";
import { notDeleted, type ProjectActor } from "./projectAccess";
import { lockProjectMembershipWrites } from "./projectMembers";
import { syncProjectMetadataQuietly } from "./projectMetadata";
import {
  linkUserToProjectReview,
  unlinkUserFromProjectReview,
} from "./projectReviewerLinks";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./userSchemas";

type Db = PrismaClient | Prisma.TransactionClient;

export type UserSummary = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  banReason: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  mustChangePassword: boolean;
};

export type UserDetail = UserSummary & {
  memberships: Array<{
    projectId: string;
    projectName: string;
    role: ProjectRoleName;
  }>;
};

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  banned: true,
  banReason: true,
  lastLoginAt: true,
  createdAt: true,
  mustChangePassword: true,
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

function toSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: !row.banned,
    banReason: row.banReason,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    mustChangePassword: row.mustChangePassword,
  };
}

function searchClause(search: string | undefined): Prisma.UserWhereInput[] {
  if (!search) return [];
  return [
    {
      OR: [
        { email: { contains: search, mode: "insensitive" as const } },
        { name: { contains: search, mode: "insensitive" as const } },
      ],
    },
  ];
}

export async function listUsers(
  db: Db,
  actor: ProjectActor,
  input: { search?: string; limit?: number; cursor?: string },
): Promise<{ users: UserSummary[]; nextCursor: string | null }> {
  assertSystemAdmin(actor);
  const limit = clampLimit(input.limit);
  const search = input.search?.trim();
  const clauses = searchClause(search);
  if (input.cursor) {
    const [createdAt, id] = decodeTimestampIdPageCursor(input.cursor);
    clauses.push({
      OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
    });
  }
  const where: Prisma.UserWhereInput =
    clauses.length > 0 ? { AND: clauses } : {};
  const rows = await db.user.findMany({
    where,
    select: userSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    users: page.map(toSummary),
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.createdAt.toISOString(), last.id])
        : null,
  };
}

export async function getUser(
  db: Db,
  actor: ProjectActor,
  userId: string,
): Promise<UserDetail> {
  assertSystemAdmin(actor);
  const row = await db.user.findUnique({
    where: { id: userId },
    select: {
      ...userSelect,
      memberships: {
        where: { organization: { project: notDeleted } },
        select: {
          role: true,
          organization: {
            select: { project: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });
  if (!row) throw new CoreError("NOT_FOUND", "No such user");
  const memberships = row.memberships
    .flatMap((m) =>
      m.organization.project
        ? [
            {
              projectId: m.organization.project.id,
              projectName: m.organization.project.name,
              role: fromOrganizationRole(m.role),
            },
          ]
        : [],
    )
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
  return { ...toSummary(row), memberships };
}

/**
 * Every non-deleted project, independent of the actor's own membership —
 * deliberately not `listProjectsForUser`/`listProjectMembershipsForActor`
 * (`projects.ts`), which filter to the caller's own memberships. This is the
 * picker data source for `setUserMembership`'s orphaned-project rescue (spec
 * §6.1): an Admin who is not themselves a member of a project must still be
 * able to find and select it to restore an Owner. id/name only — no
 * membership data, no pagination; this is a picker list, not a project list.
 */
export async function listProjectsForAdmin(
  db: Db,
  actor: ProjectActor,
): Promise<Array<{ id: string; name: string }>> {
  assertSystemAdmin(actor);
  return db.project.findMany({
    where: notDeleted,
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 1000,
  });
}

/**
 * Better Auth's own admin `createUser` route does its own racy
 * findUserByEmail-then-insert check (routes.mjs), so a genuine concurrent
 * create against the same address loses there, not at the Postgres unique
 * constraint: `auth.api.createUser` throws its own `APIError` (status
 * "BAD_REQUEST", body.code "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"), not a
 * raw Prisma P2002. Verified empirically against weaver_test by firing two
 * concurrent `auth.api.createUser` calls for the same address and inspecting
 * the rejection — reproducible across repeated runs. Matched structurally
 * (not `instanceof`) so packages/core doesn't take a dependency on
 * better-auth's error class for a value @weaver/auth already treats as
 * internal.
 */
function isDuplicateEmailAdministratorError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, status, body } = error as {
    name?: unknown;
    status?: unknown;
    body?: unknown;
  };
  if (name !== "APIError" || status !== "BAD_REQUEST") return false;
  if (typeof body !== "object" || body === null) return false;
  return (
    (body as { code?: unknown }).code ===
    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
  );
}

export async function createUser(
  db: PrismaClient,
  actor: ProjectActor,
  input: { email: string; name: string; role: Role; password: string },
  administrator: UserAdministrator,
): Promise<{ user: UserSummary; password: string }> {
  assertSystemAdmin(actor);
  if (
    input.password.length < PASSWORD_MIN_LENGTH ||
    input.password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new CoreError(
      "BAD_REQUEST",
      `Password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`,
      { field: "password" },
    );
  }
  if (
    !input.name.trim() ||
    input.name.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(input.name)
  ) {
    throw new CoreError("BAD_REQUEST", "Invalid name", { field: "name" });
  }
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) {
    throw new CoreError("CONFLICT", "A user with this email already exists", {
      field: "email",
    });
  }
  let id: string;
  try {
    ({ id } = await administrator.create({
      email,
      name: input.name.trim(),
      password: input.password,
      role: input.role,
      mustChangePassword: true,
    }));
  } catch (error) {
    // Backstop for the race the pre-check above can't close: two concurrent
    // creates can both pass findUnique before either commits.
    if (isDuplicateEmailAdministratorError(error)) {
      throw new CoreError("CONFLICT", "A user with this email already exists", {
        field: "email",
      });
    }
    throw error;
  }
  const row = await db.user.findUniqueOrThrow({
    where: { id },
    select: userSelect,
  });
  // Best-effort: the landing fallback creates the workspace later if this fails.
  try {
    await ensurePersonalWorkspace(db, id);
  } catch (error) {
    captureError({
      event: "admin.user.workspace_failed",
      message: `could not create the personal workspace for ${email}`,
      userId: actor.userId,
      credentialId: actor.credentialId,
      details: { targetUserId: id },
      error,
    });
  }
  emitDiagnostic({
    event: "admin.user.created",
    message: `created user ${email} as ${input.role}`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: { targetUserId: id, email, role: input.role },
  });
  return { user: toSummary(row), password: input.password };
}

// Fixed key: every operation that can change global Admin status (role
// changes here, deactivation in Task 6) contends on this one lock, so the
// count-then-mutate section below is never interleaved across callers.
const GLOBAL_ADMIN_ROSTER_LOCK_KEY = "weaver:admin-roster";

/**
 * Serializes reads/writes of the global Admin roster. Held for the lifetime
 * of the caller's transaction (pg_advisory_xact_lock auto-releases on commit
 * or rollback, unlike a session-scoped lock, so nothing can leak it back
 * into a pooled connection). Exported so Task 6's deactivation guard
 * contends on the exact same key.
 */
export async function lockGlobalAdminRoster(
  db: Prisma.TransactionClient,
): Promise<void> {
  await db.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${GLOBAL_ADMIN_ROSTER_LOCK_KEY}, 0))::text
  `);
}

/**
 * Callers must hold lockGlobalAdminRoster for the duration of their
 * transaction before calling this and until their mutation completes —
 * this check alone only protects against sequential races, not concurrent
 * ones.
 */
export async function assertNotLastActiveAdmin(
  db: Db,
  userId: string,
): Promise<void> {
  const remaining = await db.user.count({
    where: { role: "Admin", banned: false, id: { not: userId } },
  });
  if (remaining === 0) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "The last active Admin cannot be demoted or deactivated",
    );
  }
}

// Roster checks and writes share the transaction holding the roster lock.
export async function setUserRole(
  db: PrismaClient,
  actor: ProjectActor,
  input: { userId: string; role: Role },
  _administrator: UserAdministrator,
): Promise<UserSummary> {
  assertSystemAdmin(actor);
  if (input.userId === actor.userId) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "You cannot change your own global role",
    );
  }
  const { target, row } = await db.$transaction(async (tx) => {
    await lockGlobalAdminRoster(tx);
    const target = await tx.user.findUnique({
      where: { id: input.userId },
      select: userSelect,
    });
    if (!target) throw new CoreError("NOT_FOUND", "No such user");
    if (target.role === "Admin" && input.role !== "Admin") {
      await assertNotLastActiveAdmin(tx, input.userId);
    }
    await tx.user.update({
      where: { id: input.userId },
      data: { role: input.role },
    });
    const row = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: userSelect,
    });
    return { target, row };
  });
  emitDiagnostic({
    event: "admin.user.role-changed",
    message: `global role ${target.role} → ${input.role} for ${target.email}`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: {
      targetUserId: input.userId,
      before: target.role,
      after: input.role,
    },
  });
  return toSummary(row);
}

export async function deactivateUser(
  db: PrismaClient,
  actor: ProjectActor,
  input: { userId: string; reason: string },
  _administrator: UserAdministrator,
): Promise<UserSummary> {
  assertSystemAdmin(actor);
  if (input.userId === actor.userId) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "You cannot deactivate your own account",
    );
  }
  const { target, row } = await db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`weaver:user-credentials:${input.userId}`}, 0))::text`,
    );
    await lockGlobalAdminRoster(tx);
    const target = await tx.user.findUnique({
      where: { id: input.userId },
      select: userSelect,
    });
    if (!target) throw new CoreError("NOT_FOUND", "No such user");
    if (target.role === "Admin") {
      await assertNotLastActiveAdmin(tx, input.userId);
    }
    await tx.user.update({
      where: { id: input.userId },
      data: { banned: true, banReason: input.reason, banExpires: null },
    });
    await tx.session.deleteMany({ where: { userId: input.userId } });
    await revokeAllOAuthGrantsForUser(tx, input.userId);
    await tx.apiKey.deleteMany({ where: { referenceId: input.userId } });
    const row = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: userSelect,
    });
    return { target, row };
  });
  emitDiagnostic({
    event: "admin.user.deactivated",
    message: `deactivated ${target.email}`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: { targetUserId: input.userId, reason: input.reason },
  });
  return toSummary(row);
}

/**
 * Serializes password and session mutations per user across processes. Better
 * Auth's change-password handler reads the account hash, hashes, then writes
 * without a transaction, so without this a change that started before an admin
 * reset could finish after it and undo the reset.
 */
async function withUserCredentialLock<T>(
  db: PrismaClient,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (lockTx) => {
      await lockTx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`weaver:user-credentials:${userId}`}, 0))::text
      `);
      return fn();
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
}

/**
 * Self-service change. Runs under the credential lock, so a change queued
 * behind an admin reset re-authenticates against the post-reset state (its
 * session is gone) and fails instead of overwriting the reset; the forced-
 * change flag is cleared only after the provider accepted the change.
 */
export async function changeOwnPassword(
  db: PrismaClient,
  userId: string,
  change: () => Promise<{ setCookies: string[] }>,
): Promise<{ setCookies: string[] }> {
  return withUserCredentialLock(db, userId, async () => {
    const result = await change();
    await db.$transaction(async (tx) => {
      await revokeAllOAuthGrantsForUser(tx, userId);
      await tx.apiKey.deleteMany({ where: { referenceId: userId } });
      await tx.user.update({
        where: { id: userId },
        data: { mustChangePassword: false },
      });
    });
    return result;
  });
}

/**
 * A reset is containment, not just a new password: everything the account
 * held — sessions, personal API keys, OAuth consents and their token families
 * — is revoked, and none of it returns when the user completes the forced
 * change. `mustChangePassword` itself gates only interactive use (the tRPC
 * middleware, the web routes, and the shared Better Auth hook); it is never
 * read on the bearer path, so a credential that survived a reset would keep
 * working. That is why the flag and the credential revocations land in one
 * transaction: either the user is flagged with nothing left, or nothing
 * changed. setPassword/revokeSessions (Better Auth's internalAdapter) can't
 * join that transaction and run after it, ordered for safe partial failure:
 * a failure there leaves a flagged user whose remaining sessions the live
 * per-request flag check already stops.
 */
export async function resetUserPassword(
  db: PrismaClient,
  actor: ProjectActor,
  input: { userId: string; password: string },
  administrator: UserAdministrator,
): Promise<{ user: UserSummary; password: string }> {
  assertSystemAdmin(actor);
  if (input.userId === actor.userId) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Change your own password from Account settings",
    );
  }
  if (
    input.password.length < PASSWORD_MIN_LENGTH ||
    input.password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new CoreError(
      "BAD_REQUEST",
      `Password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`,
      { field: "password" },
    );
  }
  const { target, revoked } = await withUserCredentialLock(
    db,
    input.userId,
    async () => {
      const result = await db.$transaction(async (tx) => {
        const target = await tx.user.findUnique({
          where: { id: input.userId },
          select: { id: true, email: true },
        });
        if (!target) throw new CoreError("NOT_FOUND", "No such user");
        await tx.user.update({
          where: { id: input.userId },
          data: { mustChangePassword: true },
        });
        const { consents } = await revokeAllOAuthGrantsForUser(
          tx,
          input.userId,
        );
        const { count: apiKeys } = await tx.apiKey.deleteMany({
          where: { referenceId: input.userId },
        });
        return { target, revoked: { apiKeys, oauthConsents: consents } };
      });
      await administrator.setPassword({
        userId: input.userId,
        password: input.password,
      });
      await administrator.revokeSessions({ userId: input.userId });
      return result;
    },
  );
  const row = await db.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: userSelect,
  });
  emitDiagnostic({
    event: "admin.user.password-reset",
    message: `reset the password for ${target.email}`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: {
      targetUserId: input.userId,
      revokedKeyCount: revoked.apiKeys,
      revokedOAuthConsents: revoked.oauthConsents,
    },
  });
  return { user: toSummary(row), password: input.password };
}

export async function revokeUserSessions(
  db: Db,
  actor: ProjectActor,
  userId: string,
  administrator: UserAdministrator,
): Promise<void> {
  assertSystemAdmin(actor);
  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  if (!target) throw new CoreError("NOT_FOUND", "No such user");
  await administrator.revokeSessions({ userId });
  emitDiagnostic({
    event: "admin.user.sessions-revoked",
    message: `revoked sessions for ${target.email}`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: { targetUserId: userId },
  });
}

/**
 * No lock: reactivation only ever adds an Admin back, it never removes one,
 * so it cannot participate in the count-then-mutate race lockGlobalAdminRoster
 * exists to serialize (two callers each independently observing "not the
 * last Admin" before either mutation lands). Worst case without the lock is
 * a concurrent deactivate reading this user as still banned and rejecting
 * itself overly conservatively — never the dangerous direction of reaching
 * zero active Admins.
 */
export async function reactivateUser(
  db: Db,
  actor: ProjectActor,
  userId: string,
  administrator: UserAdministrator,
): Promise<UserSummary> {
  assertSystemAdmin(actor);
  const target = await db.user.findUnique({
    where: { id: userId },
    select: userSelect,
  });
  if (!target) throw new CoreError("NOT_FOUND", "No such user");
  // administrator.unban already clears banned/banReason/banExpires
  // (packages/auth/src/adminUsers.ts) — no follow-up update needed.
  await administrator.unban({ userId });
  const row = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: userSelect,
  });
  emitDiagnostic({
    event: "admin.user.reactivated",
    message: `reactivated ${target.email}`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: { targetUserId: userId },
  });
  return toSummary(row);
}

/**
 * Deliberate narrowing of "global Admin is not a content superuser" (spec
 * §6.1, design §7): unlike every other membership write in this codebase,
 * this does not call assertProjectRole, so an Admin can restore an Owner to a
 * project they do not belong to, and the "cannot grant a role equal to or
 * above your own" rank rule does not apply. The one boundary that makes that
 * safe is absolute: an Admin may never grant, change, or remove their own
 * membership, which is why the self-check runs before any project/user
 * lookup, not just before the write.
 */
export async function setUserMembership(
  db: PrismaClient,
  actor: ProjectActor,
  input: { userId: string; projectId: string; role: ProjectRoleName | null },
): Promise<UserDetail> {
  assertSystemAdmin(actor);
  if (input.userId === actor.userId) {
    throw new CoreError(
      "FORBIDDEN",
      "You cannot change your own project membership",
    );
  }
  const { project, target, removedCount } = await db.$transaction(
    async (tx) => {
      await lockProjectMembershipWrites(tx, input.projectId);
      const project = await tx.project.findFirst({
        where: { id: input.projectId, ...notDeleted },
        select: {
          id: true,
          name: true,
          organizationId: true,
          personalOwnerId: true,
        },
      });
      if (!project) throw new CoreError("NOT_FOUND", "No such project");
      const target = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true },
      });
      if (!target) throw new CoreError("NOT_FOUND", "No such user");

      if (project.personalOwnerId === input.userId && input.role !== "Owner") {
        throw new CoreError(
          "PRECONDITION_FAILED",
          "The workspace owner keeps the Owner role",
        );
      }

      if (input.role !== "Owner") {
        const membership = await tx.member.findUnique({
          where: {
            organizationId_userId: {
              organizationId: project.organizationId,
              userId: input.userId,
            },
          },
        });
        if (
          membership?.role === toOrganizationRole("Owner") &&
          (await tx.member.count({
            where: {
              organizationId: project.organizationId,
              role: toOrganizationRole("Owner"),
            },
          })) <= 1
        ) {
          throw new CoreError(
            "PRECONDITION_FAILED",
            "A project must keep at least one Owner",
          );
        }
      }
      // deleteMany is idempotent by design (removing a non-member is a no-op,
      // not an error) — its returned count decides the diagnostic message below,
      // so a no-op removal is never logged as though it happened.
      let removedCount = 0;
      if (input.role === null) {
        ({ count: removedCount } = await tx.member.deleteMany({
          where: {
            organizationId: project.organizationId,
            userId: input.userId,
          },
        }));
        if (removedCount > 0)
          await unlinkUserFromProjectReview(tx, input.projectId, input.userId);
        await unlinkUserFromProjectTraining(tx, input.projectId, input.userId);
      } else {
        await tx.member.upsert({
          where: {
            organizationId_userId: {
              organizationId: project.organizationId,
              userId: input.userId,
            },
          },
          create: {
            organizationId: project.organizationId,
            userId: input.userId,
            role: toOrganizationRole(input.role),
          },
          update: { role: toOrganizationRole(input.role) },
        });
        await linkUserToProjectReview(tx, input.projectId, input.userId);
      }
      return { project, target, removedCount };
    },
  );
  // Mirrors project.json to current DB truth, same as every other
  // membership write (projectMembers.ts) — the one scenario this function
  // exists for (restoring an Owner to an orphaned project) is exactly the
  // one where no later membership change would otherwise trigger the sync.
  await syncProjectMetadataQuietly(db, input.projectId, actor);
  emitDiagnostic({
    event: "admin.user.membership-changed",
    message:
      input.role === null
        ? removedCount > 0
          ? `removed ${target.email} from ${project.name}`
          : `${target.email} already had no membership on ${project.name}`
        : `set ${target.email} to ${input.role} on ${project.name}`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: {
      targetUserId: input.userId,
      projectId: project.id,
      role: input.role,
    },
  });
  return getUser(db, actor, input.userId);
}
