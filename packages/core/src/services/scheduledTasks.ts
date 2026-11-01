import { parseDocumentFile } from "../documents/frontmatter";
import { documentKindFromPath } from "../documents/kinds";
import { hasAssetsSegment } from "../documents/images";
import { withExistingProjectRepoReader } from "./projectRepo";
import type { ProjectRepoReader } from "@weaver/git-store";
import { documentTitleSchema } from "../documents/title";
import { z } from "zod";
import {
  type Prisma,
  type PrismaClient,
  type ScheduledTaskPauseReason,
  type ScheduledTaskRunStatus,
  type ScheduledTaskRunTrigger,
  type ScheduledTaskStatus,
} from "@weaver/db/client";
import { canonicalDigest } from "../externalMcp/digest";
import type { ExternalInput, JsonObject } from "../externalMcp/types";
import {
  parseSavedExternalInputs,
  validateTaskExternalInputs,
  type SavedExternalInput,
} from "../scheduledTasks/externalInputs";
import { openProjectRepo } from "@weaver/git-store";
import { resolveScopeSnapshot } from "../assistant/scope";
import {
  scopeRequestSchema,
  scopeSnapshotSchema,
  type ScopeRequest,
  type ScopeSnapshot,
} from "../assistant/scopeSchema";
import { emitDiagnostic } from "../diagnostics/writer";
import { assertSafeSegments } from "../documents/paths";
import { CoreError } from "../errors";
import { requestKnowledgeJob } from "../jobs/queue";
import { projectRoleAtLeast, type ProjectRoleName } from "../roles";
import { nextOccurrence } from "../scheduledTasks/schedule";
import {
  describeSchedule,
  isValidTimezone,
  MAX_CONSECUTIVE_FAILURES,
  MAX_TASKS_PER_OWNER,
  MAX_TASKS_PER_PROJECT,
  scheduleToCron,
  TASK_INSTRUCTION_MAX_LENGTH,
  TASK_NAME_MAX_LENGTH,
  taskScheduleSchema,
  type TaskFailureCode,
  type TaskSchedule,
  type TaskSkipReason,
} from "../scheduledTasks/scheduleSchema";
import { assertOutsideTablesRoot } from "../tables/paths";
import {
  clampLimit,
  decodeTimestampIdPageCursor,
  encodePageCursor,
} from "./adminPaging";
import { listScopeDirsAt } from "./folders";
import {
  assertProjectRole,
  notDeleted,
  resolveProjectAccess,
  type ProjectActor,
} from "./projectAccess";

const TASK_INCLUDE = {
  externalInputs: { orderBy: { position: "asc" as const } },
  owner: { select: { id: true, name: true, email: true } },
  outputProject: { select: { id: true, name: true } },
} satisfies Prisma.ScheduledTaskInclude;
type TaskRow = Prisma.ScheduledTaskGetPayload<{ include: typeof TASK_INCLUDE }>;

export type TaskDefinitionInput = {
  externalInputs?: ExternalInput[];
  name: string;
  instruction: string;
  scope: unknown;
  outputProjectId: string;
  outputFolderPath: string[];
  /** A uuid targets that existing document, null asks for a new one, omitted keeps the current target. */
  outputDocumentId?: string | null;
  /** Title of a newly created target; the task name when empty. */
  outputTitle?: string | null;
  /** `update` hands the current target to the model to revise; `replace` writes a fresh report. */
  outputMode?: "replace" | "update";
  schedule: unknown;
  timezone: string;
};

