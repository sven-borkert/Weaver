import { Prisma, type PrismaClient } from "@weaver/db/client";
import {
  assertSystemAdmin,
  type UserSecurityContext,
} from "../security/context";
import { CoreError, CORE_ERROR_CODES } from "../errors";
import {
  TASK_FAILURE_CODES,
  TASK_SKIP_REASONS,
} from "../scheduledTasks/scheduleSchema";
import {
  listProcessingInput,
  type ListProcessingInput,
  type ProcessingKind,
} from "../diagnostics/processingSchema";
import { decodePageCursor, encodePageCursor } from "./adminPaging";
import {
  listQueueJobs,
  queueSummary,
  type QueueJobState,
} from "./queueInspection";

export type ProcessingRow = {
  id: string;
  status: string;
  projectId: string | null;
  documentId: string | null;
  fileId: string | null;
  generationId: string | null;
  runId: string | null;
  jobId: string | null;
  attempts: number | null;
  failureCode: string | null;
  createdAt: Date;
  lastAttemptAt: Date | null;
  completedAt: Date | null;
};

type Source = {
  from: Prisma.Sql;
  id: Prisma.Sql;
  createdAt: Prisma.Sql;
  status: Prisma.Sql;
  projectId?: Prisma.Sql;
  documentId?: Prisma.Sql;
  fileId?: Prisma.Sql;
  generationId?: Prisma.Sql;
  runId?: Prisma.Sql;
  jobId?: Prisma.Sql;
  attempts?: Prisma.Sql;
  failureCode?: Prisma.Sql;
  lastAttemptAt?: Prisma.Sql;
  completedAt?: Prisma.Sql;
};
const sources: Record<ProcessingKind, Source> = {
  knowledge_generation: {
    from: Prisma.sql`"KnowledgeGeneration" AS work`,
    id: Prisma.sql`work."id"::text`,
    createdAt: Prisma.sql`work."createdAt"`,
    status: Prisma.sql`work."status"::text`,
    projectId: Prisma.sql`work."projectId"::text`,
    generationId: Prisma.sql`work."id"::text`,
    failureCode: Prisma.sql`work."failureKind"::text`,
    completedAt: Prisma.sql`work."completedAt"`,
  },
  knowledge_document: {
    from: Prisma.sql`"KnowledgeGenerationDocument" AS work`,
    id: Prisma.sql`work."generationId"::text || ':' || work."documentId"::text`,
    createdAt: Prisma.sql`work."createdAt"`,
    status: Prisma.sql`work."status"::text`,
    projectId: Prisma.sql`work."projectId"::text`,
    documentId: Prisma.sql`work."documentId"::text`,
    generationId: Prisma.sql`work."generationId"::text`,
    jobId: Prisma.sql`work."processingJobId"`,
    attempts: Prisma.sql`work."attempts"`,
    failureCode: Prisma.sql`work."failureKind"::text`,
    lastAttemptAt: Prisma.sql`work."lastAttemptAt"`,
    completedAt: Prisma.sql`work."completedAt"`,
  },
  keyword: {
    from: Prisma.sql`"DocumentIndexState" AS work`,
    id: Prisma.sql`work."documentId"::text`,
    createdAt: Prisma.sql`work."createdAt"`,
    status: Prisma.sql`work."status"::text`,
    projectId: Prisma.sql`work."projectId"::text`,
    documentId: Prisma.sql`work."documentId"::text`,
    attempts: Prisma.sql`work."attempts"`,
    failureCode: Prisma.sql`work."failureKind"::text`,
    lastAttemptAt: Prisma.sql`work."lastAttemptAt"`,
    completedAt: Prisma.sql`work."completedAt"`,
  },
  ingestion: {
    from: Prisma.sql`"IngestionFile" AS work`,
    id: Prisma.sql`work."id"::text`,
    createdAt: Prisma.sql`work."createdAt"`,
    status: Prisma.sql`work."status"::text`,
    projectId: Prisma.sql`work."projectId"::text`,
    fileId: Prisma.sql`work."id"::text`,
    jobId: Prisma.sql`work."stageClaimJobId"`,
    attempts: Prisma.sql`work."attemptCount"`,
    failureCode: Prisma.sql`work."failureKind"::text`,
    lastAttemptAt: Prisma.sql`greatest(work."parseStartedAt", work."analyzeStartedAt", work."linkStartedAt")`,
    completedAt: Prisma.sql`CASE WHEN work."status" IN ('ready', 'accepted', 'rejected', 'failed', 'blocked_configuration') THEN work."updatedAt" ELSE NULL END`,
  },
  assistant: {
    from: Prisma.sql`"AssistantRun" AS work`,
    id: Prisma.sql`work."id"::text`,
    createdAt: Prisma.sql`work."queuedAt"`,
    status: Prisma.sql`work."status"::text`,
    runId: Prisma.sql`work."id"::text`,
    jobId: Prisma.sql`work."jobId"`,
    attempts: Prisma.sql`work."attemptCount"`,
    failureCode: Prisma.sql`work."errorCode"`,
    lastAttemptAt: Prisma.sql`work."startedAt"`,
    completedAt: Prisma.sql`work."finishedAt"`,
  },
  scheduled_task: {
    from: Prisma.sql`"ScheduledTaskRun" AS work JOIN "ScheduledTask" AS task ON task."id" = work."taskId"`,
    id: Prisma.sql`work."id"::text`,
    createdAt: Prisma.sql`work."queuedAt"`,
    status: Prisma.sql`work."status"::text`,
    projectId: Prisma.sql`task."outputProjectId"::text`,
    documentId: Prisma.sql`work."outputDocumentId"::text`,
    runId: Prisma.sql`work."id"::text`,
    jobId: Prisma.sql`work."jobId"`,
    failureCode: Prisma.sql`work."errorCode"`,
    lastAttemptAt: Prisma.sql`work."startedAt"`,
    completedAt: Prisma.sql`work."finishedAt"`,
  },
};
const safeCodes = new Set<string>([
  ...TASK_FAILURE_CODES,
  ...TASK_SKIP_REASONS,
  ...CORE_ERROR_CODES,
  "configuration",
  "source_missing",
  "provider",
  "validation",
  "stale",
  "internal",
  "parser",
  "WORKER_LOST",
  "INTERNAL",
  "CANCELLED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function safeId(value: string | null | undefined): string | null {
  return value && uuid.test(value) ? value : null;
}

function projection(source: Source): Prisma.Sql {
  return Prisma.sql`SELECT ${source.id} AS "id", ${source.status} AS "status", ${source.createdAt} AS "createdAt",
    ${source.projectId ?? Prisma.sql`NULL::text`} AS "projectId", ${source.documentId ?? Prisma.sql`NULL::text`} AS "documentId",
    ${source.fileId ?? Prisma.sql`NULL::text`} AS "fileId",
    ${source.generationId ?? Prisma.sql`NULL::text`} AS "generationId", ${source.runId ?? Prisma.sql`NULL::text`} AS "runId",
    ${source.jobId ?? Prisma.sql`NULL::text`} AS "jobId", ${source.attempts ?? Prisma.sql`NULL::integer`} AS "attempts",
    ${source.failureCode ?? Prisma.sql`NULL::text`} AS "failureCode", ${source.lastAttemptAt ?? Prisma.sql`NULL::timestamp`} AS "lastAttemptAt",
    ${source.completedAt ?? Prisma.sql`NULL::timestamp`} AS "completedAt" FROM ${source.from}`;
}

export async function listProcessing(
  db: PrismaClient,
  actor: UserSecurityContext,
  rawInput: ListProcessingInput,
) {
  assertSystemAdmin(actor);
  const parsed = listProcessingInput.safeParse(rawInput);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid processing filters");
  const input = parsed.data;
  const source = sources[input.kind];
  const cursor = input.cursor ? decodePageCursor(input.cursor, 4) : null;
  if (
    cursor &&
    (cursor[0] !== input.kind ||
      cursor[1] !== (input.status ?? "") ||
      !cursor[2] ||
      Number.isNaN(Date.parse(cursor[2])) ||
      new Date(cursor[2]).toISOString() !== cursor[2] ||
      cursor[3]?.split(":").length !==
        (input.kind === "knowledge_document" ? 2 : 1) ||
      !cursor[3]?.split(":").every((id) => uuid.test(id)))
  )
    throw new CoreError(
      "BAD_REQUEST",
      "Cursor does not match processing filters",
      { field: "cursor" },
    );
  const [rows, counts] = await Promise.all([
    db.$queryRaw<
      ProcessingRow[]
    >(Prisma.sql`WITH entries AS (${projection(source)}) SELECT * FROM entries
      WHERE ${input.status ? Prisma.sql`"status" = ${input.status}` : Prisma.sql`TRUE`}
        ${cursor ? Prisma.sql`AND ("createdAt", "id") < (${new Date(cursor[2]!)}, ${cursor[3]})` : Prisma.empty}
      ORDER BY "createdAt" DESC, "id" DESC LIMIT ${input.limit + 1}`),
    db.$queryRaw<Array<{ status: string; count: string }>>(
      Prisma.sql`SELECT ${source.status} AS "status", count(*)::bigint::text AS count FROM ${source.from} GROUP BY ${source.status} ORDER BY ${source.status}`,
    ),
  ]);
  const items = rows.slice(0, input.limit).map((row) => ({
    ...row,
    jobId: safeId(row.jobId),
    failureCode:
      row.failureCode === null
        ? null
        : safeCodes.has(row.failureCode)
          ? row.failureCode
          : "other",
  }));
  const last = items.at(-1);
  return {
    items,
    counts,
    nextCursor:
      rows.length > input.limit && last
        ? encodePageCursor([
            input.kind,
            input.status ?? "",
            last.createdAt.toISOString(),
            last.id,
          ])
        : null,
  };
}

export async function listProcessingQueue(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { state?: QueueJobState; cursor?: string; limit?: number },
) {
  assertSystemAdmin(actor);
  const page = await listQueueJobs(db, actor, input);
  return {
    ...page,
    items: page.items.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.state,
      retryCount: row.retryCount,
      retryLimit: row.retryLimit,
      createdAt: row.createdOn,
      startedAt: row.startedOn,
      completedAt: row.completedOn,
      projectId: row.data.projectId ?? null,
      generationId: row.data.generationId ?? null,
      documentId: row.data.documentId ?? null,
      fileId: row.data.fileId ?? null,
      runId: row.data.runId ?? null,
      jobId: row.id,
    })),
  };
}
export { queueSummary as processingQueueSummary };
