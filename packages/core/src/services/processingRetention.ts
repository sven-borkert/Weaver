import type { PrismaClient } from "@weaver/db/client";
import { PROCESSING_RETENTION_DAYS } from "../diagnostics/processingRetention";
import { emitDiagnostic } from "../diagnostics/writer";
import { getRetentionSettings } from "./retentionSettings";

export { PROCESSING_RETENTION_DAYS } from "../diagnostics/processingRetention";
export const PROCESSING_RETENTION_BATCH_SIZE = 5000;
const PRUNE_LOCK_NAME = "weaver:processing-history-prune";
const CONVERSATION_PRUNE_BATCH_SIZE = 1000;

export async function pruneProcessingHistory(
  db: PrismaClient,
  now = new Date(),
  options: { batchSize?: number } = {},
) {
  const batchSize = options.batchSize ?? PROCESSING_RETENTION_BATCH_SIZE;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > PROCESSING_RETENTION_BATCH_SIZE
  )
    throw new RangeError(
      "Processing retention batch size must be between 1 and 5000",
    );
  if (!Number.isFinite(now.getTime()))
    throw new RangeError("Invalid retention time");
  const settings = await getRetentionSettings(db);
  const cutoff = (days: number) =>
    new Date(now.getTime() - days * 86400000).toISOString();
  const result = await db.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${PRUNE_LOCK_NAME})) AS locked`;
      if (!lock?.locked)
        return {
          skipped: true,
          aiUsage: 0,
          taskRuns: 0,
          assistantEvents: 0,
          assistantAttempts: 0,
          ingestionBatches: 0,
          assistantConversations: 0,
        };

      const aiUsage = await tx.$executeRaw`
      WITH expired AS (
        SELECT id FROM "AiUsage"
        WHERE "createdAt" < (${cutoff(settings.aiUsageDays)}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "createdAt", id LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "AiUsage" u USING expired e WHERE u.id = e.id`;

      const taskRuns = await tx.$executeRaw`
      WITH expired AS (
        SELECT r.id FROM "ScheduledTaskRun" r
        WHERE r.status IN ('succeeded', 'failed', 'skipped')
          AND r."finishedAt" < (${cutoff(settings.taskRunDays)}::timestamptz AT TIME ZONE 'UTC')
          AND EXISTS (
            SELECT 1 FROM "ScheduledTaskRun" newer
            WHERE newer."taskId" = r."taskId"
              AND (newer."queuedAt" > r."queuedAt" OR (newer."queuedAt" = r."queuedAt" AND newer.id < r.id))
          )
          AND (r.status <> 'succeeded' OR EXISTS (
            SELECT 1 FROM "ScheduledTaskRun" baseline
            WHERE baseline."taskId" = r."taskId" AND baseline.status = 'succeeded'
              AND baseline."finishedAt" > r."finishedAt"
          ))
          AND NOT EXISTS (SELECT 1 FROM "ExternalMcpCall" c WHERE c."taskRunId" = r.id)
        ORDER BY r."finishedAt", r.id LIMIT ${batchSize} FOR UPDATE OF r SKIP LOCKED
      )
      DELETE FROM "ScheduledTaskRun" r USING expired e WHERE r.id = e.id`;

      // Three statements, not one: under READ COMMITTED each gets a fresh
      // snapshot, so a retry that re-queued a failed file is seen by the DELETE's
      // recheck, and one still in flight blocks on the file lock taken here.
      // Files before batch is deleteBatch's lock order too.
      const expiredBatches = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT b.id::text AS id FROM "IngestionBatch" b
        WHERE NOT EXISTS (
          SELECT 1 FROM "IngestionFile" f WHERE f."batchId" = b.id
            AND f.status NOT IN ('accepted', 'rejected', 'failed', 'blocked_configuration')
        )
        AND coalesce((SELECT max(f."updatedAt") FROM "IngestionFile" f WHERE f."batchId" = b.id), b."createdAt")
            < (${cutoff(settings.ingestionDays)}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY b."createdAt", b.id LIMIT ${batchSize}`;
      const expiredBatchIds = expiredBatches.map((batch) => batch.id);
      let ingestionBatches = 0;
      if (expiredBatchIds.length > 0) {
        await tx.$queryRaw`
          SELECT f.id FROM "IngestionFile" f
          WHERE f."batchId" = ANY(${expiredBatchIds}::uuid[])
          ORDER BY f.id FOR UPDATE`;
        ingestionBatches = await tx.$executeRaw`
          DELETE FROM "IngestionBatch" b
          WHERE b.id = ANY(${expiredBatchIds}::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM "IngestionFile" f WHERE f."batchId" = b.id
                AND f.status NOT IN ('accepted', 'rejected', 'failed', 'blocked_configuration')
            )
            AND coalesce((SELECT max(f."updatedAt") FROM "IngestionFile" f WHERE f."batchId" = b.id), b."createdAt")
                < (${cutoff(settings.ingestionDays)}::timestamptz AT TIME ZONE 'UTC')`;
      }

      const assistantConversations =
        settings.assistantConversationDays > 0
          ? await tx.$executeRaw`
      WITH expired AS (
        SELECT c.id FROM "AssistantConversation" c
        WHERE greatest(c."lastMessageAt", c."updatedAt") < (${cutoff(settings.assistantConversationDays)}::timestamptz AT TIME ZONE 'UTC')
          AND NOT EXISTS (SELECT 1 FROM "AssistantRun" r WHERE r."conversationId" = c.id
            AND (r.status IN ('queued','running','cancelling') OR r."queuedAt" >= (${cutoff(settings.assistantConversationDays)}::timestamptz AT TIME ZONE 'UTC')))
          AND NOT EXISTS (SELECT 1 FROM "AssistantProposal" p WHERE p."conversationId" = c.id AND p.status IN ('pending','accepting'))
          AND NOT EXISTS (SELECT 1 FROM "ExternalMcpCall" x JOIN "AssistantRun" r ON r.id = x."assistantRunId" WHERE r."conversationId" = c.id)
          AND NOT EXISTS (SELECT 1 FROM "ExternalMcpToolApproval" a JOIN "AssistantRun" r ON r.id = a."runId" WHERE r."conversationId" = c.id)
        ORDER BY greatest(c."lastMessageAt", c."updatedAt"), c.id LIMIT ${Math.min(batchSize, CONVERSATION_PRUNE_BATCH_SIZE)} FOR UPDATE OF c SKIP LOCKED
      )
      DELETE FROM "AssistantConversation" c USING expired e WHERE c.id = e.id`
          : 0;

      const assistantEvents = await tx.$executeRaw`
      WITH expired AS (
        SELECT e.id FROM "AssistantRunEvent" e
        JOIN "AssistantRun" r ON r.id = e."runId"
        WHERE e."createdAt" < (${cutoff(PROCESSING_RETENTION_DAYS.assistantEvents)}::timestamptz AT TIME ZONE 'UTC')
          AND r.status IN ('completed', 'failed', 'cancelled')
          AND r."finishedAt" < (${cutoff(PROCESSING_RETENTION_DAYS.assistantEvents)}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY e."createdAt", e.id LIMIT ${batchSize} FOR UPDATE OF e SKIP LOCKED
      )
      DELETE FROM "AssistantRunEvent" e USING expired old WHERE e.id = old.id`;

      // External housekeeping owns call/approval retention; never cascade those rows.
      const assistantAttempts = await tx.$executeRaw`
      WITH expired AS (
        SELECT a.id FROM "AssistantRunAttempt" a
        JOIN "AssistantRun" r ON r.id = a."runId"
        WHERE a.status IN ('succeeded', 'failed', 'abandoned', 'cancelled')
          AND a."endedAt" < (${cutoff(PROCESSING_RETENTION_DAYS.assistantAttempts)}::timestamptz AT TIME ZONE 'UTC')
          AND r.status IN ('completed', 'failed', 'cancelled')
          AND r."finishedAt" < (${cutoff(PROCESSING_RETENTION_DAYS.assistantAttempts)}::timestamptz AT TIME ZONE 'UTC')
          AND NOT EXISTS (SELECT 1 FROM "AssistantRunEvent" e WHERE e."attemptId" = a.id)
          AND NOT EXISTS (SELECT 1 FROM "ExternalMcpCall" c WHERE c."attemptId" = a.id)
          AND NOT EXISTS (SELECT 1 FROM "ExternalMcpToolApproval" p WHERE p."attemptId" = a.id)
        ORDER BY a."endedAt", a.id LIMIT ${batchSize} FOR UPDATE OF a SKIP LOCKED
      )
      DELETE FROM "AssistantRunAttempt" a USING expired e WHERE a.id = e.id`;

      return {
        skipped: false,
        aiUsage,
        taskRuns,
        assistantEvents,
        assistantAttempts,
        ingestionBatches,
        assistantConversations,
      };
    },
    { timeout: 30_000 },
  );

  const { skipped, ...counts } = result;
  if (!skipped && Object.values(counts).some((count) => count > 0))
    emitDiagnostic({
      event: "processing.history.pruned",
      severity: "info",
      outcome: "ok",
      message: "Expired processing history pruned",
      details: counts,
    });
  return result;
}