export type ScheduledTaskSummary = {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string | null;
  /** The account the task runs as; its MCP connections and project access apply. */
  ownerEmail: string;
  outputProjectId: string;
  outputProjectName: string;
  outputDocumentId: string | null;
  schedule: TaskSchedule;
  timezone: string;
  scheduleText: string;
  status: ScheduledTaskStatus;
  pauseReason: ScheduledTaskPauseReason | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: ScheduledTaskRunStatus | null;
  consecutiveFailures: number;
  canManage: boolean;
  canEditDefinition: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ScheduledTaskDetail = ScheduledTaskSummary & {
  externalInputs: ExternalInput[];
  instruction: string;
  scopeRequest: ScopeRequest;
  scopeSnapshot: ScopeSnapshot;
  outputFolderPath: string[];
  outputTitle: string | null;
  outputMode: "replace" | "update";
};

export type ScheduledTaskRunSummary = {
  id: string;
  status: ScheduledTaskRunStatus;
  trigger: ScheduledTaskRunTrigger;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  outputDocumentId: string | null;
  /** The project that report was written to; null when the reader cannot open it. */
  outputProjectId: string | null;
  outputCommitSha: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  contextSummary: unknown;
};

export type LeasedTaskRun = {
  run: { id: string; taskId: string };
  task: {
    externalInputs: SavedExternalInput[];
    id: string;
    name: string;
    instruction: string;
    scopeSnapshot: ScopeSnapshot;
    outputProjectId: string;
    outputFolderPath: string[];
    outputDocumentId: string | null;
    outputTitle: string | null;
    outputMode: "replace" | "update";
  };
  owner: {
    id: string;
    name: string | null;
    email: string;
    role: "Admin" | "User";
    banned: boolean;
    banExpires: Date | null;
    mustChangePassword: boolean;
  };
  previousHeads: Record<string, string> | null;
  previousPeriodEnd: Date | null;
};

function assertSessionActor(actor: ProjectActor): void {
  // Keys and tokens must not create standing automations that act as the user.
  if (actor.authenticationMethod !== "session") {
    throw new CoreError(
      "FORBIDDEN",
      "Only a signed-in session can manage scheduled tasks",
    );
  }
}

function toSummary(
  row: TaskRow,
  canManage: boolean,
  canEditDefinition = false,
): ScheduledTaskSummary {
  const schedule = taskScheduleSchema.parse(row.schedule);
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    ownerName: row.owner.name,
    ownerEmail: row.owner.email,
    outputProjectId: row.outputProjectId,
    outputProjectName: row.outputProject.name,
    outputDocumentId: row.outputDocumentId,
    schedule,
    timezone: row.timezone,
    scheduleText: describeSchedule(schedule, row.timezone),
    status: row.status,
    pauseReason: row.pauseReason,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus,
    consecutiveFailures: row.consecutiveFailures,
    canManage,
    canEditDefinition,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetail(
  row: TaskRow,
  canManage: boolean,
  canEditDefinition = false,
): ScheduledTaskDetail {
  return {
    ...toSummary(row, canManage, canEditDefinition),
    externalInputs: parseSavedExternalInputs(
      canEditDefinition ? row.externalInputs : [],
    ).map(({ id: _id, ...input }) => input),
    instruction: canEditDefinition ? row.instruction : "",
    scopeRequest: canEditDefinition
      ? scopeRequestSchema.parse(row.scopeRequest)
      : { kind: "all" },
    scopeSnapshot: canEditDefinition
      ? scopeSnapshotSchema.parse(row.scopeSnapshot)
      : {
          kind: "all",
          projectIds: [],
          documentId: null,
          tableId: null,
          resolvedAt: row.updatedAt.toISOString(),
          truncated: false,
        },
    outputFolderPath: row.outputFolderPath,
    outputTitle: row.outputTitle,
    outputMode: row.outputMode,
  };
}

function canManage(
  row: { ownerId: string },
  actor: ProjectActor,
  effectiveRole: ProjectRoleName,
): boolean {
  return (
    row.ownerId === actor.userId ||
    projectRoleAtLeast(effectiveRole, "Maintainer")
  );
}

async function loadVisibleTask(
  db: PrismaClient,
  actor: ProjectActor,
  taskId: string,
) {
  const task = await db.scheduledTask.findUnique({
    where: { id: taskId },
    include: TASK_INCLUDE,
  });
  if (!task) throw new CoreError("NOT_FOUND");
  // Non-members (and soft-deleted output projects) surface as NOT_FOUND here.
  const access = await resolveProjectAccess(db, task.outputProjectId, actor);
  return { task, manage: canManage(task, actor, access.effectiveRole) };
}

async function loadManagedTask(
  db: PrismaClient,
  actor: ProjectActor,
  taskId: string,
): Promise<TaskRow> {
  const { task, manage } = await loadVisibleTask(db, actor, taskId);
  if (!manage) throw new CoreError("FORBIDDEN");
  return task;
}

type ValidDefinition = {
  name: string;
  instruction: string;
  schedule: TaskSchedule;
  timezone: string;
  cron: string;
  scopeRequest: ScopeRequest;
};

function validateDefinition(input: TaskDefinitionInput): ValidDefinition {
  const name = input.name.trim();
  if (!name || name.length > TASK_NAME_MAX_LENGTH)
    throw new CoreError(
      "BAD_REQUEST",
      `Name must be 1–${TASK_NAME_MAX_LENGTH} characters`,
      { field: "name" },
    );
  const instruction = input.instruction.trim();
  if (!instruction || instruction.length > TASK_INSTRUCTION_MAX_LENGTH)
    throw new CoreError(
      "BAD_REQUEST",
      `Instruction must be 1–${TASK_INSTRUCTION_MAX_LENGTH} characters`,
      { field: "instruction" },
    );
  const schedule = taskScheduleSchema.safeParse(input.schedule);
  if (!schedule.success)
    throw new CoreError("BAD_REQUEST", "Invalid schedule", {
      field: "schedule",
    });
  if (!isValidTimezone(input.timezone))
    throw new CoreError("BAD_REQUEST", "Unknown timezone", {
      field: "timezone",
    });
  const scopeRequest = scopeRequestSchema.safeParse(input.scope);
  if (!scopeRequest.success)
    throw new CoreError("BAD_REQUEST", "Invalid scope", { field: "scope" });
  return {
    name,
    instruction,
    schedule: schedule.data,
    timezone: input.timezone,
    cron: scheduleToCron(schedule.data),
    scopeRequest: scopeRequest.data,
  };
}

/** Validates an explicitly chosen target document and the title used when one has to be created. */
async function resolveOutputTarget(
  db: PrismaClient,
  input: TaskDefinitionInput,
  taskId: string | null,
): Promise<{ documentId: string | null | undefined; title: string | null }> {
  const rawTitle = input.outputTitle?.trim() ?? "";
  if (rawTitle && !documentTitleSchema.safeParse(rawTitle).success)
    throw new CoreError("BAD_REQUEST", "Enter a valid document title", {
      field: "outputTitle",
    });
  if (input.outputMode && !["replace", "update"].includes(input.outputMode))
    throw new CoreError("BAD_REQUEST", "Unknown output mode", {
      field: "outputMode",
    });
  const documentId = input.outputDocumentId;
  if (documentId) {
    const document = await db.document.findFirst({
      where: { id: documentId, projectId: input.outputProjectId },
      select: { id: true },
    });
    if (!document)
      throw new CoreError(
        "BAD_REQUEST",
        "The target document does not exist in this project",
        { field: "outputDocumentId" },
      );
    const other = await db.scheduledTask.findFirst({
      where: {
        outputDocumentId: documentId,
        ...(taskId ? { id: { not: taskId } } : {}),
      },
      select: { id: true },
    });
    if (other)
      throw new CoreError(
        "CONFLICT",
        "Another task already writes this document",
        { field: "outputDocumentId" },
      );
  }
  return { documentId, title: rawTitle || null };
}

async function assertOutputFolder(
  projectId: string,
  folderPath: string[],
): Promise<void> {
  try {
    assertSafeSegments(folderPath);
    assertOutsideTablesRoot(folderPath);
  } catch {
    throw new CoreError("BAD_REQUEST", "Invalid folder path", {
      field: "outputFolderPath",
    });
  }
  if (folderPath.length === 0) return;
  const missing = () =>
    new CoreError("NOT_FOUND", "Folder does not exist", {
      field: "outputFolderPath",
    });
  const repo = await openProjectRepo(projectId);
  if (!repo) throw missing();
  // A reader has no worktree; derive the folders from the committed tree.
  let folders: string[];
  try {
    folders = await listScopeDirsAt(
      repo,
      "documents",
      await repo.resolveHead(),
    );
  } catch {
    throw missing();
  }
  if (!folders.includes(folderPath.join("/"))) throw missing();
}

async function assertLimits(
  tx: Prisma.TransactionClient,
  ownerId: string,
  outputProjectId: string,
  excludeTaskId?: string,
): Promise<void> {
  // Owner before project, everywhere: concurrent admissions queue, never deadlock.
  for (const key of [
    `weaver:task-quota:owner:${ownerId}`,
    `weaver:task-quota:project:${outputProjectId}`,
  ])
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
  if (
    (await tx.scheduledTask.count({
      where: {
        ownerId,
        ...(excludeTaskId ? { id: { not: excludeTaskId } } : {}),
        outputProject: {
          ...notDeleted,
          organization: { members: { some: { userId: ownerId } } },
        },
      },
    })) >= MAX_TASKS_PER_OWNER
  )
    throw new CoreError(
      "PRECONDITION_FAILED",
      `You already own ${MAX_TASKS_PER_OWNER} tasks`,
    );
  if (
    (await tx.scheduledTask.count({ where: { outputProjectId } })) >=
    MAX_TASKS_PER_PROJECT
  )
    throw new CoreError(
      "PRECONDITION_FAILED",
      `This project already has ${MAX_TASKS_PER_PROJECT} tasks`,
    );
}

function taskEvent(
  event:
    | "task.created"
    | "task.updated"
    | "task.deleted"
    | "task.paused"
    | "task.resumed",
  actor: ProjectActor,
  task: { id: string; name: string; outputProjectId: string },
  details: Record<string, unknown> = {},
) {
  emitDiagnostic({
    event,
    message: `${event.replace("task.", "")} scheduled task "${task.name}"`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    projectId: task.outputProjectId,
    details: { taskId: task.id, ...details },
  });
}

export async function listProjectTasks(
  db: PrismaClient,
  actor: ProjectActor,
  projectId: string,
): Promise<ScheduledTaskSummary[]> {
  const access = await assertProjectRole(db, projectId, actor, "Viewer", {
    capability: "content:read",
  });
  const rows = await db.scheduledTask.findMany({
    where: { outputProjectId: projectId },
    include: TASK_INCLUDE,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return rows.map((row) =>
    toSummary(
      row,
      canManage(row, actor, access.effectiveRole),
      row.ownerId === actor.userId,
    ),
  );
}

export async function listOwnedTasks(
  db: PrismaClient,
  actor: ProjectActor,
): Promise<ScheduledTaskSummary[]> {
  assertSessionActor(actor);
  const rows = await db.scheduledTask.findMany({
    where: { ownerId: actor.userId },
    include: TASK_INCLUDE,
    orderBy: [
      { outputProject: { name: "asc" } },
      { name: "asc" },
      { id: "asc" },
    ],
  });
  const visibleProjects = await db.project.findMany({
    where: {
      ...notDeleted,
      organization: { members: { some: { userId: actor.userId } } },
    },
    select: { id: true },
  });
  const visibleIds = new Set(visibleProjects.map((project) => project.id));
  return rows.map((row) => {
    const visible = visibleIds.has(row.outputProjectId);
    return {
      ...toSummary(row, true, visible),
      ...(visible ? {} : { outputProjectName: "Unavailable project" }),
    };
  });
}

export async function getTask(
  db: PrismaClient,
  actor: ProjectActor,
  taskId: string,
): Promise<ScheduledTaskDetail> {
  const { task, manage } = await loadVisibleTask(db, actor, taskId);
  return toDetail(task, manage, task.ownerId === actor.userId);
}

export async function listTaskRuns(
  db: PrismaClient,
  actor: ProjectActor,
  input: { taskId: string; cursor?: string; limit?: number },
): Promise<{ runs: ScheduledTaskRunSummary[]; nextCursor: string | null }> {
  const { task } = await loadVisibleTask(db, actor, input.taskId);
  const owner = task.ownerId === actor.userId;
  const limit = clampLimit(input.limit, 50);
  const cursor = input.cursor
    ? decodeTimestampIdPageCursor(input.cursor)
    : null;
  const rows = await db.scheduledTaskRun.findMany({
    where: {
      taskId: input.taskId,
      ...(cursor
        ? {
            OR: [
              { queuedAt: { lt: cursor[0] } },
              { queuedAt: cursor[0], id: { gt: cursor[1] } },
            ],
          }
        : {}),
    },
    orderBy: [{ queuedAt: "desc" }, { id: "asc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page.at(-1) : null;
  // An older run may point at a project the task has since left; link it only
  // for a reader who can still open that project.
  const readable = new Set([task.outputProjectId]);
  for (const projectId of new Set(page.map((row) => row.outputProjectId))) {
    if (!projectId || readable.has(projectId)) continue;
    const access = await resolveProjectAccess(db, projectId, actor).catch(
      () => null,
    );
    if (access) readable.add(projectId);
  }
  return {
    runs: page.map((row) => ({
      id: row.id,
      status: row.status,
      trigger: row.trigger,
      queuedAt: row.queuedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      outputDocumentId: row.outputDocumentId,
      outputProjectId:
        row.outputProjectId && readable.has(row.outputProjectId)
          ? row.outputProjectId
          : null,
      outputCommitSha: row.outputCommitSha,
      errorCode: row.errorCode,
      errorMessage: owner ? row.errorMessage : null,
      contextSummary: owner ? row.contextSummary : null,
    })),
    nextCursor: last
      ? encodePageCursor([last.queuedAt.toISOString(), last.id])
      : null,
  };
}

export async function createTask(
  db: PrismaClient,
  actor: ProjectActor,
  input: TaskDefinitionInput,
): Promise<ScheduledTaskDetail> {
  assertSessionActor(actor);
  const valid = validateDefinition(input);
  const access = await assertProjectRole(
    db,
    input.outputProjectId,
    actor,
    "Editor",
  );
  await assertOutputFolder(input.outputProjectId, input.outputFolderPath);
  const target = await resolveOutputTarget(db, input, null);
  const scopeSnapshot = await resolveScopeSnapshot(
    db,
    actor,
    valid.scopeRequest,
  );
  const externalInputs = await validateTaskExternalInputs(
    db,
    actor.userId,
    scopeSnapshot,
    input.outputProjectId,
    input.externalInputs,
  );
  const row = await db.$transaction(async (tx) => {
    await assertLimits(tx, actor.userId, input.outputProjectId);
    return tx.scheduledTask.create({
      data: {
        externalInputs: {
          create: externalInputs.map((value, position) => ({
            name: value.name,
            toolId: value.toolId,
            argumentBindings: value.arguments,
            position,
            createdAt: new Date(),
          })),
        },
        ownerId: actor.userId,
        name: valid.name,
        instruction: valid.instruction,
        scopeRequest: valid.scopeRequest,
        scopeSnapshot: scopeSnapshot,
        outputProjectId: input.outputProjectId,
        outputFolderPath: input.outputFolderPath,
        outputDocumentId: target.documentId ?? null,
        outputTitle: target.title,
        outputMode: input.outputMode ?? "replace",
        schedule: valid.schedule,
        timezone: valid.timezone,
        cron: valid.cron,
        nextRunAt: nextOccurrence(valid.cron, valid.timezone, new Date()),
      },
      include: TASK_INCLUDE,
    });
  });
  taskEvent("task.created", actor, row, {
    schedule: valid.cron,
    timezone: valid.timezone,
  });
  return toDetail(
    row,
    canManage(row, actor, access.effectiveRole),
    row.ownerId === actor.userId,
  );
}

export async function updateTask(
  db: PrismaClient,
  actor: ProjectActor,
  input: TaskDefinitionInput & { taskId: string },
): Promise<ScheduledTaskDetail> {
  assertSessionActor(actor);
  const managed = await loadManagedTask(db, actor, input.taskId);
  if (managed.ownerId !== actor.userId)
    throw new CoreError(
      "FORBIDDEN",
      "Only the task owner can change its definition",
    );
  const row = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ScheduledTask" WHERE "id" = ${input.taskId}::uuid FOR UPDATE`;
    const existing = await tx.scheduledTask.findUniqueOrThrow({
      where: { id: input.taskId },
      include: TASK_INCLUDE,
    });
    const definitions =
      input.externalInputs ??
      parseSavedExternalInputs(existing.externalInputs).map(
        ({ id: _id, ...value }) => value,
      );
    if (
      await tx.scheduledTaskRun.count({
        where: { taskId: input.taskId, status: { in: ["queued", "running"] } },
      })
    )
      throw new CoreError(
        "CONFLICT",
        "Wait for the queued or running task to finish before changing its definition",
      );
    const valid = validateDefinition(input);
    const outputChanged = existing.outputProjectId !== input.outputProjectId;
    if (outputChanged)
      await assertProjectRole(db, input.outputProjectId, actor, "Editor");
    await assertOutputFolder(input.outputProjectId, input.outputFolderPath);
    const target = await resolveOutputTarget(db, input, input.taskId);
    const scopeSnapshot = await resolveScopeSnapshot(
      db,
      actor,
      valid.scopeRequest,
    );
    const scheduleChanged =
      existing.cron !== valid.cron || existing.timezone !== valid.timezone;
    const folderChanged =
      existing.outputFolderPath.join("/") !== input.outputFolderPath.join("/");
    const externalInputs = await validateTaskExternalInputs(
      tx,
      existing.ownerId,
      scopeSnapshot,
      input.outputProjectId,
      definitions,
    );
    if (outputChanged)
      await assertLimits(
        tx,
        existing.ownerId,
        input.outputProjectId,
        input.taskId,
      );
    const unchanged = externalInputs.map((value) =>
      existing.externalInputs.find(
        (saved) =>
          saved.name === value.name &&
          saved.toolId === value.toolId &&
          canonicalDigest(saved.argumentBindings as JsonObject) ===
            canonicalDigest(value.arguments),
      ),
    );
    await tx.scheduledTaskExternalInput.deleteMany({
      where: {
        taskId: input.taskId,
        id: { notIn: unchanged.flatMap((saved) => (saved ? [saved.id] : [])) },
      },
    });
    for (const saved of unchanged)
      if (saved)
        await tx.scheduledTaskExternalInput.update({
          where: { id: saved.id },
          data: { position: saved.position + 10 },
        });
    for (const [position, value] of externalInputs.entries()) {
      const saved = unchanged[position];
      if (saved)
        await tx.scheduledTaskExternalInput.update({
          where: { id: saved.id },
          data: { position },
        });
      else
        await tx.scheduledTaskExternalInput.create({
          data: {
            taskId: input.taskId,
            name: value.name,
            toolId: value.toolId,
            argumentBindings: value.arguments,
            position,
            createdAt: new Date(),
          },
        });
    }
    return tx.scheduledTask.update({
      where: { id: input.taskId },
      data: {
        name: valid.name,
        instruction: valid.instruction,
        scopeRequest: valid.scopeRequest,
        scopeSnapshot: scopeSnapshot,
        outputProjectId: input.outputProjectId,
        outputFolderPath: input.outputFolderPath,
        // An explicit target wins; otherwise a new destination gets a fresh document on the next run.
        ...(target.documentId !== undefined
          ? { outputDocumentId: target.documentId }
          : outputChanged || folderChanged
            ? { outputDocumentId: null }
            : {}),
        ...(input.outputTitle !== undefined
          ? { outputTitle: target.title }
          : {}),
        ...(input.outputMode ? { outputMode: input.outputMode } : {}),
        schedule: valid.schedule,
        timezone: valid.timezone,
        cron: valid.cron,
        ...(scheduleChanged && existing.status === "active"
          ? {
              nextRunAt: nextOccurrence(valid.cron, valid.timezone, new Date()),
            }
          : {}),
      },
      include: TASK_INCLUDE,
    });
  });
  taskEvent("task.updated", actor, row);
  const access = await resolveProjectAccess(db, row.outputProjectId, actor);
  return toDetail(
    row,
    canManage(row, actor, access.effectiveRole),
    row.ownerId === actor.userId,
  );
}

export async function deleteTask(
  db: PrismaClient,
  actor: ProjectActor,
  taskId: string,
): Promise<void> {
  assertSessionActor(actor);
  const owned = await db.scheduledTask.findFirst({
    where: { id: taskId, ownerId: actor.userId },
    include: TASK_INCLUDE,
  });
  const task = owned ?? (await loadManagedTask(db, actor, taskId));
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ScheduledTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
    const inputs = await tx.scheduledTaskExternalInput.count({
      where: { taskId },
    });
    if (
      inputs &&
      (await tx.scheduledTaskRun.count({
        where: { taskId, status: { in: ["queued", "running"] } },
      }))
    )
      throw new CoreError(
        "CONFLICT",
        "Wait for the queued or running task to finish before deleting this task",
      );
    await tx.scheduledTask.delete({ where: { id: taskId } });
  });
  taskEvent("task.deleted", actor, task);
}

export async function pauseTask(
  db: PrismaClient,
  actor: ProjectActor,
  taskId: string,
): Promise<ScheduledTaskDetail> {
  assertSessionActor(actor);
  const task = await loadManagedTask(db, actor, taskId);
  if (task.status === "paused")
    throw new CoreError("PRECONDITION_FAILED", "Task is already paused");
  const row = await db.scheduledTask.update({
    where: { id: taskId },
    data: { status: "paused", pauseReason: "manual", nextRunAt: null },
    include: TASK_INCLUDE,
  });
  taskEvent("task.paused", actor, row, { reason: "manual" });
  return toDetail(row, true, row.ownerId === actor.userId);
}

export async function resumeTask(
  db: PrismaClient,
  actor: ProjectActor,
  taskId: string,
): Promise<ScheduledTaskDetail> {
  assertSessionActor(actor);
  const task = await loadManagedTask(db, actor, taskId);
  if (task.status === "active")
    throw new CoreError("PRECONDITION_FAILED", "Task is already active");
  const row = await db.scheduledTask.update({
    where: { id: taskId },
    data: {
      status: "active",
      pauseReason: null,
      consecutiveFailures: 0,
      nextRunAt: nextOccurrence(task.cron, task.timezone, new Date()),
    },
    include: TASK_INCLUDE,
  });
  taskEvent("task.resumed", actor, row);
  return toDetail(row, true, row.ownerId === actor.userId);
}

export async function runTaskNow(
  db: PrismaClient,
  actor: ProjectActor,
  taskId: string,
): Promise<{ runId: string }> {
  assertSessionActor(actor);
  const task = await loadManagedTask(db, actor, taskId);
  const run = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ScheduledTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
    const current = await tx.scheduledTask.findUniqueOrThrow({
      where: { id: taskId },
      select: { status: true },
    });
    if (current.status !== "active")
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Resume the task before running it now",
      );
    const busy = await tx.scheduledTaskRun.count({
      where: { taskId, status: { in: ["queued", "running"] } },
    });
    if (busy > 0)
      throw new CoreError("CONFLICT", "A run is already queued or running");
    return tx.scheduledTaskRun.create({
      data: { taskId, trigger: "manual" },
      select: { id: true },
    });
  });
  // A run that was never dispatched must not linger as `queued`: it would block
  // every later run-now with CONFLICT and never reach a worker.
  let jobId: string | null = null;
  try {
    jobId = await dispatchTaskRun(db, { runId: run.id, taskId: task.id });
  } catch {
    jobId = null;
  }
  if (!jobId) {
    await db.scheduledTaskRun.delete({ where: { id: run.id } });
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Background jobs are disabled; the run was not queued",
    );
  }
  return { runId: run.id };
}

