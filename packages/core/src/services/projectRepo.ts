import { CoreError } from "@weaver/core/errors";
import {
  withExistingProjectRepo as withExistingProjectRepoRaw,
  withExistingProjectRepoReader as withExistingProjectRepoReaderRaw,
  withProjectRepo as withProjectRepoRaw,
  type ProjectRepoReader,
  type ProjectRepoWriter,
} from "@weaver/git-store";
import { RepoLockTimeoutError } from "@weaver/git-store/advisory-lock";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import type { ProjectRoleName } from "@weaver/core/roles";
import type { SecurityContext } from "@weaver/core/security/context";
import { assertProjectRole } from "./projectAccess";

function mapLockTimeout(error: unknown): never {
  if (error instanceof RepoLockTimeoutError) {
    throw new CoreError("CONFLICT", "project repository is busy", {
      retryable: true,
      reason: "BUSY",
    });
  }
  throw error;
}

/** The role an actor-driven write was authorized with before it queued. */
export type ProjectRepoWriteRole = {
  db: PrismaClient | Prisma.TransactionClient;
  actor: SecurityContext;
  min: ProjectRoleName;
};

/**
 * With `role`, the role is checked again once the lock is held: a write can
 * wait for the lock while its author is removed or downgraded, and
 * membership changes do not take this lock.
 */
export async function withProjectRepo<T>(
  projectId: string,
  fn: (repo: ProjectRepoWriter) => Promise<T>,
  role?: ProjectRepoWriteRole,
): Promise<T> {
  try {
    return await withProjectRepoRaw(
      projectId,
      role
        ? async (repo) => {
            await assertProjectRole(role.db, projectId, role.actor, role.min);
            return fn(repo);
          }
        : fn,
    );
  } catch (error) {
    return mapLockTimeout(error);
  }
}

export async function withExistingProjectRepo<T>(
  projectId: string,
  fn: (repo: ProjectRepoWriter) => Promise<T>,
): Promise<T | null> {
  try {
    return await withExistingProjectRepoRaw(projectId, fn);
  } catch (error) {
    return mapLockTimeout(error);
  }
}

export async function withExistingProjectRepoReader<T>(
  projectId: string,
  fn: (repo: ProjectRepoReader) => Promise<T>,
): Promise<T | null> {
  try {
    return await withExistingProjectRepoReaderRaw(projectId, fn);
  } catch (error) {
    return mapLockTimeout(error);
  }
}
