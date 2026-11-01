import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AssistantRunStatus,
  ExternalMcpCallStatus,
  ScheduledTaskRunStatus,
} from "@weaver/db/client";
import { pruneProcessingHistory } from "@weaver/core/services/processingRetention";
import { setRetentionSettings } from "@weaver/core/services/retentionSettings";
import { reconcileAssistantRuns } from "@weaver/core/services/assistantRuns";
import {
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86400000);

async function fixture() {
  const db = getPrisma();
  const user = await makeUser("User", "retention");
  const project = await makeProject("Retention");
  const task = await db.scheduledTask.create({
    data: {
      ownerId: user.id,
      name: "Preserve my task",
      instruction: "Keep this instruction",
      scopeRequest: {},
      scopeSnapshot: {},
      outputProjectId: project.id,
      outputFolderPath: [],
      schedule: {},
      timezone: "UTC",
      cron: "0 0 * * *",
    },
  });
  const taskRun = (status: ScheduledTaskRunStatus, days: number) =>
    db.scheduledTaskRun.create({
      data: {
        taskId: task.id,
        status,
        trigger: "manual",
        queuedAt: daysAgo(days),
        finishedAt:
          status === "running" || status === "queued" ? null : daysAgo(days),
        projectHeads: { [project.id]: "keep-baseline" },
      },
    });
  const assistant = async (status: AssistantRunStatus, days: number) => {
    const conversation = await db.assistantConversation.create({
      data: { ownerId: user.id, title: "Keep my conversation" },
    });
    const message = await db.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        position: 0,
        role: "user",
        content: { text: "Keep my message" },
      },
    });
    const run = await db.assistantRun.create({
      data: {
        conversationId: conversation.id,
        userMessageId: message.id,
        status,
        scopeSnapshot: {},
        actorSnapshot: {},
        queuedAt: daysAgo(days),
        finishedAt: status === "running" ? null : daysAgo(days),
      },
    });
    const attempt = await db.assistantRunAttempt.create({
      data: {
        runId: run.id,
        number: 1,
        workerId: "fixture",
        status: "succeeded",
        startedAt: daysAgo(days),
        endedAt: daysAgo(days),
        leaseExpiresAt: daysAgo(days),
      },
    });
    const event = await db.assistantRunEvent.create({
      data: {
        runId: run.id,
        attemptId: attempt.id,
        sequence: 1,
        type: "run.completed",
        payload: {},
        createdAt: daysAgo(days),
      },
    });
    return { run, attempt, event, conversation, message };
  };
  const externalCall = (
    owner:
      { assistantRunId: string; attemptId: string } | { taskRunId: string },
    status: ExternalMcpCallStatus,
  ) =>
    db.externalMcpCall.create({
      data: {
        ...owner,
        userSnapshotId: user.id,
        userSnapshotName: "User",
        connectionSnapshotId: randomUUID(),
        connectionSnapshotName: "Connection",
        toolSnapshotId: randomUUID(),
        toolSnapshotName: "read",
        ...("taskRunId" in owner
          ? { inputSnapshotId: randomUUID() }
          : { toolCallId: randomUUID() }),
        remoteDigest: "a".repeat(64),
        reviewDigest: "b".repeat(64),
        argsDigest: "c".repeat(64),
        configRevision: 1,
        effect: "read",
        scopeSnapshot: {},
        status,
        preparedAt: daysAgo(50),
        retainedUntil: daysAgo(-1),
      },
    });
  return { db, user, project, task, taskRun, assistant, externalCall };
}