export async function taskForOutputDocument(
  db: PrismaClient,
  actor: ProjectActor,
  input: { projectId: string; documentId: string },
): Promise<{ id: string; name: string } | null> {
  await assertProjectRole(db, input.projectId, actor, "Viewer", {
    capability: "content:read",
  });
  return db.scheduledTask.findFirst({
    where: {
      outputProjectId: input.projectId,
      outputDocumentId: input.documentId,
    },
    select: { id: true, name: true },
  });
}

// ---- worker side: no actor, called by the tick and the runner ----

export async function dispatchTaskRun(
  db: PrismaClient,
  run: { runId: string; taskId: string },
): Promise<string | null> {
  const jobId = await requestKnowledgeJob("task.run", run);
  if (jobId)
    await db.scheduledTaskRun.updateMany({
      where: { id: run.runId, jobId: null },
      data: { jobId },
    });
  return jobId;
}

/** Claims every due task with a conditional nextRunAt update; a concurrent tick that loses updates zero rows (spec §6). */
export async function claimDueTasks(
  db: PrismaClient,
  now: Date,
  limit = 100,
): Promise<Array<{ runId: string; taskId: string }>> {
  const due = await db.scheduledTask.findMany({
    where: {
      status: "active",
      nextRunAt: { lte: now },
      outputProject: notDeleted,
    },
    orderBy: { nextRunAt: "asc" },
    take: limit,
    select: { id: true, cron: true, timezone: true, nextRunAt: true },
  });
  const claimed: Array<{ runId: string; taskId: string }> = [];
  for (const task of due) {
    const next = nextOccurrence(task.cron, task.timezone, now);
    const run = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ScheduledTask" WHERE "id" = ${task.id}::uuid FOR UPDATE`;
      const result = await tx.scheduledTask.updateMany({
        where: {
          id: task.id,
          status: "active",
          nextRunAt: task.nextRunAt,
          outputProject: notDeleted,
        },
        data: { nextRunAt: next },
      });
      if (result.count !== 1) return null;
      if (
        await tx.scheduledTaskRun.count({
          where: { taskId: task.id, status: { in: ["queued", "running"] } },
        })
      )
        return null;
      return tx.scheduledTaskRun.create({
        data: { taskId: task.id, trigger: "schedule" },
        select: { id: true },
      });
    });
    if (run) claimed.push({ runId: run.id, taskId: task.id });
  }
  return claimed;
}

