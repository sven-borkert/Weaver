import { Prisma, type PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import type { UserSecurityContext } from "../security/context";
import { nextOccurrence } from "../scheduledTasks/schedule";
import {
  isValidTimezone,
  scheduleToCron,
  taskScheduleSchema,
  type TaskSchedule,
} from "../scheduledTasks/scheduleSchema";
import { assertProjectRole, notDeleted } from "./projectAccess";
import {
  isUniqueViolation,
  lockEnabledSettings,
  runActive,
} from "./wikiInputs";
import { getLiveWikiAgent } from "./wikiAgents";
import { WIKI_ACTIVE_RUN_STATUSES } from "../wiki/states";

export const WIKI_LINT_MANUAL_INTERVAL_MS = 60 * 60_000;
/** A slot found more than this late was missed (worker down), not merely queued behind the tick. */
export const WIKI_LINT_MISSED_GRACE_MS = 15 * 60_000;

export const WIKI_LINT_SKIP_REASONS = [
  "missed",
  "run_active",
  "lint_paused",
  "budget_paused",
  "agent_unavailable",
] as const;
export type WikiLintSkipReason = (typeof WIKI_LINT_SKIP_REASONS)[number];

export type LintScheduleFields = {
  lintSchedule: Prisma.InputJsonValue | typeof Prisma.DbNull;
  lintCron: string | null;
  lintTimezone: string;
  lintNextRunAt: Date | null;
};

/** The stored form: the preset, its derived cron and timezone, and the first slot after `now`. */
export function lintScheduleFields(
  input: { schedule: unknown; timezone: string },
  now: Date = new Date(),
): LintScheduleFields {
  if (!isValidTimezone(input.timezone))
    throw new CoreError("BAD_REQUEST", "Unknown timezone", {
      field: "lintTimezone",
    });
  if (input.schedule === null)
    return {
      lintSchedule: Prisma.DbNull,
      lintCron: null,
      lintTimezone: input.timezone,
      lintNextRunAt: null,
    };
  const parsed = taskScheduleSchema.safeParse(input.schedule);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid maintenance schedule", {
      field: "lintSchedule",
    });
  const schedule: TaskSchedule = parsed.data;
  const cron = scheduleToCron(schedule);
  return {
    lintSchedule: schedule,
    lintCron: cron,
    lintTimezone: input.timezone,
    lintNextRunAt: nextOccurrence(cron, input.timezone, now),
  };
}

type Tx = Prisma.TransactionClient;

async function createLintRun(
  tx: Tx,
  input: {
    projectId: string;
    agentId: string;
    trigger: "manual" | "schedule";
    startedById: string | null;
    now: Date;
  },
): Promise<string> {
  const run = await tx.wikiRun.create({
    data: {
      projectId: input.projectId,
      agentId: input.agentId,
      kind: "lint",
      trigger: input.trigger,
      startedById: input.startedById,
      status: "queued",
      queuedAt: input.now,
      startedAt: input.now,
    },
    select: { id: true },
  });
  return run.id;
}

/** Editor+ starts maintenance now; at most one start per hour per project, whatever became of the last. */
export async function startMaintenance(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string },
  now: Date = new Date(),
): Promise<{ runId: string }> {
  if (actor.authenticationMethod !== "session")
    throw new CoreError("FORBIDDEN");
  await assertProjectRole(db, input.projectId, actor, "Editor", {
    capability: "content:write",
  });
  let runId: string;
  try {
    runId = await db.$transaction(async (tx) => {
      await assertProjectRole(tx, input.projectId, actor, "Editor", {
        capability: "content:write",
      });
      await lockEnabledSettings(tx, input.projectId);
      const agent = await getLiveWikiAgent(tx, input.projectId);
      if (!agent)
        throw new CoreError("CONFLICT", "The wiki agent has been revoked", {
          reason: "WIKI_DISABLED",
        });
      if (
        (await tx.wikiRun.count({
          where: {
            projectId: input.projectId,
            status: { in: [...WIKI_ACTIVE_RUN_STATUSES] },
          },
        })) > 0
      )
        throw runActive();
      const settings = await tx.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: input.projectId },
        select: { destructivePausedAt: true },
      });
      if (settings.destructivePausedAt)
        throw new CoreError(
          "CONFLICT",
          "Wiki runs are paused: changes in the last 24 hours exceed the project's budget",
          { reason: "DESTRUCTIVE_PAUSED" },
        );
      const recent = await tx.wikiRun.findFirst({
        where: {
          projectId: input.projectId,
          kind: "lint",
          trigger: "manual",
          startedAt: {
            gt: new Date(now.getTime() - WIKI_LINT_MANUAL_INTERVAL_MS),
          },
        },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true },
      });
      if (recent) {
        const retryAt = new Date(
          recent.startedAt.getTime() + WIKI_LINT_MANUAL_INTERVAL_MS,
        );
        throw new CoreError(
          "CONFLICT",
          `Maintenance was started less than an hour ago. Try again after ${retryAt.toISOString().slice(11, 16)} UTC.`,
          { reason: "RATE_LIMITED", retryAt: retryAt.toISOString() },
        );
      }
      return createLintRun(tx, {
        projectId: input.projectId,
        agentId: agent.id,
        trigger: "manual",
        startedById: actor.userId,
        now,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw runActive();
    throw error;
  }
  emitDiagnostic({
    event: "wiki.run.started",
    message: "wiki lint run started",
    outcome: "ok",
    projectId: input.projectId,
    details: { runId, kind: "lint", trigger: "manual" },
  });
  return { runId };
}

