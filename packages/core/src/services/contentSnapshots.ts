import type { ProjectRepoReader } from "@weaver/git-store";
import { z } from "zod";
import { CoreError } from "../errors";

export const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export type SnapshotRevisions = {
  /** Immutable project tree used for this read and its continuations. */
  snapshotCommitSha: string;
  /** The resource's latest commit within that snapshot; the expected base of a later edit. */
  baseCommitSha: string;
};

export function snapshotUnavailableError(): CoreError {
  return new CoreError("NOT_FOUND", "snapshot unavailable", {
    reason: "SNAPSHOT_UNAVAILABLE",
  });
}

/** Pins a read to HEAD or to a verified commit reachable from HEAD; never falls back to current content. */
export async function resolveSnapshotCommit(
  repo: ProjectRepoReader,
  atCommitSha?: string,
): Promise<string> {
  const head = await repo.resolveHead();
  if (atCommitSha === undefined) return head;
  if (!commitShaSchema.safeParse(atCommitSha).success)
    throw snapshotUnavailableError();
  if (atCommitSha === head) return head;
  if (!(await repo.isAncestor(atCommitSha, head)))
    throw snapshotUnavailableError();
  return atCommitSha;
}