export async function listStaleQueuedRuns(
  db: PrismaClient,
  olderThan: Date,
): Promise<Array<{ runId: string; taskId: string }>> {
  const rows = await db.scheduledTaskRun.findMany({
    where: { status: "queued", queuedAt: { lt: olderThan } },
    select: { id: true, taskId: true },
    take: 100,
  });
  return rows.map((row) => ({ runId: row.id, taskId: row.taskId }));
}

export async function expireAbandonedRuns(
  db: PrismaClient,
  now: Date,
): Promise<number> {
  const rows = await db.scheduledTaskRun.findMany({
    where: { status: "running", leaseExpiresAt: { lt: now } },
    include: { task: { select: { outputProjectId: true } } },
    take: 100,
  });
  for (const candidate of rows) {
    if (!candidate.outputProjectId) {
      await failTaskRun(db, {
        runId: candidate.id,
        code: "ABANDONED",
        message: "the worker lease expired",
        expiredBefore: now,
      });
      continue;
    }
    const reconcile = async (repo: ProjectRepoReader | null) => {
      const row = await db.scheduledTaskRun.findUnique({
        where: { id: candidate.id },
      });
      if (
        row?.status !== "running" ||
        !row.leaseExpiresAt ||
        row.leaseExpiresAt >= now
      )
        return;
      if (
        !row.outputCommitSha &&
        row.projectHeads &&
        row.contextSummary &&
        repo
      ) {
        const entries = await repo.logForPath(".", {
          skip: 0,
          limit: 2,
          operationId: `task-run:${row.id}`,
        });
        const entry = entries[0];
        if (
          entries.length > 1 ||
          (entry && (!entry.trustedAuthor || entry.runId !== row.id))
        )
          return;
        if (entry?.operationId === `task-run:${row.id}`) {
          const documents: string[] = [];
          const [changed] = await repo.logChangesBefore(entry.sha, {
            limit: 1,
          });
          for (const item of changed?.changes ?? []) {
            const kind = documentKindFromPath(item.path);
            if (
              item.status === "D" ||
              !kind ||
              hasAssetsSegment(item.path) ||
              item.path.startsWith("tables/")
            )
              continue;
            if (
              ((await repo.blobSizeAt(entry.sha, item.path)) ?? Infinity) >
              2_000_000
            )
              continue;
            documents.push(
              parseDocumentFile(
                await repo.showFileAt(entry.sha, item.path),
                kind,
              ).meta.id,
            );
          }
          if (documents.length !== 1) return;
          row.outputDocumentId = documents[0]!;
          row.outputCommitSha = entry.sha;
        }
      }
      if (
        row.outputDocumentId &&
        row.outputCommitSha &&
        row.projectHeads &&
        row.contextSummary
      ) {
        await succeedTaskRun(db, {
          runId: row.id,
          outputDocumentId: row.outputDocumentId,
          outputCommitSha: row.outputCommitSha,
          projectHeads: row.projectHeads as Record<string, string>,
          contextSummary: row.contextSummary,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          durationMs:
            row.durationMs ??
            Math.max(
              0,
              now.getTime() - (row.startedAt ?? row.queuedAt).getTime(),
            ),
        });
      } else
        await failTaskRun(db, {
          runId: row.id,
          code: "ABANDONED",
          message: "the worker lease expired",
          expiredBefore: now,
          publicationChecked: true,
        });
    };
    const handled = await withExistingProjectRepoReader(
      candidate.outputProjectId ?? candidate.task.outputProjectId,
      async (repo) => {
        await reconcile(repo);
        return true;
      },
    );
    if (!handled) await reconcile(null);
  }
  return rows.length;
}