/**
 * Claims every due slot with a conditional lintNextRunAt update, so several workers claim once.
 * A slot that cannot start is skipped, recorded on the settings row and never queued for later.
 */
export async function claimDueLintRuns(
  db: PrismaClient,
  now: Date,
): Promise<{ started: number; skipped: number }> {
  const due = await db.projectWikiSettings.findMany({
    where: {
      enabled: true,
      lintCron: { not: null },
      lintNextRunAt: { lte: now },
      agentId: { not: null },
      project: { ...notDeleted },
    },
    orderBy: { lintNextRunAt: "asc" },
    take: 100,
    select: {
      projectId: true,
      agentId: true,
      lintCron: true,
      lintTimezone: true,
      lintNextRunAt: true,
    },
  });
  const outcome = { started: 0, skipped: 0 };
  for (const row of due) {
    const next = nextOccurrence(row.lintCron!, row.lintTimezone, now);
    const slot = row.lintNextRunAt!;
    let result: { runId: string } | { skip: WikiLintSkipReason } | null;
    try {
      result = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ProjectWikiSettings" WHERE "projectId" = ${row.projectId}::uuid FOR UPDATE`;
        const claimed = await tx.projectWikiSettings.updateMany({
          where: {
            projectId: row.projectId,
            enabled: true,
            lintNextRunAt: slot,
          },
          data: { lintNextRunAt: next },
        });
        if (claimed.count !== 1) return null;
        const current = await tx.projectWikiSettings.findUniqueOrThrow({
          where: { projectId: row.projectId },
          select: {
            agentId: true,
            lintPausedAt: true,
            destructivePausedAt: true,
          },
        });
        const skip = async (
          reason: WikiLintSkipReason,
        ): Promise<{ skip: WikiLintSkipReason }> => {
          await tx.projectWikiSettings.update({
            where: { projectId: row.projectId },
            data: { lintSkippedAt: slot, lintSkipReason: reason },
          });
          return { skip: reason };
        };
        if (now.getTime() - slot.getTime() > WIKI_LINT_MISSED_GRACE_MS)
          return skip("missed");
        if (current.lintPausedAt) return skip("lint_paused");
        if (current.destructivePausedAt) return skip("budget_paused");
        const agent = await getLiveWikiAgent(tx, row.projectId);
        if (agent?.id !== current.agentId) return skip("agent_unavailable");
        const active = await tx.wikiRun.count({
          where: {
            projectId: row.projectId,
            status: { in: [...WIKI_ACTIVE_RUN_STATUSES] },
          },
        });
        if (active > 0) return skip("run_active");
        const runId = await createLintRun(tx, {
          projectId: row.projectId,
          agentId: agent.id,
          trigger: "schedule",
          startedById: null,
          now,
        });
        await tx.projectWikiSettings.update({
          where: { projectId: row.projectId },
          data: { lintSkippedAt: null, lintSkipReason: null },
        });
        return { runId };
      });
    } catch (error) {
      // The partial unique index is the arbiter when a run slipped in between the count and create.
      if (!isUniqueViolation(error)) throw error;
      await db.projectWikiSettings.updateMany({
        where: { projectId: row.projectId, lintNextRunAt: slot },
        data: {
          lintNextRunAt: next,
          lintSkippedAt: slot,
          lintSkipReason: "run_active",
        },
      });
      result = { skip: "run_active" };
    }
    if (!result) continue;
    if ("runId" in result) {
      outcome.started += 1;
      emitDiagnostic({
        event: "wiki.run.started",
        message: "wiki lint run started",
        outcome: "ok",
        projectId: row.projectId,
        details: { runId: result.runId, kind: "lint", trigger: "schedule" },
      });
      emitDiagnostic({
        event: "wiki.settings.changed",
        message: "Wiki settings changed",
        projectId: row.projectId,
        details: { change: "lint_started", revision: null },
      });
    } else {
      outcome.skipped += 1;
      emitDiagnostic({
        event: "wiki.settings.changed",
        severity: "info",
        message: "scheduled wiki lint slot skipped",
        outcome: "blocked",
        projectId: row.projectId,
        details: { change: "lint_skipped", reason: result.skip },
      });
    }
  }
  return outcome;
}
