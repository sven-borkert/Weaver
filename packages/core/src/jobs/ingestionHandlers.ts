import type { PrismaClient } from "@weaver/db/client";
import {
  deleteBlobIfOlderThan,
  listBlobDigests,
  listStoredProjectIds,
  sweepTmp,
} from "../ingestion/blobStore";
import { referencedDigests } from "../ingestion/blobReferences";
import {
  failExhaustedIngestionFile,
  INGESTION_STAGE_JOBS,
  listStaleIngestionFiles,
  recoveryStageOf,
  reserveIngestionFileRecovery,
  withProjectIngestionLifecycleLock,
} from "../services/ingestion";
import { notDeleted } from "../services/projectAccess";
import { requestKnowledgeJob } from "./queue";
import { knowledgeJobExpireInSeconds } from "./types";

const RECOVERY_MIN_AGE_MS =
  Math.max(
    ...Object.values(INGESTION_STAGE_JOBS).map(knowledgeJobExpireInSeconds),
  ) * 1_000;

export async function sweepAbandonedUploads(
  db: PrismaClient,
  options: { dataDir: string; ttlMinutes: number },
): Promise<{ projects: number; removed: number }> {
  const liveProjects = await db.project.findMany({
    where: { ...notDeleted },
    select: { id: true },
  });
  const candidates = [
    ...new Set([
      ...liveProjects.map((project) => project.id),
      ...(await listStoredProjectIds(options.dataDir)),
    ]),
  ].map((id) => ({ id }));
  const deletedBefore = new Date(Date.now() - 7 * 86400000);
  const cutoff = new Date(Date.now() - options.ttlMinutes * 60_000);
  let projects = 0;
  let removed = 0;
  const errors: unknown[] = [];
  for (const project of candidates) {
    try {
      const digests = await listBlobDigests(options.dataDir, project.id);
      const tmpRemoved = await withProjectIngestionLifecycleLock(
        db,
        project.id,
        async (tx) => {
          const live = await tx.project.findUnique({
            where: { id: project.id },
            select: { deletedAt: true },
          });
          if (live?.deletedAt && live.deletedAt >= deletedBefore) return null;
          return sweepTmp(options.dataDir, project.id, cutoff);
        },
      );
      if (tmpRemoved === null) continue;
      projects += 1;
      removed += tmpRemoved;
      for (let offset = 0; offset < digests.length; offset += 25) {
        const page = digests.slice(offset, offset + 25);
        removed += await withProjectIngestionLifecycleLock(
          db,
          project.id,
          async (tx) => {
            const live = await tx.project.findUnique({
              where: { id: project.id },
              select: { deletedAt: true },
            });
            if (live?.deletedAt && live.deletedAt >= deletedBefore) return 0;
            const referenced =
              live?.deletedAt === null
                ? await referencedDigests(tx, project.id, page)
                : new Set<string>();
            let count = 0;
            for (const digest of page) {
              if (
                !referenced.has(digest) &&
                (await deleteBlobIfOlderThan(
                  options.dataDir,
                  project.id,
                  digest,
                  cutoff,
                ))
              )
                count += 1;
            }
            return count;
          },
        );
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "ingestion storage cleanup failed for some projects",
    );
  return { projects, removed };
}

/** Recovery waits for the longest ingestion lease, independently of upload cleanup. */
export async function reconcileIngestionFiles(
  db: PrismaClient,
): Promise<{ enqueued: number }> {
  const cutoff = new Date(Date.now() - RECOVERY_MIN_AGE_MS);
  const candidates = await listStaleIngestionFiles(db, cutoff);
  let enqueued = 0;
  const errors: unknown[] = [];
  for (const file of candidates) {
    try {
      if (await failExhaustedIngestionFile(db, file)) continue;
      if (!(await reserveIngestionFileRecovery(db, file))) continue;
      const jobId = await requestKnowledgeJob(
        INGESTION_STAGE_JOBS[recoveryStageOf(file.status)],
        {
          fileId: file.id,
          projectId: file.projectId,
          contentDigest: file.contentDigest,
          baseAttemptCount: file.attemptCount,
        },
      );
      if (!jobId) throw new Error("ingestion recovery job publication failed");
      enqueued += 1;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "ingestion recovery publication failed for some files",
    );
  return { enqueued };
}