export async function leaseTaskRun(
  db: PrismaClient,
  input: { runId: string; workerId: string; leaseMs: number },
): Promise<LeasedTaskRun | null> {
  return db.$transaction(async (tx) => {
    const run = await tx.scheduledTaskRun.findUnique({
      where: { id: input.runId },
      select: { id: true, taskId: true, status: true },
    });
    if (run?.status !== "queued") return null;
    // Serialize leases per task so two queued runs cannot both start.
    await tx.$queryRaw`SELECT "id" FROM "ScheduledTask" WHERE "id" = ${run.taskId}::uuid FOR UPDATE`;
    const now = new Date();
    const currentTask = await tx.scheduledTask.findUniqueOrThrow({
      where: { id: run.taskId },
      select: { status: true },
    });
    if (currentTask.status !== "active") {
      await tx.scheduledTaskRun.updateMany({
        where: { id: run.id, status: "queued" },
        data: { status: "skipped", errorCode: "task_paused", finishedAt: now },
      });
      return null;
    }
    // Excludes this run: a worker that won the lock already flipped it to running.
    const running = await tx.scheduledTaskRun.count({
      where: { taskId: run.taskId, status: "running", NOT: { id: run.id } },
    });
    if (running > 0) {
      await tx.scheduledTaskRun.updateMany({
        where: { id: run.id, status: "queued" },
        data: { status: "skipped", errorCode: "overlap", finishedAt: now },
      });
      return null;
    }
    const claimed = await tx.scheduledTaskRun.updateMany({
      where: { id: run.id, status: "queued" },
      data: {
        status: "running",
        startedAt: now,
        workerId: input.workerId.slice(0, 200),
        leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
      },
    });
    if (claimed.count !== 1) return null;
    const task = await tx.scheduledTask.findUniqueOrThrow({
      where: { id: run.taskId },
      include: {
        externalInputs: { orderBy: { position: "asc" } },
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            banned: true,
            banExpires: true,
            mustChangePassword: true,
          },
        },
      },
    });
    const lastSuccess = await tx.scheduledTaskRun.findFirst({
      where: { taskId: task.id, status: "succeeded" },
      orderBy: { finishedAt: "desc" },
      select: { projectHeads: true, finishedAt: true, contextSummary: true },
    });
    const previousContext = z
      .object({ period: z.object({ end: z.iso.datetime() }) })
      .safeParse(lastSuccess?.contextSummary);
    return {
      run: { id: run.id, taskId: run.taskId },
      task: {
        externalInputs: task.externalInputs.map((row) => ({
          id: row.id,
          name: row.name,
          toolId: row.toolId,
          arguments: row.argumentBindings as SavedExternalInput["arguments"],
        })),
        id: task.id,
        name: task.name,
        instruction: task.instruction,
        scopeSnapshot: scopeSnapshotSchema.parse(task.scopeSnapshot),
        outputProjectId: task.outputProjectId,
        outputFolderPath: task.outputFolderPath,
        outputDocumentId: task.outputDocumentId,
        outputTitle: task.outputTitle,
        outputMode: task.outputMode,
      },
      owner: {
        id: task.owner.id,
        name: task.owner.name,
        email: task.owner.email,
        role: task.owner.role === "Admin" ? "Admin" : "User",
        banned: task.owner.banned ?? false,
        banExpires: task.owner.banExpires ?? null,
        mustChangePassword: task.owner.mustChangePassword,
      },
      previousPeriodEnd: previousContext.success
        ? new Date(previousContext.data.period.end)
        : (lastSuccess?.finishedAt ?? null),
      previousHeads:
        (lastSuccess?.projectHeads as Record<string, string> | null) ?? null,
    };
  });
}

