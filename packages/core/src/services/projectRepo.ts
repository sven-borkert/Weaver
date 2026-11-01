import { CoreError } from "@weaver/core/errors";
import {
  withExistingProjectRepo as withExistingProjectRepoRaw,
  withExistingProjectRepoReader as withExistingProjectRepoReaderRaw,
  withProjectRepo as withProjectRepoRaw,
  type ProjectRepoReader,
  type ProjectRepoWriter,
} from "@weaver/git-store";
import { RepoLockTimeoutError } from "@weaver/git-store/advisory-lock";

function mapLockTimeout(error: unknown): never {
  if (error instanceof RepoLockTimeoutError) {
    throw new CoreError("CONFLICT", "project repository is busy", {
      retryable: true,
      reason: "BUSY",
    });
  }
  throw error;
}

export async function withProjectRepo<T>(
  projectId: string,
  fn: (repo: ProjectRepoWriter) => Promise<T>,
): Promise<T> {
  try {
    return await withProjectRepoRaw(projectId, fn);
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
