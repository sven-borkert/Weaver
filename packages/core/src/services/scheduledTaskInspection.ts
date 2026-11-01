import type {
  Prisma,
  PrismaClient,
  ScheduledTaskRunStatus,
  ScheduledTaskStatus,
} from "@weaver/db/client";
import { z } from "zod";
import {
  scopeRequestSchema,
  scopeSnapshotSchema,
} from "../assistant/scopeSchema";
import { CoreError } from "../errors";
import { assertSystemAdmin, type SecurityContext } from "../security/context";
import {
  clampLimit,
  decodeTimestampIdPageCursor,
  encodePageCursor,
} from "./adminPaging";
import { assertProjectRole } from "./projectAccess";

const TASK_SUMMARY_SELECT = {
  id: true,
  ownerId: true,
  name: true,
  outputProjectId: true,
  outputDocumentId: true,
  timezone: true,
  cron: true,
  status: true,
  pauseReason: true,
  nextRunAt: true,
  consecutiveFailures: true,
  lastRunAt: true,
  lastRunStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ScheduledTaskSelect;

const RUN_SUMMARY_SELECT = {
  id: true,
  taskId: true,
  status: true,
  trigger: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  jobId: true,
  workerId: true,
  leaseExpiresAt: true,
  outputDocumentId: true,
  outputProjectId: true,
  outputCommitSha: true,
  inputTokens: true,
  outputTokens: true,
  durationMs: true,
  errorCode: true,
} satisfies Prisma.ScheduledTaskRunSelect;

async function assertInspectionAccess(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
) {
  assertSystemAdmin(actor);
  await assertProjectRole(db, projectId, actor, "Maintainer", {
    capability: "content:read",
  });
}

async function assertSourceAccess(
  db: PrismaClient,
  actor: SecurityContext,
  projectIds: string[],
) {
  for (const projectId of projectIds) {
    await assertProjectRole(db, projectId, actor, "Viewer", {
      capability: "content:read",
    });
  }
}

function taskProjectIds(task: {
  outputProjectId: string;
  scopeRequest: unknown;
  scopeSnapshot: unknown;
}) {
  const snapshot = scopeSnapshotSchema.parse(task.scopeSnapshot);
  const request = scopeRequestSchema.parse(task.scopeRequest);
  const requested =
    "projectId" in request
      ? [request.projectId]
      : "projectIds" in request
        ? request.projectIds
        : [];
  return [
    ...new Set([task.outputProjectId, ...snapshot.projectIds, ...requested]),
  ];
}

const contextProjectsSchema = z.object({
  projects: z.array(z.object({ projectId: z.uuid() })).optional(),
});

export async function listScheduledTasksForInspection(
  db: PrismaClient,
  actor: SecurityContext,
  input: {
    projectId: string;
    ownerId?: string;
    status?: ScheduledTaskStatus;
    order?: "oldest" | "newest";
    limit?: number;
    cursor?: string;
  },
) {
  await assertInspectionAccess(db, actor, input.projectId);
  const limit = clampLimit(input.limit);
  const cursor = input.cursor
    ? decodeTimestampIdPageCursor(input.cursor)
    : null;
  const ascending = input.order === "oldest";
  const direction = ascending ? "asc" : "desc";
  const rows = await db.scheduledTask.findMany({
    where: {
      outputProjectId: input.projectId,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: ascending ? { gt: cursor[0] } : { lt: cursor[0] } },
              {
                createdAt: cursor[0],
                id: ascending ? { gt: cursor[1] } : { lt: cursor[1] },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: direction }, { id: direction }],
    take: limit + 1,
    select: TASK_SUMMARY_SELECT,
  });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.createdAt.toISOString(), last.id])
        : null,
    truncated: rows.length > limit,
  };
}

export async function getScheduledTaskForInspection(
  db: PrismaClient,
  actor: SecurityContext,
  input: { projectId: string; taskId: string },
) {
  await assertInspectionAccess(db, actor, input.projectId);
  const record = await db.scheduledTask.findFirst({
    where: { id: input.taskId, outputProjectId: input.projectId },
    select: {
      ...TASK_SUMMARY_SELECT,
      externalInputs: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          name: true,
          toolId: true,
          position: true,
          argumentBindings: true,
        },
      },
      instruction: true,
      scopeRequest: true,
      scopeSnapshot: true,
      outputFolderPath: true,
      outputMode: true,
      outputTitle: true,
      schedule: true,
    },
  });
  if (!record) throw new CoreError("NOT_FOUND");
  const projectIds = taskProjectIds(record);
  await assertSourceAccess(db, actor, projectIds);
  return { record, projectIds };
}

export async function listScheduledTaskRunsForInspection(
  db: PrismaClient,
  actor: SecurityContext,
  input: {
    projectId: string;
    taskId: string;
    status?: ScheduledTaskRunStatus;
    since?: Date;
    until?: Date;
    limit?: number;
    cursor?: string;
  },
) {
  await assertInspectionAccess(db, actor, input.projectId);
  const task = await db.scheduledTask.findFirst({
    where: { id: input.taskId, outputProjectId: input.projectId },
    select: { id: true },
  });
  if (!task) throw new CoreError("NOT_FOUND");
  if (input.since && input.until && input.since > input.until) {
    throw new CoreError("BAD_REQUEST", "since must be before until");
  }
  const limit = clampLimit(input.limit);
  const cursor = input.cursor
    ? decodeTimestampIdPageCursor(input.cursor)
    : null;
  const rows = await db.scheduledTaskRun.findMany({
    where: {
      taskId: input.taskId,
      ...(input.status ? { status: input.status } : {}),
      queuedAt: {
        ...(input.since ? { gte: input.since } : {}),
        ...(input.until ? { lte: input.until } : {}),
      },
      ...(cursor
        ? {
            OR: [
              { queuedAt: { lt: cursor[0] } },
              { queuedAt: cursor[0], id: { lt: cursor[1] } },
            ],
          }
        : {}),
    },
    orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: RUN_SUMMARY_SELECT,
  });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.queuedAt.toISOString(), last.id])
        : null,
    truncated: rows.length > limit,
  };
}

export async function getScheduledTaskRunForInspection(
  db: PrismaClient,
  actor: SecurityContext,
  input: { projectId: string; runId: string },
) {
  await assertInspectionAccess(db, actor, input.projectId);
  const run = await db.scheduledTaskRun.findFirst({
    where: { id: input.runId, task: { outputProjectId: input.projectId } },
    select: {
      ...RUN_SUMMARY_SELECT,
      projectHeads: true,
      contextSummary: true,
      errorMessage: true,
      task: {
        select: {
          outputProjectId: true,
          scopeRequest: true,
          scopeSnapshot: true,
        },
      },
    },
  });
  if (!run) throw new CoreError("NOT_FOUND");
  const { task, ...record } = run;
  const heads =
    run.projectHeads === null
      ? {}
      : z.record(z.uuid(), z.string()).parse(run.projectHeads);
  const context =
    run.contextSummary === null
      ? []
      : (contextProjectsSchema.parse(run.contextSummary).projects ?? []);
  // Historical runs can reference projects removed from the task's current scope.
  const projectIds = [
    ...new Set([
      ...taskProjectIds(task),
      ...Object.keys(heads),
      ...context.map((p) => p.projectId),
    ]),
  ];
  await assertSourceAccess(db, actor, projectIds);
  return { record, projectIds };
}