export async function heartbeatTaskRun(
  db: PrismaClient,
  input: { runId: string; leaseMs: number },
): Promise<boolean> {
  const result = await db.scheduledTaskRun.updateMany({
    where: { id: input.runId, status: "running" },
    data: { leaseExpiresAt: new Date(Date.now() + input.leaseMs) },
  });
  return result.count === 1;
}

async function touchTask(
  tx: Prisma.TransactionClient,
  taskId: string,
  status: ScheduledTaskRunStatus,
  now: Date,
) {
  await tx.scheduledTask.update({
    where: { id: taskId },
    data: { lastRunAt: now, lastRunStatus: status },
  });
}

export async function skipTaskRun(
  db: PrismaClient,
  input: { runId: string; reason: TaskSkipReason },
): Promise<void> {
  const now = new Date();
  await db.$transaction(async (tx) => {
    const run = await tx.scheduledTaskRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { taskId: true },
    });
    const changed = await tx.scheduledTaskRun.updateMany({
      where: { id: input.runId, status: "running" },
      data: { status: "skipped", errorCode: input.reason, finishedAt: now },
    });
    if (changed.count !== 1) return;
    await touchTask(tx, run.taskId, "skipped", now);
  });
}

type TaskPublicationMetadata = {
  outputProjectId: string;
  projectHeads: Record<string, string>;
  contextSummary: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
};