describe("processing history retention", () => {
  beforeEach(resetDb);

  it("bounds usage deletion and retains recent accounting", async () => {
    const db = getPrisma();
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: randomUUID(),
      operation: "fixture",
      provider: "fixture",
      model: "fixture",
      configFingerprint: "fixture",
      durationMs: 1,
      outcome: "success" as const,
      createdAt: daysAgo(index === 3 ? 89 : 91),
    }));
    await db.aiUsage.createMany({ data: rows });
    expect(
      await pruneProcessingHistory(db, NOW, { batchSize: 2 }),
    ).toMatchObject({ aiUsage: 2 });
    expect(await db.aiUsage.count()).toBe(2);
    expect(
      await db.aiUsage.findUnique({ where: { id: rows[3]!.id } }),
    ).not.toBeNull();
    expect(
      await pruneProcessingHistory(db, NOW, { batchSize: 2 }),
    ).toMatchObject({ aiUsage: 1 });
  });

  it("keeps task baselines, latest runs, active work, retained calls, and user content", async () => {
    const f = await fixture();
    const obsolete = await f.taskRun("succeeded", 70);
    const baseline = await f.taskRun("succeeded", 60);
    const oldFailure = await f.taskRun("failed", 55);
    const retained = await f.taskRun("failed", 54);
    await f.externalCall({ taskRunId: retained.id }, "unknown");
    const latest = await f.taskRun("failed", 40);
    const active = await f.taskRun("running", 80);
    expect(await pruneProcessingHistory(f.db, NOW)).toMatchObject({
      taskRuns: 2,
    });
    const ids = (await f.db.scheduledTaskRun.findMany()).map((row) => row.id);
    expect(ids).toEqual(
      expect.arrayContaining([baseline.id, latest.id, active.id, retained.id]),
    );
    expect(ids).not.toContain(obsolete.id);
    expect(ids).not.toContain(oldFailure.id);
    expect(
      await f.db.scheduledTask.findUnique({ where: { id: f.task.id } }),
    ).toMatchObject({ instruction: "Keep this instruction" });
    expect(
      await f.db.project.findUnique({ where: { id: f.project.id } }),
    ).not.toBeNull();
  });

  it("prunes terminal events at seven days and attempts at thirty days without cascading external evidence", async () => {
    const f = await fixture();
    const old = await f.assistant("completed", 40);
    const eventOnly = await f.assistant("failed", 10);
    const recent = await f.assistant("completed", 6);
    const active = await f.assistant("running", 50);
    const retained = [];
    for (const status of [
      "prepared",
      "dispatched",
      "unknown",
      "completed",
    ] as const) {
      const owner = await f.assistant("failed", 50);
      const call = await f.externalCall(
        { assistantRunId: owner.run.id, attemptId: owner.attempt.id },
        status,
      );
      if (status === "prepared") {
        await f.db.externalMcpToolApproval.create({
          data: {
            callId: call.id,
            ownerId: f.user.id,
            runId: owner.run.id,
            attemptId: owner.attempt.id,
            toolCallId: call.toolCallId!,
            scopeSnapshot: {},
            configRevision: 1,
            reviewDigest: "b".repeat(64),
            argsDigest: "c".repeat(64),
            state: "pending",
            pendingArgumentsCiphertext: "encrypted",
            pendingArgumentsKeyVersion: 1,
            pendingArgumentsIv: "iv",
            pendingArgumentsTag: "tag",
            expiresAt: daysAgo(-1),
            createdAt: daysAgo(50),
            retainedUntil: daysAgo(-1),
          },
        });
      }
      retained.push(owner.attempt.id);
    }
    const result = await pruneProcessingHistory(f.db, NOW);
    expect(result).toMatchObject({ assistantEvents: 6, assistantAttempts: 1 });
    expect(
      await f.db.assistantRunAttempt.findUnique({
        where: { id: old.attempt.id },
      }),
    ).toBeNull();
    expect(
      await f.db.assistantRunEvent.findUnique({
        where: { id: eventOnly.event.id },
      }),
    ).toBeNull();
    expect(
      await f.db.assistantRunAttempt.findUnique({
        where: { id: eventOnly.attempt.id },
      }),
    ).not.toBeNull();
    expect(await f.db.assistantRunEvent.findMany()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: recent.event.id }),
        expect.objectContaining({ id: active.event.id }),
      ]),
    );
    expect(
      (await f.db.assistantRunAttempt.findMany()).map((row) => row.id),
    ).toEqual(expect.arrayContaining([active.attempt.id, ...retained]));
    expect(await f.db.externalMcpCall.count()).toBe(4);
    expect(await f.db.externalMcpToolApproval.count()).toBe(1);
    expect(await f.db.assistantConversation.count()).toBe(8);
    expect(
      await f.db.assistantMessage.findUnique({ where: { id: old.message.id } }),
    ).toMatchObject({ content: { text: "Keep my message" } });
    expect(await f.db.assistantRun.count()).toBe(8);
  });

  it("retains late assistant events until the central retention cutoff", async () => {
    const f = await fixture();
    const owner = await f.assistant("completed", 40);
    const late = await f.db.assistantRunEvent.create({
      data: {
        runId: owner.run.id,
        attemptId: owner.attempt.id,
        sequence: 2,
        type: "external.call.status",
        payload: {},
        createdAt: daysAgo(1),
      },
    });

    await reconcileAssistantRuns(f.db, NOW);
    await pruneProcessingHistory(f.db, NOW);
    expect(
      await f.db.assistantRunEvent.findUnique({ where: { id: late.id } }),
    ).toMatchObject({ attemptId: owner.attempt.id });
    expect(
      await f.db.assistantRunEvent.findUnique({
        where: { id: owner.event.id },
      }),
    ).toBeNull();

    await f.db.assistantRunEvent.update({
      where: { id: late.id },
      data: { createdAt: daysAgo(8) },
    });
    expect(await pruneProcessingHistory(f.db, NOW)).toMatchObject({
      assistantEvents: 1,
      assistantAttempts: 1,
    });
    expect(
      await f.db.assistantRunEvent.findUnique({ where: { id: late.id } }),
    ).toBeNull();
  });

  it("preserves a running attempt even if its parent is already terminal", async () => {
    const f = await fixture();
    const owner = await f.assistant("cancelled", 40);
    await f.db.assistantRunAttempt.update({
      where: { id: owner.attempt.id },
      data: { status: "running" },
    });
    expect(await pruneProcessingHistory(f.db, NOW)).toMatchObject({
      assistantAttempts: 0,
    });
  });

  it("drains event batches before deleting their attempt without cascading updates", async () => {
    const f = await fixture();
    const owner = await f.assistant("completed", 40);
    const lastEvent = await f.db.assistantRunEvent.create({
      data: {
        runId: owner.run.id,
        attemptId: owner.attempt.id,
        sequence: 2,
        type: "run.completed",
        payload: {},
        createdAt: daysAgo(39),
      },
    });
    expect(
      await pruneProcessingHistory(f.db, NOW, { batchSize: 1 }),
    ).toMatchObject({
      assistantEvents: 1,
      assistantAttempts: 0,
    });
    expect(
      await f.db.assistantRunEvent.findUnique({ where: { id: lastEvent.id } }),
    ).toMatchObject({ attemptId: owner.attempt.id });
    expect(
      await pruneProcessingHistory(f.db, NOW, { batchSize: 1 }),
    ).toMatchObject({
      assistantEvents: 1,
      assistantAttempts: 1,
    });
  });

  it("serializes concurrent cleanup without waiting on another worker", async () => {
    const db = getPrisma();
    let locked!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('weaver:processing-history-prune'))::text`;
      locked();
      await held;
    });
    await Promise.race([acquired, blocker]);
    try {
      expect(await pruneProcessingHistory(db, NOW)).toMatchObject({
        skipped: true,
      });
    } finally {
      release();
      await blocker;
    }
  });

  it("prunes ingestion batches whose files are all terminal and older than the setting", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "ret-ingest");
    const project = await makeProject("Ret ingest");
    const batch = async (
      status: "accepted" | "failed" | "pending" | "blocked_configuration",
      days: number,
    ) => {
      const b = await db.ingestionBatch.create({
        data: {
          projectId: project.id,
          createdById: user.id,
          origin: "upload",
          createdAt: daysAgo(days),
        },
      });
      const f = await db.ingestionFile.create({
        data: {
          batchId: b.id,
          projectId: project.id,
          fileName: "f.md",
          mimeType: "text/markdown",
          byteSize: 1,
          contentDigest: "d".repeat(64),
          status,
          createdAt: daysAgo(days),
        },
      });
      // IngestionFile.updatedAt is @updatedAt; Prisma overwrites an explicit
      // create-time value, so backdate it with a raw UPDATE instead.
      await db.$executeRaw`UPDATE "IngestionFile" SET "updatedAt" = ${daysAgo(days)} WHERE id = ${f.id}`;
      return b.id;
    };
    const old = await batch("accepted", 45);
    const oldFailed = await batch("failed", 45);
    await batch("blocked_configuration", 45);
    const recent = await batch("accepted", 10);
    const active = await batch("pending", 45);
    await pruneProcessingHistory(db, NOW);
    const remaining = (
      await db.ingestionBatch.findMany({ select: { id: true } })
    )
      .map((b) => b.id)
      .sort();
    expect(remaining).toEqual([active, recent].sort());
    expect(remaining).not.toContain(old);
    expect(remaining).not.toContain(oldFailed);
  });

  it("keeps an expired batch whose failed file is being retried while retention runs", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "ret-ingest-race");
    const project = await makeProject("Ret ingest race");
    const batch = await db.ingestionBatch.create({
      data: {
        projectId: project.id,
        createdById: user.id,
        origin: "upload",
        createdAt: daysAgo(45),
      },
    });
    const file = await db.ingestionFile.create({
      data: {
        batchId: batch.id,
        projectId: project.id,
        fileName: "f.md",
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest: "d".repeat(64),
        status: "failed",
        createdAt: daysAgo(45),
      },
    });
    await db.$executeRaw`UPDATE "IngestionFile" SET "updatedAt" = ${daysAgo(45)} WHERE id = ${file.id}`;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    // A retry: re-queues the failed file and commits after retention started.
    const retry = db.$transaction(
      async (tx) => {
        await tx.ingestionFile.update({
          where: { id: file.id },
          data: { status: "pending" },
        });
        locked();
        await gate;
      },
      { timeout: 20_000 },
    );
    await holding;

    const prune = pruneProcessingHistory(db, NOW);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [row] = await db.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if ((row?.count ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    release();
    await retry;
    const result = await prune;

    expect(result).toMatchObject({ skipped: false, ingestionBatches: 0 });
    expect(
      await db.ingestionFile.findUnique({
        where: { id: file.id },
        select: { status: true },
      }),
    ).toEqual({ status: "pending" });
    expect(await db.ingestionBatch.count({ where: { id: batch.id } })).toBe(1);
  });

  it("prunes ingestion batches with zero files once older than the setting", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "ret-ingest-empty");
    const project = await makeProject("Ret ingest empty");
    const old = await db.ingestionBatch.create({
      data: {
        projectId: project.id,
        createdById: user.id,
        origin: "upload",
        createdAt: daysAgo(45),
      },
    });
    const recent = await db.ingestionBatch.create({
      data: {
        projectId: project.id,
        createdById: user.id,
        origin: "upload",
        createdAt: daysAgo(10),
      },
    });
    await pruneProcessingHistory(db, NOW);
    const remaining = (
      await db.ingestionBatch.findMany({ select: { id: true } })
    ).map((b) => b.id);
    expect(remaining).toContain(recent.id);
    expect(remaining).not.toContain(old.id);
  });

  it("prunes idle conversations by the setting, never active ones, pending proposals, or external evidence", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "ret-conv");
    const project = await makeProject("Ret conv");
    const conv = async (days: number) => {
      const row = await db.assistantConversation.create({
        data: { ownerId: user.id, title: "c", lastMessageAt: daysAgo(days) },
      });
      // AssistantConversation.updatedAt is @updatedAt; Prisma overwrites an
      // explicit create-time value, so backdate it with a raw UPDATE to keep
      // this fixture's idle/fresh split driven by lastMessageAt alone.
      await db.$executeRaw`UPDATE "AssistantConversation" SET "updatedAt" = ${daysAgo(days)} WHERE id = ${row.id}`;
      return row;
    };
    const runFor = async (
      conversationId: string,
      days: number,
      status: AssistantRunStatus = "completed",
    ) => {
      const message = await db.assistantMessage.create({
        data: {
          conversationId,
          position: 0,
          role: "user",
          content: { text: "hi" },
        },
      });
      return db.assistantRun.create({
        data: {
          conversationId,
          userMessageId: message.id,
          status,
          scopeSnapshot: {},
          actorSnapshot: {},
          queuedAt: daysAgo(days),
          finishedAt: status === "running" ? null : daysAgo(days),
        },
      });
    };

    const idle = await conv(120);
    const fresh = await conv(10);

    const withActiveRun = await conv(120);
    await runFor(withActiveRun.id, 120, "running");

    const withPendingProposal = await conv(120);
    const proposalRun = await runFor(withPendingProposal.id, 120);
    await db.assistantProposal.create({
      data: {
        conversationId: withPendingProposal.id,
        runId: proposalRun.id,
        userId: user.id,
        projectId: project.id,
        kind: "document.patch",
        summary: "Pending proposal",
        operation: {},
        preview: {},
        status: "pending",
        expiresAt: daysAgo(-1),
      },
    });

    const withExternalCall = await conv(120);
    const externalRun = await runFor(withExternalCall.id, 120);
    const externalAttempt = await db.assistantRunAttempt.create({
      data: {
        runId: externalRun.id,
        number: 1,
        workerId: "fixture",
        status: "succeeded",
        startedAt: daysAgo(120),
        endedAt: daysAgo(120),
        leaseExpiresAt: daysAgo(120),
      },
    });
    await db.externalMcpCall.create({
      data: {
        assistantRunId: externalRun.id,
        attemptId: externalAttempt.id,
        toolCallId: randomUUID(),
        userSnapshotId: user.id,
        userSnapshotName: "User",
        connectionSnapshotId: randomUUID(),
        connectionSnapshotName: "Connection",
        toolSnapshotId: randomUUID(),
        toolSnapshotName: "read",
        remoteDigest: "a".repeat(64),
        reviewDigest: "b".repeat(64),
        argsDigest: "c".repeat(64),
        configRevision: 1,
        effect: "read",
        scopeSnapshot: {},
        preparedAt: daysAgo(120),
        retainedUntil: daysAgo(-1),
      },
    });

    await pruneProcessingHistory(db, NOW);
    const ids = (
      await db.assistantConversation.findMany({ select: { id: true } })
    ).map((c) => c.id);
    expect(ids).not.toContain(idle.id);
    expect(ids).toContain(fresh.id);
    expect(ids).toContain(withActiveRun.id);
    expect(ids).toContain(withPendingProposal.id);
    expect(ids).toContain(withExternalCall.id);
  });

  it("honours the stored retention settings", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "ret-admin");
    try {
      await setRetentionSettings(db, securityContextFor(admin), {
        assistantConversationDays: 0,
        aiUsageDays: 400,
      });

      const idleUser = await makeUser("User", "ret-admin-conv");
      const idleConversation = await db.assistantConversation.create({
        data: {
          ownerId: idleUser.id,
          title: "c",
          lastMessageAt: daysAgo(120),
        },
      });
      const usage = await db.aiUsage.create({
        data: {
          operation: "fixture",
          provider: "fixture",
          model: "fixture",
          configFingerprint: "fixture",
          durationMs: 1,
          outcome: "success",
          createdAt: daysAgo(100),
        },
      });

      await pruneProcessingHistory(db, NOW);

      expect(
        await db.assistantConversation.findUnique({
          where: { id: idleConversation.id },
        }),
      ).not.toBeNull();
      expect(
        await db.aiUsage.findUnique({ where: { id: usage.id } }),
      ).not.toBeNull();
    } finally {
      await db.systemSetting.deleteMany({ where: { key: "retention" } });
    }
  });

  it("keeps an idle conversation renamed or pinned recently even with an old last message", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "ret-recent-update");
    const conversation = await db.assistantConversation.create({
      data: { ownerId: user.id, title: "c", lastMessageAt: daysAgo(120) },
    });
    await db.$executeRaw`UPDATE "AssistantConversation" SET "updatedAt" = ${daysAgo(10)} WHERE id = ${conversation.id}`;

    await pruneProcessingHistory(db, NOW);

    expect(
      await db.assistantConversation.findUnique({
        where: { id: conversation.id },
      }),
    ).not.toBeNull();
  });

  it("keeps an idle conversation whose most recent run queuedAt is inside the cutoff", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "ret-recent-run");
    const conversation = await db.assistantConversation.create({
      data: { ownerId: user.id, title: "c", lastMessageAt: daysAgo(120) },
    });
    await db.$executeRaw`UPDATE "AssistantConversation" SET "updatedAt" = ${daysAgo(120)} WHERE id = ${conversation.id}`;
    const message = await db.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        position: 0,
        role: "user",
        content: { text: "hi" },
      },
    });
    await db.assistantRun.create({
      data: {
        conversationId: conversation.id,
        userMessageId: message.id,
        status: "completed",
        scopeSnapshot: {},
        actorSnapshot: {},
        queuedAt: daysAgo(10),
        finishedAt: daysAgo(10),
      },
    });

    await pruneProcessingHistory(db, NOW);

    expect(
      await db.assistantConversation.findUnique({
        where: { id: conversation.id },
      }),
    ).not.toBeNull();
  });

  it("prunes a ten-day-old finished ingestion batch once ingestionDays is overridden to seven", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "ret-ingest-override");
    try {
      await setRetentionSettings(db, securityContextFor(admin), {
        ingestionDays: 7,
      });

      const user = await makeUser("User", "ret-ingest-override-owner");
      const project = await makeProject("Ret ingest override");
      const batch = await db.ingestionBatch.create({
        data: {
          projectId: project.id,
          createdById: user.id,
          origin: "upload",
          createdAt: daysAgo(10),
        },
      });
      const file = await db.ingestionFile.create({
        data: {
          batchId: batch.id,
          projectId: project.id,
          fileName: "f.md",
          mimeType: "text/markdown",
          byteSize: 1,
          contentDigest: "e".repeat(64),
          status: "accepted",
          createdAt: daysAgo(10),
        },
      });
      await db.$executeRaw`UPDATE "IngestionFile" SET "updatedAt" = ${daysAgo(10)} WHERE id = ${file.id}`;

      await pruneProcessingHistory(db, NOW);

      expect(
        await db.ingestionBatch.findUnique({ where: { id: batch.id } }),
      ).toBeNull();
    } finally {
      await db.systemSetting.deleteMany({ where: { key: "retention" } });
    }
  });
});
