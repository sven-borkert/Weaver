import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import {
  listDiagnosticEvents,
  encodeDiagnosticEventCursor,
} from "@weaver/core/services/diagnosticEvents";
import { beforeEach, describe, expect, it } from "vitest";
import type { ListDiagnosticEventsInput } from "~/server/api/schemas/diagnostics";
import { listProcessing } from "@weaver/core/services/processingInspection";
import { setDiagnosticsSettings } from "@weaver/core/services/diagnosticsSettings";
import {
  makeUser,
  makeProject,
  getPrisma,
  resetDb,
  callerFor,
  securityContextFor,
} from "./_harness";

beforeEach(async () => {
  await resetDb();
});

describe("global processing metadata", () => {
  it("requires system administration before database reads", async () => {
    const user = await makeUser("User", "processing-user");
    await expect(
      listProcessing(getPrisma(), securityContextFor(user), {
        kind: "keyword",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(user).diagnostics.listProcessing({ kind: "keyword" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("shows durable state at off level without exposing project content or failure prose", async () => {
    const admin = await makeUser("Admin", "processing-admin");
    const project = await makeProject("PRIVATE PROJECT NAME");
    const db = getPrisma();
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "off",
    });
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "private fingerprint",
        embeddingModel: "private model",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "private prompt",
        failureKind: "provider",
        failureSummary: "PRIVATE FAILURE MESSAGE",
        status: "failed",
      },
    });
    const documentId = randomUUID();
    await db.knowledgeGenerationDocument.create({
      data: {
        projectId: project.id,
        generationId: generation.id,
        documentId,
        targetSha: "private sha",
        configFingerprint: "private fingerprint",
        status: "failed",
        failureKind: "validation",
        failureSummary: "PRIVATE FAILURE MESSAGE",
        attempts: 3,
      },
    });
    await db.documentIndexState.create({
      data: {
        projectId: project.id,
        documentId,
        targetSha: "private sha",
        status: "failed",
        failureKind: "source_missing",
        failureSummary: "PRIVATE FAILURE MESSAGE",
      },
    });
    const caller = callerFor(admin);
    for (const kind of [
      "knowledge_generation",
      "knowledge_document",
      "keyword",
    ] as const) {
      const page = await caller.diagnostics.listProcessing({
        kind,
        status: "failed",
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        projectId: project.id,
        status: "failed",
      });
      expect(JSON.stringify(page)).not.toMatch(/PRIVATE|private/);
    }
    expect(await db.diagnosticEvent.count()).toBe(0);
  });

  it("paginates tied timestamps without duplicate rows and binds cursors to filters", async () => {
    const admin = await makeUser("Admin", "processing-paging");
    const project = await makeProject("Pagination");
    const db = getPrisma();
    const createdAt = new Date("2026-09-01T00:00:00Z");
    await db.documentIndexState.createMany({
      data: Array.from({ length: 3 }, (_, index) => ({
        documentId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        projectId: project.id,
        targetSha: "a".repeat(40),
        status: "failed" as const,
        createdAt,
      })),
    });
    const caller = callerFor(admin);
    const first = await caller.diagnostics.listProcessing({
      kind: "keyword",
      status: "failed",
      limit: 2,
    });
    const second = await caller.diagnostics.listProcessing({
      kind: "keyword",
      status: "failed",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(first.items.map((row) => row.id)).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(second.items.map((row) => row.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(first.counts).toEqual([{ status: "failed", count: "3" }]);
    await expect(
      caller.diagnostics.listProcessing({
        kind: "knowledge_generation",
        status: "failed",
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.diagnostics.listProcessing({
        kind: "keyword",
        status: "ready",
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.diagnostics.listProcessing({ kind: "assistant", status: "ready" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reports ingestion, assistant and task metadata with closed failure codes", async () => {
    const admin = await makeUser("Admin", "processing-sources");
    const project = await makeProject("PRIVATE NAME");
    const db = getPrisma();
    const jobId = randomUUID();
    const batch = await db.ingestionBatch.create({
      data: { projectId: project.id, createdById: admin.id, origin: "upload" },
    });
    const file = await db.ingestionFile.create({
      data: {
        batchId: batch.id,
        projectId: project.id,
        fileName: "PRIVATE FILE",
        mimeType: "text/plain",
        byteSize: 4,
        contentDigest: "private digest",
        status: "failed",
        failureKind: "provider",
        failureMessage: "PRIVATE FAILURE",
        stageClaimJobId: jobId,
      },
    });
    const conversation = await db.assistantConversation.create({
      data: { ownerId: admin.id, title: "PRIVATE TITLE" },
    });
    const message = await db.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        position: 0,
        role: "user",
        content: { text: "PRIVATE MESSAGE" },
      },
    });
    const run = await db.assistantRun.create({
      data: {
        conversationId: conversation.id,
        userMessageId: message.id,
        scopeSnapshot: {},
        actorSnapshot: {},
        status: "failed",
        errorCode: "PRIVATE ERROR",
        errorMessage: "PRIVATE FAILURE",
        jobId,
      },
    });
    const task = await db.scheduledTask.create({
      data: {
        ownerId: admin.id,
        name: "PRIVATE TASK",
        instruction: "PRIVATE INSTRUCTIONS",
        scopeRequest: {},
        scopeSnapshot: {},
        outputProjectId: project.id,
        outputFolderPath: [],
        schedule: {},
        timezone: "UTC",
        cron: "0 * * * *",
      },
    });
    const taskRun = await db.scheduledTaskRun.create({
      data: {
        taskId: task.id,
        status: "failed",
        trigger: "manual",
        errorCode: "CONTENT_INVALID",
        errorMessage: "PRIVATE FAILURE",
        jobId,
      },
    });
    const caller = callerFor(admin);
    const imports = await caller.diagnostics.listProcessing({
      kind: "ingestion",
    });
    const assistants = await caller.diagnostics.listProcessing({
      kind: "assistant",
    });
    const tasks = await caller.diagnostics.listProcessing({
      kind: "scheduled_task",
    });
    expect(imports.items[0]).toMatchObject({
      fileId: file.id,
      projectId: project.id,
      failureCode: "provider",
      jobId,
    });
    expect(assistants.items[0]).toMatchObject({
      runId: run.id,
      failureCode: "other",
      jobId,
    });
    expect(tasks.items[0]).toMatchObject({
      runId: taskRun.id,
      projectId: project.id,
      failureCode: "CONTENT_INVALID",
      jobId,
    });
    expect(JSON.stringify([imports, assistants, tasks])).not.toMatch(
      /PRIVATE|private/,
    );
  });

  it("supports empty states for every source and queue introspection", async () => {
    const admin = await makeUser("Admin", "processing-empty");
    const caller = callerFor(admin);
    for (const kind of [
      "knowledge_generation",
      "knowledge_document",
      "keyword",
      "ingestion",
      "assistant",
      "scheduled_task",
    ] as const) {
      expect((await caller.diagnostics.listProcessing({ kind })).items).toEqual(
        [],
      );
    }
    expect((await caller.diagnostics.listProcessingQueue({})).items).toEqual(
      [],
    );
    expect((await caller.diagnostics.processingQueueSummary()).queues).toEqual(
      [],
    );
  });
});

it("correlates every file stage across deliveries and preserves other event filters", async () => {
  const admin = await makeUser("Admin", "processing-file-events");
  const fileId = randomUUID();
  const db = getPrisma();
  await db.diagnosticEvent.createMany({
    data: [
      {
        createdAt: new Date("2026-09-01T12:00:00Z"),
        runtime: "worker",
        severity: "info",
        category: "ingestion",
        event: "ingestion.parse.started",
        message: "Parse started",
        jobId: randomUUID(),
        details: { fileId },
      },
      {
        createdAt: new Date("2026-09-01T12:01:00Z"),
        runtime: "worker",
        severity: "error",
        category: "ingestion",
        event: "ingestion.analyze.failed",
        message: "Analyze failed",
        jobId: randomUUID(),
        details: { fileId },
      },
      {
        createdAt: new Date("2026-09-01T12:02:00Z"),
        runtime: "worker",
        severity: "error",
        category: "ingestion",
        event: "ingestion.analyze.failed",
        message: "Unrelated failed",
        jobId: randomUUID(),
        details: { fileId: randomUUID() },
      },
    ],
  });
  const caller = callerFor(admin);
  const first = await caller.diagnostics.listEvents({ fileId, limit: 1 });
  const second = await caller.diagnostics.listEvents({
    fileId,
    limit: 1,
    cursor: first.nextCursor!,
  });
  expect(first.items.map((row) => row.message)).toEqual(["Analyze failed"]);
  expect(second.items.map((row) => row.message)).toEqual(["Parse started"]);
  const errors = await caller.diagnostics.listEvents({
    fileId,
    severity: "error",
    text: "Analyze",
    category: "ingestion",
  });
  expect(errors.items.map((row) => row.id)).toEqual(
    first.items.map((row) => row.id),
  );
  expect(
    (
      await caller.diagnostics.listEvents({
        fileId,
        jobId: second.items[0]!.jobId!,
      })
    ).items.map((row) => row.id),
  ).toEqual(second.items.map((row) => row.id));
  await expect(
    caller.diagnostics.listEvents({ fileId: "private file name" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("keeps indexed file correlation equivalent to normal event filters", async () => {
  const admin = await makeUser("Admin", "processing-file-filter-parity");
  const fileId = randomUUID();
  const db = getPrisma();
  const correlations = {
    runId: randomUUID(),
    userId: admin.id,
    projectId: randomUUID(),
    generationId: randomUUID(),
    documentId: randomUUID(),
    connectionId: randomUUID(),
    requestId: "file-request",
    jobId: randomUUID(),
  };
  const timestamp = new Date("2026-09-01T12:01:00Z");
  const target = await db.diagnosticEvent.create({
    data: {
      createdAt: timestamp,
      runtime: "worker",
      severity: "error",
      category: "ingestion",
      event: "ingestion.analyze.failed",
      message: "Analyze failed",
      details: { fileId },
      ...correlations,
    },
  });
  await db.diagnosticEvent.createMany({
    data: [
      {
        createdAt: new Date("2026-09-01T12:00:00Z"),
        runtime: "worker",
        severity: "debug",
        category: "ingestion",
        event: "ingestion.parse.started",
        message: "Parse started",
        details: { fileId },
      },
      {
        createdAt: timestamp,
        runtime: "worker",
        severity: "info",
        category: "jobs",
        event: "job.finished",
        message: "Analyze job finished",
        details: { fileId },
      },
    ],
  });
  const caller = callerFor(admin);
  const first = await caller.diagnostics.listEvents({ limit: 1 });
  const filters: ListDiagnosticEventsInput[] = [
    {},
    { since: timestamp, until: timestamp },
    { since: new Date("2026-09-02T00:00:00Z") },
    { severity: "error" },
    { excludeDebug: true },
    { severity: "debug", excludeDebug: true },
    { reference: target.id.slice(0, 8).toUpperCase() },
    { text: "aNaLyZe" },
    { cursor: first.nextCursor!, limit: 1 },
    { category: "ingestion", event: target.event },
    { ...correlations },
    { ...correlations, projectId: randomUUID() },
  ];
  for (const filter of filters) {
    const normal = await caller.diagnostics.listEvents(filter);
    const byFile = await caller.diagnostics.listEvents({
      ...filter,
      fileId: fileId.toUpperCase(),
    });
    expect(byFile).toEqual(normal);
  }
});

it("keeps file time bounds and cursor comparisons in UTC under a non-UTC session", async () => {
  const admin = await makeUser("Admin", "processing-file-timezone");
  const actor = securityContextFor(admin);
  const fileId = randomUUID();
  const db = getPrisma();
  const rows = await Promise.all(
    [10, 12, 14].map((hour) =>
      db.diagnosticEvent.create({
        data: {
          createdAt: new Date(`2026-09-01T${hour}:00:00Z`),
          runtime: "worker",
          severity: "info",
          category: "ingestion",
          event: "ingestion.parse.started",
          message: "Stage started",
          details: { fileId },
        },
      }),
    ),
  );
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Auckland'`;
    const transactionalDb = tx as unknown as PrismaClient;
    const boundary = rows[1]!;
    const normal = await listDiagnosticEvents(transactionalDb, actor, {
      since: boundary.createdAt,
      until: boundary.createdAt,
    });
    const byFile = await listDiagnosticEvents(transactionalDb, actor, {
      fileId,
      since: boundary.createdAt,
      until: boundary.createdAt,
    });
    expect(normal.items.map((row) => row.id)).toEqual([boundary.id]);
    expect(byFile).toEqual(normal);
    const cursor = encodeDiagnosticEventCursor(boundary);
    expect(
      await listDiagnosticEvents(transactionalDb, actor, { fileId, cursor }),
    ).toEqual(await listDiagnosticEvents(transactionalDb, actor, { cursor }));
  });
});