export async function withTaskOutputLease<
  T extends { id: string; headCommitSha: string },
>(
  db: PrismaClient,
  runId: string,
  write: () => Promise<T>,
  receipt?: TaskPublicationMetadata,
): Promise<T> {
  if (receipt) {
    const prepared = await db.scheduledTaskRun.updateMany({
      where: {
        id: runId,
        status: "running",
        leaseExpiresAt: { gt: new Date() },
      },
      data: {
        ...receipt,
        contextSummary: receipt.contextSummary as Prisma.InputJsonValue,
      },
    });
    if (prepared.count !== 1)
      throw new CoreError("CONFLICT", "Task publication lease expired", {
        reason: "TASK_LEASE_LOST",
      });
  }
  const publication: {
    output?: T;
    task?: {
      id: string;
      outputProjectId: string;
      outputFolderPath: string[];
      outputDocumentId: string | null;
    };
  } = {};
  try {
    return await db.$transaction(
      async (tx) => {
        const run = await tx.scheduledTaskRun.findUniqueOrThrow({
          where: { id: runId },
          select: { taskId: true },
        });
        await tx.$queryRaw`SELECT "id" FROM "ScheduledTask" WHERE "id" = ${run.taskId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "ScheduledTaskRun" WHERE "id" = ${runId}::uuid FOR UPDATE`;
        const alive = await tx.scheduledTaskRun.findFirst({
          where: {
            id: runId,
            status: "running",
            leaseExpiresAt: { gt: new Date() },
          },
        });
        if (!alive)
          throw new CoreError(
            "CONFLICT",
            "Task run no longer holds its publication lease",
            { reason: "TASK_LEASE_LOST" },
          );
        publication.task = await tx.scheduledTask.findUniqueOrThrow({
          where: { id: run.taskId },
          select: {
            id: true,
            outputProjectId: true,
            outputFolderPath: true,
            outputDocumentId: true,
          },
        });
        const output = await write();
        publication.output = output;
        if (receipt)
          await tx.scheduledTaskRun.update({
            where: { id: runId },
            data: {
              ...receipt,
              contextSummary: receipt.contextSummary as Prisma.InputJsonValue,
              outputDocumentId: output.id,
              outputCommitSha: output.headCommitSha,
              outputProjectId: receipt.outputProjectId,
            },
          });
        await tx.scheduledTask.update({
          where: { id: run.taskId },
          data: { outputDocumentId: output.id },
        });
        return output;
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    // Git may have committed even when the publication acknowledgement rolled back.
    if (!publication.output || !publication.task) throw error;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (receipt)
          await db.scheduledTaskRun.updateMany({
            where: { id: runId, status: "running" },
            data: {
              ...receipt,
              contextSummary: receipt.contextSummary as Prisma.InputJsonValue,
              outputDocumentId: publication.output.id,
              outputCommitSha: publication.output.headCommitSha,
            },
          });
        await db.scheduledTask.updateMany({
          where: {
            id: publication.task.id,
            outputProjectId: publication.task.outputProjectId,
            outputFolderPath: { equals: publication.task.outputFolderPath },
            outputDocumentId: publication.task.outputDocumentId,
          },
          data: { outputDocumentId: publication.output.id },
        });
        break;
      } catch {
        if (attempt === 2)
          console.warn("Published task receipt will be recovered from Git");
      }
    }
    return publication.output;
  }
}

export async function succeedTaskRun(
  db: PrismaClient,
  input: {
    runId: string;
    outputDocumentId: string;
    outputCommitSha: string;
    projectHeads: Record<string, string>;
    contextSummary: unknown;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number;
  },
): Promise<boolean> {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const run = await tx.scheduledTaskRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { taskId: true, outputProjectId: true },
    });
    await tx.$queryRaw`SELECT "id" FROM "ScheduledTask" WHERE "id" = ${run.taskId}::uuid FOR UPDATE`;
    // From the document, not the task: the task's output project may have moved since publication.
    const output = await tx.document.findUnique({
      where: { id: input.outputDocumentId },
      select: { projectId: true },
    });
    const changed = await tx.scheduledTaskRun.updateMany({
      where: { id: input.runId, status: "running" },
      data: {
        status: "succeeded",
        finishedAt: now,
        outputDocumentId: input.outputDocumentId,
        outputProjectId: output?.projectId ?? run.outputProjectId,
        outputCommitSha: input.outputCommitSha,
        projectHeads: input.projectHeads,
        contextSummary: input.contextSummary as Prisma.InputJsonValue,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        durationMs: input.durationMs,
      },
    });
    if (changed.count !== 1) {
      const accepted = await tx.scheduledTaskRun.findUnique({
        where: { id: input.runId },
      });
      return (
        accepted?.status === "succeeded" &&
        accepted.outputDocumentId === input.outputDocumentId &&
        accepted.outputCommitSha === input.outputCommitSha
      );
    }
    await tx.scheduledTask.update({
      where: { id: run.taskId },
      data: {
        outputDocumentId: input.outputDocumentId,
        lastRunAt: now,
        lastRunStatus: "succeeded",
        consecutiveFailures: 0,
      },
    });
    return true;
  });
}

export async function failTaskRun(
  db: PrismaClient,
  input: {
    runId: string;
    code: TaskFailureCode;
    message: string;
    expiredBefore?: Date;
    publicationChecked?: boolean;
  },
): Promise<{ paused: boolean }> {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const run = await tx.scheduledTaskRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { taskId: true },
    });
    await tx.$queryRaw`SELECT "id" FROM "ScheduledTask" WHERE "id" = ${run.taskId}::uuid FOR UPDATE`;
    const changed = await tx.scheduledTaskRun.updateMany({
      where: {
        id: input.runId,
        outputCommitSha: null,
        status: { in: ["running", "queued"] },
        ...(input.expiredBefore
          ? {
              leaseExpiresAt: { lt: input.expiredBefore },
              ...(!input.publicationChecked ? { outputProjectId: null } : {}),
            }
          : {}),
      },
      data: {
        status: "failed",
        errorCode: input.code,
        errorMessage: input.message.slice(0, 300),
        finishedAt: now,
      },
    });
    if (changed.count !== 1) return { paused: false };
    const task = await tx.scheduledTask.update({
      where: { id: run.taskId },
      data: {
        lastRunAt: now,
        lastRunStatus: "failed",
        ...(input.code === "ABANDONED"
          ? {}
          : { consecutiveFailures: { increment: 1 } }),
      },
      select: {
        id: true,
        name: true,
        outputProjectId: true,
        status: true,
        consecutiveFailures: true,
      },
    });
    if (
      input.code === "ABANDONED" ||
      task.status !== "active" ||
      task.consecutiveFailures < MAX_CONSECUTIVE_FAILURES
    )
      return { paused: false };
    await tx.scheduledTask.update({
      where: { id: task.id },
      data: { status: "paused", pauseReason: "failing", nextRunAt: null },
    });
    emitDiagnostic({
      event: "task.paused",
      severity: "warn",
      message: `paused scheduled task "${task.name}" after ${task.consecutiveFailures} consecutive failures`,
      projectId: task.outputProjectId,
      details: { taskId: task.id, reason: "failing" },
    });
    return { paused: true };
  });
}
