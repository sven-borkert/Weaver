import { mcpToolByName } from "@weaver/assistant-tools/registry";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@weaver/db/client";
import { beforeEach, describe, expect, it } from "vitest";
import { PgBossQueue } from "@weaver/core/jobs/pgBossQueue";
import type { ToolContext } from "@weaver/assistant-tools/contract";
import {
  aiUsageSummaryTool,
  listAiUsageTool,
} from "@weaver/assistant-tools/tools/admin/operations";
import { getAssistantRunTool } from "@weaver/assistant-tools/tools/admin/assistantRead";
import {
  getIngestionFileTool,
  listIngestionBatchesTool,
  listIngestionFilesTool,
} from "@weaver/assistant-tools/tools/admin/ingestionRead";
import {
  KNOWLEDGE_JOB_NAMES,
  type KnowledgeJobPayloads,
} from "@weaver/core/jobs/types";
import {
  adminHealth,
  adminOverview,
} from "@weaver/core/services/adminOverview";
import {
  getQueueJob,
  listQueueJobs,
  queueSummary,
} from "@weaver/core/services/queueInspection";
import {
  aiUsageSummary,
  listAiUsage,
} from "@weaver/core/services/aiUsageQueries";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";
import {
  listGenerationDocuments,
  listKnowledgeGenerations,
} from "@weaver/core/services/knowledgeInspection";
import {
  getIngestionFileDetail,
  listIngestionBatches,
  listIngestionFiles,
} from "@weaver/core/services/ingestionInspection";
import { createConversation } from "@weaver/core/services/assistantConversations";
import { submitUserMessage } from "@weaver/core/services/assistantRuns";
import {
  getAssistantRunDetail,
  listAssistantRuns,
} from "@weaver/core/services/assistantInspection";
import { listMcpAuditEvents } from "@weaver/core/services/mcpAuditQueries";
import { encodePageCursor } from "@weaver/core/services/adminPaging";

const runtimeConfig = {
  basePath: "",
  dataDir: "./data-test",
  poolMax: 10,
  statementTimeoutMs: 0,
  jobsEnabled: true,
  reconcileCron: "*/15 * * * *",
  assistantReconcileCron: "* * * * *",
  mcp: {
    port: 3200,
    toolTimeoutMs: 30_000,
    maxBodyBytes: 1_048_576,
    maxResourceChars: 200_000,
    rateLimitPerMinute: 600,
  },
  encryptionKeyVersions: [1],
};

describe("admin insight services", () => {
  it("keeps currencies separate and reports unpriced usage", async () => {
    const db = getPrisma();
    const actor = securityContextFor(await makeUser("Admin", "mixed-currency"));
    await db.aiUsage.createMany({
      data: [
        { currency: "USD", costMicros: 1000000n },
        { currency: "EUR", costMicros: 1000000n },
        { currency: "USD", costMicros: null },
      ].map((price) => ({
        ...price,
        operation: "assistant.run",
        provider: "openai_compatible",
        model: "same",
        configFingerprint: "f",
        durationMs: 1,
        outcome: "success" as const,
      })),
    });
    const result = await aiUsageSummary(db, actor, { groupBy: "model" });
    expect(result.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "same",
          currency: "USD",
          costMicros: 1000000,
          unpricedCalls: 1,
        }),
        expect.objectContaining({
          key: "same",
          currency: "EUR",
          costMicros: 1000000,
          unpricedCalls: 0,
        }),
      ]),
    );
    expect(result.groups).toHaveLength(2);
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("reports a bounded overview with only allowlisted runtime config", async () => {
    const admin = await makeUser("Admin", "insight-overview");
    const overview = await adminOverview(
      getPrisma(),
      securityContextFor(admin),
      { version: "0.1.32", config: runtimeConfig },
    );

    expect(overview).toMatchObject({
      version: "0.1.32",
      node: process.version,
      config: runtimeConfig,
      truncated: expect.any(Boolean),
    });
    expect(
      overview.tables.find((table) => table.name === "DiagnosticEvent"),
    ).toMatchObject({ rows: expect.any(Number), bytes: expect.any(Number) });
    expect(JSON.stringify(overview).length).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(overview)).not.toMatch(
      /secret|password|DATABASE_URL/i,
    );
  });

  it("copies the runtime allowlist and bounds oversized facts", async () => {
    const admin = await makeUser("Admin", "insight-overview-bounds");
    const unsafeConfig = {
      ...runtimeConfig,
      dataDir: `./${"d".repeat(20_000)}`,
      reconcileCron: "c".repeat(20_000),
      DATABASE_URL: "private-database-value",
      AUTH_SECRET: "private-auth-value",
    };

    const overview = await adminOverview(
      getPrisma(),
      securityContextFor(admin),
      { version: "v".repeat(20_000), config: unsafeConfig },
    );
    const serialized = JSON.stringify(overview);
    expect(serialized.length).toBeLessThanOrEqual(16_000);
    expect(overview.truncated).toBe(true);
    expect(serialized).not.toContain("private-database-value");
    expect(serialized).not.toContain("private-auth-value");
  });

  it("denies overview and health to a non-admin", async () => {
    const user = await makeUser("User", "insight-user");
    const actor = securityContextFor(user);
    await expect(
      adminOverview(getPrisma(), actor, {
        version: "x",
        config: runtimeConfig,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminHealth(getPrisma(), actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("reports bounded health from the database and pg-boss tables", async () => {
    const admin = await makeUser("Admin", "insight-health");
    const health = await adminHealth(getPrisma(), securityContextFor(admin));

    expect(health.database.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(health.queues)).toBe(true);
    expect(health.diagnostics.settings.level).toBe("standard");
    expect(health.truncated).toEqual(expect.any(Boolean));
    expect(JSON.stringify(health).length).toBeLessThanOrEqual(16_000);
  });

  it("lists queue jobs with filters, stable pagination, and safe metadata", async () => {
    const admin = await makeUser("Admin", "insight-queue");
    const actor = securityContextFor(admin);
    const queue = new PgBossQueue<KnowledgeJobPayloads>({
      connectionString: process.env.DATABASE_URL!,
      queueNames: KNOWLEDGE_JOB_NAMES,
      workerConcurrency: 1,
      mode: "publisher",
    });
    const projectId = randomUUID();
    const tableId = randomUUID();
    const sourceId = randomUUID();
    const generationId = randomUUID();
    const runId = randomUUID();
    const generationCursor = randomUUID();

    try {
      await queue.start();
      const ids = await Promise.all([
        queue.send("project.generation-build", {
          projectId,
          generationId,
          configFingerprint: "a".repeat(64),
          cursor: generationCursor,
        }),
        queue.send("content.delete", {
          projectId,
          sourceType: "table",
          sourceId,
          sourceCommitSha: "b".repeat(40),
        }),
        queue.send("table.search-sync", {
          projectId,
          tableId,
          sourceCommitSha: "c".repeat(40),
          pathAtSha: "private/table/content.md",
        }),
        queue.send("assistant.run", { runId }),
      ]);
      expect(ids.every(Boolean)).toBe(true);
      await getPrisma().$executeRaw`
        UPDATE pgboss.job
        SET created_on = TIMESTAMPTZ '2026-09-04 12:00:00.123456+00'
        WHERE id IN (${ids[0]}::uuid, ${ids[1]}::uuid, ${ids[2]}::uuid)
      `;
      await getPrisma().$executeRaw`
        UPDATE pgboss.job
        SET output = ${{
          error: "password=TEST_ONLY_QUEUE_SECRET",
          response: "private provider body",
          nested: { arbitrary: "private output" },
        }}::jsonb
        WHERE id = ${ids[0]}::uuid
      `;
      await getPrisma().$executeRaw`
        UPDATE pgboss.job
        SET output = ${{ error: '\"\n'.repeat(10_000) }}::jsonb
        WHERE id = ${ids[2]}::uuid
      `;

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listQueueJobs(getPrisma(), actor, {
          limit: 1,
          cursor,
        });
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(new Set(seen)).toEqual(new Set(ids as string[]));
      expect(seen).toHaveLength(ids.length);

      const generationPage = await listQueueJobs(getPrisma(), actor, {
        name: "project.generation-build",
        state: "created",
        since: new Date("2026-09-04T12:00:00.123Z"),
        generationId,
        limit: 10,
      });
      expect(generationPage.items).toHaveLength(1);
      const generationJob = generationPage.items[0]!;
      expect(generationJob.data).toEqual({
        projectId,
        generationId,
        configFingerprint: "a".repeat(64),
        cursor: generationCursor,
      });
      expect(JSON.stringify(generationJob)).not.toMatch(
        /TEST_ONLY_QUEUE_SECRET|private provider body|private output|password/i,
      );
      expect(generationJob.output).toEqual({ error: "[redacted]" });

      const tableJob = await getQueueJob(getPrisma(), actor, ids[2]!);
      expect(tableJob?.data).toEqual({
        projectId,
        tableId,
        sourceCommitSha: "c".repeat(40),
      });
      expect(JSON.stringify(tableJob?.output).length).toBeLessThanOrEqual(
        1_024,
      );
      expect(JSON.stringify(tableJob)).not.toContain(
        "private/table/content.md",
      );
      await expect(
        getQueueJob(getPrisma(), actor, randomUUID()),
      ).resolves.toBeNull();

      const runPage = await listQueueJobs(getPrisma(), actor, { runId });
      expect(runPage.items.map((item) => item.id)).toEqual([ids[3]]);
      const summary = await queueSummary(getPrisma(), actor);
      expect(summary.queues.some((row) => row.name === "assistant.run")).toBe(
        true,
      );
      expect(summary.queues.length).toBeLessThanOrEqual(200);
      expect(summary.schedules.length).toBeLessThanOrEqual(200);
      expect(summary).toMatchObject({ truncated: expect.any(Boolean) });
      expect(JSON.stringify(summary).length).toBeLessThanOrEqual(16_000);
    } finally {
      await queue.stop();
    }
  });

  it.each(["2026-09-04", "2026-01-04"])(
    "preserves queue instants and pagination in a Berlin session on %s",
    async (day) => {
      const actor = securityContextFor(await makeUser("Admin", "queue-utc"));
      const db = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.DATABASE_URL!,
          options: "-c timezone=Europe/Berlin",
        }),
      });
      const queue = new PgBossQueue<KnowledgeJobPayloads>({
        connectionString: process.env.DATABASE_URL!,
        queueNames: ["system.reconcile", "assistant.reconcile"],
        workerConcurrency: 1,
        mode: "publisher",
      });
      const createdOn = new Date(`${day}T10:00:00.123Z`);
      const completedOn = new Date(`${day}T10:01:00.123Z`);
      try {
        await queue.start();
        await queue.schedule("system.reconcile", "*/15 * * * *");
        const ids = [
          await queue.send("system.reconcile", {}),
          await queue.send("system.reconcile", {}),
          await queue.send("assistant.reconcile", {}),
        ];
        expect(ids.every(Boolean)).toBe(true);
        await db.$executeRaw`
          UPDATE pgboss.job
          SET state = 'completed',
              created_on = ${`${day}T10:00:00.123456Z`}::timestamptz,
              started_on = ${createdOn.toISOString()}::timestamptz,
              completed_on = ${completedOn.toISOString()}::timestamptz,
              start_after = ${createdOn.toISOString()}::timestamptz,
              keep_until = ${completedOn.toISOString()}::timestamptz
        `;
        await db.$executeRaw`
          UPDATE pgboss.version SET cron_on = ${completedOn.toISOString()}::timestamptz
        `;
        await db.$executeRaw`
          UPDATE pgboss.schedule SET updated_on = ${completedOn.toISOString()}::timestamptz
        `;
        const [session] = await db.$queryRaw<Array<{ zone: string }>>`
          SELECT current_setting('TimeZone') AS zone
        `;
        expect(session?.zone).toBe("Europe/Berlin");

        const first = await listQueueJobs(db, actor, {
          since: createdOn,
          limit: 1,
        });
        expect(first.items[0]).toMatchObject({
          createdOn,
          startedOn: createdOn,
          completedOn,
          startAfter: createdOn,
          keepUntil: completedOn,
        });
        const second = await listQueueJobs(db, actor, {
          since: createdOn,
          limit: 1,
          cursor: first.nextCursor!,
        });
        const third = await listQueueJobs(db, actor, {
          since: createdOn,
          limit: 1,
          cursor: second.nextCursor!,
        });
        expect(
          [first, second, third].flatMap((page) =>
            page.items.map((row) => row.id),
          ),
        ).toEqual([...ids].sort().reverse());
        expect(third.nextCursor).toBeNull();
        expect(
          (
            await listQueueJobs(db, actor, {
              since: new Date(`${day}T10:00:00.124Z`),
            })
          ).items,
        ).toEqual([]);
        expect(await getQueueJob(db, actor, ids[0]!)).toMatchObject({
          createdOn,
          startedOn: createdOn,
          completedOn,
          startAfter: createdOn,
          keepUntil: completedOn,
        });

        const health = await adminHealth(db, actor);
        expect(health.pgboss).toMatchObject({
          cronOn: completedOn,
          lastSystemReconcileAt: completedOn,
          lastAssistantReconcileAt: completedOn,
          workerLastSeenAt: completedOn,
          schedules: [expect.objectContaining({ updatedOn: completedOn })],
        });
        const summary = await queueSummary(db, actor);
        for (const rows of [health.queues, summary.queues]) {
          expect(rows).toHaveLength(2);
          for (const row of rows)
            expect(row.oldestCreatedOn).toEqual(createdOn);
        }
      } finally {
        await queue.stop();
        await db.$disconnect();
      }
    },
  );

  it("denies queue inspection to non-admins", async () => {
    const actor = securityContextFor(await makeUser("User", "queue-user"));
    await expect(listQueueJobs(getPrisma(), actor, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      getQueueJob(getPrisma(), actor, randomUUID()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(queueSummary(getPrisma(), actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("lists AI usage with every filter and stable tied-timestamp pagination", async () => {
    const admin = await makeUser("Admin", "insight-usage-list");
    const actor = securityContextFor(admin);
    const project = await makeProject("Usage filters");
    const connectionId = randomUUID();
    const runId = randomUUID();
    const tiedAt = new Date("2026-09-01T10:00:00.123Z");
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    await getPrisma().aiUsage.createMany({
      data: [
        {
          id: ids[0],
          projectId: project.id,
          operation: "document_graph_extraction",
          jobId: "job-filter",
          runId,
          provider: "openai_compatible",
          model: "pro",
          connectionId,
          configFingerprint: "f",
          durationMs: 1_000,
          outcome: "provider_failure",
          createdAt: tiedAt,
        },
        {
          id: ids[1],
          projectId: project.id,
          operation: "document_graph_extraction",
          jobId: "job-filter",
          runId,
          provider: "openai_compatible",
          model: "pro",
          connectionId,
          configFingerprint: "f",
          durationMs: 900,
          outcome: "provider_failure",
          createdAt: tiedAt,
        },
        {
          id: ids[2],
          operation: "other",
          provider: "ollama",
          model: "embed",
          configFingerprint: "f",
          durationMs: 800,
          outcome: "success",
          createdAt: new Date("2026-09-01T09:59:59.999Z"),
        },
      ],
    });

    const filter = {
      since: tiedAt,
      until: tiedAt,
      outcome: "provider_failure" as const,
      operation: "document_graph_extraction",
      model: "pro",
      connectionId,
      projectId: project.id,
      jobId: "job-filter",
      runId,
      limit: 1,
    };
    const first = await listAiUsage(getPrisma(), actor, filter);
    const second = await listAiUsage(getPrisma(), actor, {
      ...filter,
      cursor: first.nextCursor!,
    });
    expect(first.items.map((row) => row.id)).toEqual([ids[0]]);
    expect(second.items.map((row) => row.id)).toEqual([ids[1]]);
    expect(second.nextCursor).toBeNull();
    await expect(
      listAiUsage(getPrisma(), actor, { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      listAiUsage(getPrisma(), actor, {
        cursor: encodePageCursor([tiedAt.toISOString(), "not-a-uuid"]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("summarizes AI usage by model, operation, outcome, and UTC day without int32 overflow", async () => {
    const actor = securityContextFor(
      await makeUser("Admin", "insight-usage-summary"),
    );
    const base = new Date("2026-09-01T23:59:59.999Z");
    await getPrisma().aiUsage.createMany({
      data: [
        {
          operation: "graph",
          provider: "openai_compatible",
          model: "pro",
          configFingerprint: "f",
          inputTokens: 2_000_000_000,
          outputTokens: 1_500_000_000,
          durationMs: 1_000,
          outcome: "success",
          costMicros: 10_000_000_000_000_000n,
          createdAt: base,
        },
        {
          operation: "graph",
          provider: "openai_compatible",
          model: "pro",
          configFingerprint: "f",
          inputTokens: 2_000_000_000,
          outputTokens: 1_500_000_000,
          durationMs: 3_000,
          outcome: "provider_failure",
          costMicros: 2_000_000_000n,
          createdAt: new Date("2026-09-02T00:00:00.000Z"),
        },
        {
          operation: "embed",
          provider: "ollama",
          model: "embed",
          configFingerprint: "f",
          durationMs: 800,
          outcome: "success",
          createdAt: new Date("2026-09-03T00:00:00.000Z"),
        },
      ],
    });

    const byModel = await aiUsageSummary(getPrisma(), actor, {
      since: base,
      until: new Date("2026-09-02T23:59:59.999Z"),
      groupBy: "model",
    });
    expect(byModel.groups).toEqual([
      {
        key: "pro",
        currency: null,
        unpricedCalls: 0,
        calls: 2,
        failures: 1,
        inputTokens: 4_000_000_000,
        outputTokens: 3_000_000_000,
        costMicros: "10000002000000000",
        averageDurationMs: 2_000,
      },
    ]);
    expect(byModel.truncated).toBe(false);
    expect(
      (await aiUsageSummary(getPrisma(), actor, { groupBy: "operation" }))
        .groups,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "graph", calls: 2 }),
      ]),
    );
    expect(
      (await aiUsageSummary(getPrisma(), actor, { groupBy: "outcome" })).groups,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "success", calls: 2 }),
      ]),
    );
    expect(
      (await aiUsageSummary(getPrisma(), actor, { groupBy: "day" })).groups,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "2026-09-01", calls: 1 }),
        expect.objectContaining({ key: "2026-09-02", calls: 1 }),
      ]),
    );
  });

  it("denies AI usage inspection to non-admins", async () => {
    const actor = securityContextFor(await makeUser("User", "usage-user"));
    await expect(listAiUsage(getPrisma(), actor, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      aiUsageSummary(getPrisma(), actor, { groupBy: "model" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("exposes assistant run metadata without message text, and MCP audit rows", async () => {
    const admin = await makeUser("Admin", "insight-runs");
    const actor = securityContextFor(admin);
    const owner = await makeUser("User", "insight-runs-owner");
    const conversation = await createConversation(
      getPrisma(),
      securityContextFor(owner),
      { title: "Secret talk" },
    );
    const { run } = await submitUserMessage(
      getPrisma(),
      securityContextFor(owner),
      {
        conversationId: conversation.id,
        text: "the secret phrase",
        scope: { kind: "all" },
      },
    );
    await getPrisma().assistantRunEvent.createMany({
      data: [
        {
          runId: run.id,
          sequence: 1,
          type: "text.delta",
          payload: { text: "the secret phrase", toolName: "must-not-leak" },
        },
        {
          runId: run.id,
          sequence: 2,
          type: "tool.call",
          payload: { toolName: "safe_tool", arguments: "the secret phrase" },
        },
      ],
    });

    await getPrisma().assistantRun.update({
      where: { id: run.id },
      data: { errorCode: "PROVIDER_ERROR", errorMessage: "the secret phrase" },
    });
    await getPrisma().assistantRunAttempt.create({
      data: {
        runId: run.id,
        number: 1,
        workerId: "test",
        leaseExpiresAt: new Date(),
        failureCode: "PROVIDER_ERROR",
        failureSummary: "the secret phrase",
      },
    });

    const runs = await listAssistantRuns(getPrisma(), actor, {
      status: "queued",
      userId: owner.id,
    });
    expect(runs.items[0]).toMatchObject({
      id: run.id,
      ownerId: owner.id,
      status: "queued",
    });
    expect(JSON.stringify(runs)).not.toContain("secret phrase");

    const detail = await getAssistantRunDetail(getPrisma(), actor, run.id);
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sequence: 1,
          type: "text.delta",
          toolName: null,
        }),
        expect.objectContaining({
          sequence: 2,
          type: "tool.call",
          toolName: "safe_tool",
        }),
      ]),
    );
    expect(JSON.stringify(detail)).not.toContain("secret phrase");

    await getPrisma().assistantRunEvent.createMany({
      data: Array.from({ length: 201 }, (_, index) => ({
        runId: run.id,
        sequence: index + 3,
        type: "tool.result",
        payload: {
          toolName: `tool-${index}-${"x".repeat(100)}`,
          result: "the secret phrase",
        },
      })),
    });
    const ctx: ToolContext = {
      db: getPrisma(),
      actor,
      scope: {
        kind: "all",
        projectIds: [],
        documentId: null,
        tableId: null,
        resolvedAt: new Date().toISOString(),
        truncated: false,
      },
      profile: { name: null, email: admin.email },
      run: null,
    };
    const boundedDetail = (
      await getAssistantRunTool.execute({ runId: run.id }, ctx)
    ).output;
    expect(boundedDetail.events.length).toBeLessThanOrEqual(200);
    expect(boundedDetail.truncated).toBe(true);
    expect(JSON.stringify(boundedDetail).length).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(boundedDetail)).not.toContain("secret phrase");

    const auditIds = [randomUUID(), randomUUID()].sort().reverse();
    const tiedAt = new Date("2026-09-04T12:00:00.123Z");
    await getPrisma().mcpAuditEvent.createMany({
      data: auditIds.map((id, index) => ({
        id,
        requestId: `r${index}`,
        userId: owner.id,
        credentialId: `k${index}`,
        authenticationMethod: "apiKey",
        method: "tools/call",
        name: "list_projects",
        outcome: index === 0 ? ("ok" as const) : ("denied" as const),
        durationMs: 5,
        createdAt: tiedAt,
      })),
    });
    const first = await listMcpAuditEvents(getPrisma(), actor, {
      since: tiedAt,
      userId: owner.id,
      name: "list_projects",
      limit: 1,
    });
    const second = await listMcpAuditEvents(getPrisma(), actor, {
      since: tiedAt,
      userId: owner.id,
      name: "list_projects",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect([first.items[0]?.id, second.items[0]?.id]).toEqual(auditIds);
    expect(
      (await listMcpAuditEvents(getPrisma(), actor, { outcome: "denied" }))
        .items,
    ).toHaveLength(1);
    await expect(
      listAssistantRuns(getPrisma(), actor, { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      listMcpAuditEvents(getPrisma(), actor, { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const invalidIdCursor = encodePageCursor([
      tiedAt.toISOString(),
      "not-a-uuid",
    ]);
    await expect(
      listAssistantRuns(getPrisma(), actor, { cursor: invalidIdCursor }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      listMcpAuditEvents(getPrisma(), actor, { cursor: invalidIdCursor }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const denied = securityContextFor(
      await makeUser("User", "insight-runs-denied"),
    );
    await expect(
      listAssistantRuns(getPrisma(), denied, {}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      getAssistantRunDetail(getPrisma(), denied, run.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      listMcpAuditEvents(getPrisma(), denied, {}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("pages knowledge generations and documents within an administered project", async () => {
    const admin = await makeUser("Admin", "insight-knowledge");
    const actor = securityContextFor(admin);
    const project = await makeProject("Insight knowledge");
    await addMembership(project.id, admin.id, "Maintainer");
    const other = await makeProject("Knowledge hidden");
    const deleted = await makeProject("Knowledge deleted");
    await addMembership(deleted.id, admin.id, "Maintainer");
    await getPrisma().project.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    const createdAt = new Date("2026-09-04T12:00:00.123Z");
    const generationIds = [randomUUID(), randomUUID()].sort();
    await getPrisma().knowledgeGeneration.createMany({
      data: generationIds.map((id, index) => ({
        id,
        projectId: project.id,
        configFingerprint: `fingerprint-${index}`,
        embeddingModel: "safe-model",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: `prompt-v${index + 1}`,
        status: index === 0 ? "active" : "building",
        documentTotal: 2,
        documentFailedCount: index,
        createdAt,
      })),
    });
    const documentIds = [randomUUID(), randomUUID()].sort();
    await getPrisma().knowledgeGenerationDocument.createMany({
      data: documentIds.map((documentId, index) => ({
        generationId: generationIds[0]!,
        documentId,
        projectId: project.id,
        targetSha: "a".repeat(40),
        configFingerprint: "fingerprint-0",
        status: index === 0 ? "blocked_configuration" : "ready",
        failureKind: index === 0 ? "configuration" : null,
        failureSummary: index === 0 ? "AI configuration is unavailable" : null,
      })),
    });

    const firstGeneration = await listKnowledgeGenerations(getPrisma(), actor, {
      projectId: project.id,
      limit: 1,
    });
    const secondGeneration = await listKnowledgeGenerations(
      getPrisma(),
      actor,
      { projectId: project.id, limit: 1, cursor: firstGeneration.nextCursor! },
    );
    expect([
      firstGeneration.items[0]?.id,
      secondGeneration.items[0]?.id,
    ]).toEqual(generationIds);
    expect(firstGeneration).toMatchObject({ truncated: true });
    expect(secondGeneration.nextCursor).toBeNull();
    await expect(
      listKnowledgeGenerations(getPrisma(), actor, {
        projectId: project.id,
        cursor: encodePageCursor([createdAt.toISOString(), "not-a-uuid"]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const firstDocument = await listGenerationDocuments(getPrisma(), actor, {
      projectId: project.id,
      generationId: generationIds[0]!,
      limit: 1,
    });
    const secondDocument = await listGenerationDocuments(getPrisma(), actor, {
      projectId: project.id,
      generationId: generationIds[0]!,
      limit: 1,
      cursor: firstDocument.nextCursor!,
    });
    expect([
      firstDocument.items[0]?.documentId,
      secondDocument.items[0]?.documentId,
    ]).toEqual(documentIds);
    expect(firstDocument.items[0]).toMatchObject({
      status: "blocked_configuration",
      failureKind: "configuration",
    });
    await expect(
      listGenerationDocuments(getPrisma(), actor, {
        projectId: project.id,
        generationId: generationIds[0]!,
        cursor: encodePageCursor(["not-a-uuid"]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      listKnowledgeGenerations(getPrisma(), actor, { projectId: other.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listKnowledgeGenerations(getPrisma(), actor, { projectId: deleted.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listGenerationDocuments(getPrisma(), actor, {
        projectId: other.id,
        generationId: generationIds[0]!,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const viewer = await makeUser("Admin", "insight-knowledge-viewer");
    await addMembership(project.id, viewer.id, "Viewer");
    await expect(
      listKnowledgeGenerations(getPrisma(), securityContextFor(viewer), {
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const nonAdmin = await makeUser("User", "insight-knowledge-user");
    await addMembership(project.id, nonAdmin.id, "Maintainer");
    await expect(
      listKnowledgeGenerations(getPrisma(), securityContextFor(nonAdmin), {
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bounds AI usage tool output and reports every dropped row or group", async () => {
    const admin = await makeUser("Admin", "usage-bounds");
    const actor = securityContextFor(admin);
    await getPrisma().aiUsage.createMany({
      data: Array.from({ length: 201 }, (_, index) => ({
        operation: `operation-${index.toString().padStart(3, "0")}-${"x".repeat(100)}`,
        provider: "openai_compatible",
        model: `model-${index}-${"m".repeat(100)}`,
        configFingerprint: "f",
        durationMs: index,
        outcome: "success" as const,
        createdAt: new Date(1_780_000_000_000 + index),
      })),
    });
    const ctx: ToolContext = {
      db: getPrisma(),
      actor,
      scope: {
        kind: "all",
        projectIds: [],
        documentId: null,
        tableId: null,
        resolvedAt: new Date().toISOString(),
        truncated: false,
      },
      profile: { name: null, email: admin.email },
      run: null,
    };

    const unboundedPage = await listAiUsage(getPrisma(), actor, { limit: 200 });
    const listOutput = (await listAiUsageTool.execute({ limit: 200 }, ctx))
      .output;
    expect(JSON.stringify(listOutput).length).toBeLessThanOrEqual(16_000);
    expect(listOutput.truncated).toBe(true);
    expect(listOutput.nextCursor).not.toBeNull();
    const following = await listAiUsage(getPrisma(), actor, {
      cursor: listOutput.nextCursor!,
      limit: 200,
    });
    expect(following.items[0]?.id).toBe(
      unboundedPage.items[listOutput.items.length]?.id,
    );

    const summaryOutput = (
      await aiUsageSummaryTool.execute({ groupBy: "operation" }, ctx)
    ).output;
    expect(JSON.stringify(summaryOutput).length).toBeLessThanOrEqual(16_000);
    expect(summaryOutput.groups.length).toBeLessThan(200);
    expect(summaryOutput.truncated).toBe(true);
  });

  async function makeIngestionFixture(adminId: string, projectId: string) {
    const db = getPrisma();
    const batchId = randomUUID();
    const createdAt = new Date("2026-09-06T12:00:00.000Z");
    await db.ingestionBatch.create({
      data: {
        id: batchId,
        projectId,
        createdById: adminId,
        origin: "upload",
        label: "Debug batch",
        createdAt,
      },
    });
    const [failedId, pendingId, readyId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ].sort() as [string, string, string];
    await db.ingestionFile.createMany({
      data: [
        {
          id: readyId,
          batchId,
          projectId,
          fileName: "notes.md",
          mimeType: "text/markdown",
          byteSize: 17_007,
          contentDigest: "a".repeat(64),
          status: "ready",
          createdAt,
        },
        {
          id: failedId,
          batchId,
          projectId,
          fileName: "scan.pdf",
          mimeType: "application/pdf",
          byteSize: 10,
          contentDigest: "b".repeat(64),
          status: "failed",
          failureKind: "parser",
          failureMessage: "no parser for application/pdf yet",
          parserAdapterId: "passthrough",
          parserVersion: "1",
          attemptCount: 1,
          createdAt,
        },
        {
          id: pendingId,
          batchId,
          projectId,
          fileName: "data.csv",
          mimeType: "text/csv",
          byteSize: 5,
          contentDigest: "c".repeat(64),
          status: "pending",
          createdAt,
        },
      ],
    });
    await db.ingestionDraft.create({
      data: {
        fileId: readyId,
        targetKind: "document",
        proposedTitle: "Notes",
        markdown: `# Notes\n${"x".repeat(17_000)}`,
        warnings: ["csv fallback"],
      },
    });
    return { batchId, readyId, failedId, pendingId, createdAt };
  }

  it("pages ingestion batches and files and reads drafts for admins", async () => {
    const admin = await makeUser("Admin", "insight-ingestion");
    const actor = securityContextFor(admin);
    const project = await makeProject("Insight ingestion");
    await addMembership(project.id, admin.id, "Maintainer");
    const other = await makeProject("Ingestion hidden");
    const deleted = await makeProject("Ingestion deleted");
    await addMembership(deleted.id, admin.id, "Maintainer");
    await getPrisma().project.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    const fx = await makeIngestionFixture(admin.id, project.id);
    const otherBatchId = randomUUID();
    const otherFileId = randomUUID();
    await getPrisma().ingestionBatch.create({
      data: {
        id: otherBatchId,
        projectId: other.id,
        createdById: admin.id,
        origin: "upload",
      },
    });
    await getPrisma().ingestionFile.create({
      data: {
        id: otherFileId,
        batchId: otherBatchId,
        projectId: other.id,
        fileName: "other.md",
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest: "d".repeat(64),
        status: "ready",
      },
    });

    const batches = await listIngestionBatches(getPrisma(), actor, {
      projectId: project.id,
    });
    expect(batches.items).toHaveLength(1);
    expect(batches.items[0]).toMatchObject({
      id: fx.batchId,
      label: "Debug batch",
      origin: "upload",
      status: "attention",
      fileStatusCounts: { ready: 1, failed: 1, pending: 1 },
    });
    expect(batches.nextCursor).toBeNull();

    const allFiles = await listIngestionFiles(getPrisma(), actor, {
      projectId: project.id,
    });
    expect(allFiles.items.map((file) => file.id)).toEqual([
      fx.failedId,
      fx.pendingId,
      fx.readyId,
    ]);
    expect(allFiles.items[0]).toMatchObject({
      status: "failed",
      failureKind: "parser",
      failureMessage: "no parser for application/pdf yet",
      hasDraft: false,
    });
    expect(allFiles.items[2]).toMatchObject({
      status: "ready",
      hasDraft: true,
    });

    const readyOnly = await listIngestionFiles(getPrisma(), actor, {
      projectId: project.id,
      status: "ready",
    });
    expect(readyOnly.items.map((file) => file.id)).toEqual([fx.readyId]);

    const firstPage = await listIngestionFiles(getPrisma(), actor, {
      projectId: project.id,
      limit: 1,
    });
    const secondPage = await listIngestionFiles(getPrisma(), actor, {
      projectId: project.id,
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect([firstPage.items[0]?.id, secondPage.items[0]?.id]).toEqual([
      fx.failedId,
      fx.pendingId,
    ]);
    expect(firstPage.truncated).toBe(true);
    expect(secondPage.nextCursor).not.toBeNull();

    const secondBatchId = randomUUID();
    await getPrisma().ingestionBatch.create({
      data: {
        id: secondBatchId,
        projectId: project.id,
        createdById: admin.id,
        origin: "upload",
      },
    });
    await getPrisma().ingestionFile.create({
      data: {
        id: randomUUID(),
        batchId: secondBatchId,
        projectId: project.id,
        fileName: "extra.md",
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest: "e".repeat(64),
        status: "pending",
      },
    });
    const batchFiltered = await listIngestionFiles(getPrisma(), actor, {
      projectId: project.id,
      batchId: fx.batchId,
    });
    expect(batchFiltered.items.map((file) => file.id)).toEqual([
      fx.failedId,
      fx.pendingId,
      fx.readyId,
    ]);

    const detail = await getIngestionFileDetail(getPrisma(), actor, {
      projectId: project.id,
      fileId: fx.readyId,
    });
    expect(detail.draft).toMatchObject({
      targetKind: "document",
      proposedTitle: "Notes",
      proposedFolderPath: "",
      warnings: ["csv fallback"],
    });
    expect(detail.draft?.markdown?.length).toBeGreaterThan(16_000);
    const failedDetail = await getIngestionFileDetail(getPrisma(), actor, {
      projectId: project.id,
      fileId: fx.failedId,
    });
    expect(failedDetail.draft).toBeNull();

    await expect(
      listIngestionBatches(getPrisma(), actor, { projectId: other.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listIngestionFiles(getPrisma(), actor, { projectId: deleted.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getIngestionFileDetail(getPrisma(), actor, {
        projectId: project.id,
        fileId: otherFileId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listIngestionFiles(getPrisma(), actor, {
        projectId: project.id,
        batchId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listIngestionBatches(getPrisma(), actor, {
        projectId: project.id,
        cursor: encodePageCursor([fx.createdAt.toISOString(), "not-a-uuid"]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const viewer = await makeUser("Admin", "insight-ingestion-viewer");
    await addMembership(project.id, viewer.id, "Viewer");
    await expect(
      listIngestionBatches(getPrisma(), securityContextFor(viewer), {
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const nonAdmin = await makeUser("User", "insight-ingestion-user");
    await addMembership(project.id, nonAdmin.id, "Maintainer");
    await expect(
      listIngestionFiles(getPrisma(), securityContextFor(nonAdmin), {
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bounds ingestion tool output and enforces the MCP scope snapshot", async () => {
    const admin = await makeUser("Admin", "insight-ingestion-tools");
    const actor = securityContextFor(admin);
    const project = await makeProject("Ingestion tools");
    await addMembership(project.id, admin.id, "Maintainer");
    const outside = await makeProject("Ingestion outside");
    const fx = await makeIngestionFixture(admin.id, project.id);
    const ctx: ToolContext = {
      db: getPrisma(),
      actor,
      scope: {
        kind: "all",
        projectIds: [project.id],
        documentId: null,
        tableId: null,
        resolvedAt: new Date().toISOString(),
        truncated: false,
      },
      profile: { name: null, email: admin.email },
      run: null,
    };

    const batchList = (
      await listIngestionBatchesTool.execute({ projectId: project.id }, ctx)
    ).output;
    expect(batchList.items[0]).toMatchObject({
      id: fx.batchId,
      status: "attention",
      createdAt: fx.createdAt.toISOString(),
    });

    const fileList = (
      await listIngestionFilesTool.execute(
        { projectId: project.id, status: "ready" },
        ctx,
      )
    ).output;
    expect(fileList.items.map((item) => item.id)).toEqual([fx.readyId]);
    expect(fileList.items[0]?.createdAt).toBe(fx.createdAt.toISOString());

    await getPrisma().ingestionDraft.update({
      where: { fileId: fx.readyId },
      data: {
        warnings: Array.from(
          { length: 100 },
          (_, index) => `w${index}:${"y".repeat(490)}`,
        ),
      },
    });

    const detail = (
      await getIngestionFileTool.execute(
        { projectId: project.id, fileId: fx.readyId },
        ctx,
      )
    ).output;
    expect(JSON.stringify(detail).length).toBeLessThanOrEqual(16_000);
    expect(detail.markdownTruncated).toBe(true);
    expect(detail.warningsTruncated).toBe(true);
    expect(detail.draft?.markdown?.length).toBeLessThanOrEqual(16_000);
    expect(detail.draft?.proposedTitle).toBe("Notes");

    const failedDetail = (
      await getIngestionFileTool.execute(
        { projectId: project.id, fileId: fx.failedId },
        ctx,
      )
    ).output;
    expect(failedDetail).toMatchObject({
      failureKind: "parser",
      draft: null,
      markdownTruncated: false,
      warningsTruncated: false,
    });

    await expect(
      listIngestionBatchesTool.execute({ projectId: outside.id }, ctx),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "SCOPE_VIOLATION" },
    });
    await expect(
      getIngestionFileTool.execute(
        { projectId: outside.id, fileId: fx.readyId },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("scheduled task inspection", () => {
  beforeEach(resetDb);

  async function fixture() {
    const db = getPrisma();
    const admin = await makeUser("Admin", "task-inspector");
    const project = await makeProject("Task diagnostics");
    await addMembership(project.id, admin.id, "Maintainer");
    const scope = {
      kind: "project" as const,
      projectIds: [project.id],
      documentId: null,
      tableId: null,
      resolvedAt: new Date().toISOString(),
      truncated: false,
    };
    const task = await db.scheduledTask.create({
      data: {
        ownerId: admin.id,
        name: "First task",
        instruction: "List everything",
        scopeRequest: { kind: "project", projectId: project.id },
        scopeSnapshot: scope,
        outputProjectId: project.id,
        outputFolderPath: [],
        schedule: { kind: "daily", hour: 9, minute: 0 },
        timezone: "Europe/Berlin",
        cron: "0 9 * * *",
        nextRunAt: new Date("2026-09-09T07:00:00Z"),
      },
    });
    const run = await db.scheduledTaskRun.create({
      data: {
        taskId: task.id,
        status: "failed",
        trigger: "manual",
        errorCode: "TIMEOUT",
        errorMessage: "Provider timed out",
        jobId: randomUUID(),
        workerId: "worker-1",
        inputTokens: 42,
        durationMs: 1000,
        projectHeads: { [project.id]: "a".repeat(40) },
        contextSummary: { projects: [{ projectId: project.id, documents: 3 }] },
      },
    });
    const ctx: ToolContext = {
      db,
      actor: securityContextFor(admin),
      scope,
      profile: { name: null, email: "inspector@example.test" },
      run: null,
    };
    return { db, admin, project, task, run, ctx };
  }

  async function call(name: string, input: unknown, ctx: ToolContext) {
    const tool = mcpToolByName(name);
    expect(tool, name).toBeDefined();
    return (await tool!.execute(tool!.inputSchema.parse(input), ctx))
      .output as Record<string, unknown>;
  }

  it("reads definitions and complete run diagnostics and filters task history", async () => {
    const { task, run, project, ctx } = await fixture();
    const args = { projectId: project.id, taskId: task.id };
    expect(
      await call(
        "list_scheduled_tasks",
        { projectId: project.id, order: "oldest" },
        ctx,
      ),
    ).toMatchObject({
      items: [{ id: task.id, name: task.name, createdAt: task.createdAt }],
    });
    expect(await call("get_scheduled_task", args, ctx)).toMatchObject({
      record: {
        instruction: task.instruction,
        cron: task.cron,
        timezone: task.timezone,
        nextRunAt: task.nextRunAt,
        scopeSnapshot: task.scopeSnapshot,
      },
      truncated: false,
    });
    expect(
      await call(
        "list_scheduled_task_runs",
        { ...args, status: "failed" },
        ctx,
      ),
    ).toMatchObject({ items: [{ id: run.id, errorCode: "TIMEOUT" }] });
    expect(
      await call(
        "get_scheduled_task_run",
        { projectId: project.id, runId: run.id },
        ctx,
      ),
    ).toMatchObject({
      record: {
        id: run.id,
        taskId: task.id,
        jobId: run.jobId,
        workerId: "worker-1",
        errorMessage: "Provider timed out",
        inputTokens: 42,
        projectHeads: run.projectHeads,
        contextSummary: run.contextSummary,
      },
    });
    expect(
      await call(
        "list_scheduled_task_runs",
        { ...args, status: "succeeded" },
        ctx,
      ),
    ).toMatchObject({ items: [] });
    expect(
      await call(
        "list_scheduled_tasks",
        { projectId: project.id, ownerId: randomUUID() },
        ctx,
      ),
    ).toMatchObject({ items: [] });
  });

  it("requires admin, Maintainer membership, credential scope, and access to source projects", async () => {
    const { db, admin, project, task, run, ctx } = await fixture();
    const cases = [
      ["list_scheduled_tasks", { projectId: project.id }],
      ["get_scheduled_task", { projectId: project.id, taskId: task.id }],
      ["list_scheduled_task_runs", { projectId: project.id, taskId: task.id }],
      ["get_scheduled_task_run", { projectId: project.id, runId: run.id }],
    ] as const;
    const user = await makeUser("User", "not-admin");
    await addMembership(project.id, user.id, "Owner");
    const outsider = await makeUser("Admin", "outside-task-project");
    for (const [name, args] of cases) {
      await expect(
        call(name, args, { ...ctx, actor: securityContextFor(user) }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        call(name, args, { ...ctx, actor: securityContextFor(outsider) }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        call(name, args, { ...ctx, scope: { ...ctx.scope, projectIds: [] } }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const source = await makeProject("Private source");
    await db.scheduledTask.update({
      where: { id: task.id },
      data: {
        scopeSnapshot: { ...ctx.scope, projectIds: [source.id] },
      },
    });
    await expect(
      call("get_scheduled_task", cases[1][1], ctx),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await addMembership(source.id, admin.id, "Viewer");
    await expect(
      call("get_scheduled_task", cases[1][1], ctx),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call("get_scheduled_task", cases[1][1], {
        ...ctx,
        scope: { ...ctx.scope, projectIds: [project.id, source.id] },
      }),
    ).resolves.toMatchObject({ record: { id: task.id } });
    await db.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      call("get_scheduled_task", cases[1][1], ctx),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("pages tied timestamps in either creation order and rejects malformed cursors", async () => {
    const { db, task, project, ctx } = await fixture();
    const { id: _id, ...data } = task;
    const second = await db.scheduledTask.create({
      data: {
        ...data,
        name: "Second",
        scopeRequest: { kind: "project", projectId: project.id },
        scopeSnapshot: ctx.scope,
        schedule: { kind: "daily", hour: 9, minute: 0 },
      },
    });
    for (const order of ["oldest", "newest"]) {
      const first = await call(
        "list_scheduled_tasks",
        { projectId: project.id, order, limit: 1 },
        ctx,
      );
      const next = await call(
        "list_scheduled_tasks",
        { projectId: project.id, order, limit: 1, cursor: first.nextCursor },
        ctx,
      );
      const ids = [
        ...(first.items as { id: string }[]),
        ...(next.items as { id: string }[]),
      ].map((x) => x.id);
      expect(new Set(ids)).toEqual(new Set([task.id, second.id]));
      expect(next.nextCursor).toBeNull();
    }
    await expect(
      call(
        "list_scheduled_tasks",
        { projectId: project.id, cursor: "invalid" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("recovers every character of oversized escaped Unicode definitions", async () => {
    const { db, project, task, ctx } = await fixture();
    const instruction = '\"\\\n😀'.repeat(6000);
    await db.scheduledTask.update({
      where: { id: task.id },
      data: { instruction },
    });
    let offset = 0;
    let expectedRevision: string | undefined;
    let json = "";
    do {
      const page = await call(
        "get_scheduled_task",
        { projectId: project.id, taskId: task.id, offset, expectedRevision },
        ctx,
      );
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(16000);
      expect(page.record).toBeNull();
      json += page.json as string;
      expectedRevision = page.revision as string;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset as number;
    } while (offset < 200000);
    expect((JSON.parse(json) as { instruction: string }).instruction).toBe(
      instruction,
    );
  });
  it("checks historical run projects even after task scope changes", async () => {
    const { db, project, run, ctx, admin } = await fixture();
    const oldSource = await makeProject("Historical private source");
    await db.scheduledTaskRun.update({
      where: { id: run.id },
      data: {
        projectHeads: { [oldSource.id]: "b".repeat(40) },
      },
    });
    const args = { projectId: project.id, runId: run.id };
    await expect(
      call("get_scheduled_task_run", args, ctx),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await addMembership(oldSource.id, admin.id, "Viewer");
    await expect(
      call("get_scheduled_task_run", args, ctx),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call("get_scheduled_task_run", args, {
        ...ctx,
        scope: { ...ctx.scope, projectIds: [project.id, oldSource.id] },
      }),
    ).resolves.toMatchObject({
      record: { projectHeads: { [oldSource.id]: "b".repeat(40) } },
    });
  });

  it("pages run history without duplicates and applies inclusive queued-time bounds", async () => {
    const { db, project, task, run, ctx } = await fixture();
    const second = await db.scheduledTaskRun.create({
      data: {
        taskId: task.id,
        status: "succeeded",
        trigger: "manual",
        queuedAt: run.queuedAt,
      },
    });
    const args = {
      projectId: project.id,
      taskId: task.id,
      limit: 1,
      since: run.queuedAt.toISOString(),
      until: run.queuedAt.toISOString(),
    };
    const first = await call("list_scheduled_task_runs", args, ctx);
    const next = await call(
      "list_scheduled_task_runs",
      { ...args, cursor: first.nextCursor },
      ctx,
    );
    expect(
      new Set(
        [
          ...(first.items as { id: string }[]),
          ...(next.items as { id: string }[]),
        ].map((x) => x.id),
      ),
    ).toEqual(new Set([run.id, second.id]));
    expect(next.nextCursor).toBeNull();
    expect(
      await call(
        "list_scheduled_task_runs",
        {
          ...args,
          until: undefined,
          since: new Date(run.queuedAt.getTime() + 1).toISOString(),
        },
        ctx,
      ),
    ).toMatchObject({ items: [] });
    await expect(
      call(
        "list_scheduled_task_runs",
        { ...args, since: new Date(run.queuedAt.getTime() + 1).toISOString() },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(
        "get_scheduled_task_run",
        { projectId: project.id, runId: randomUUID() },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const viewer = await makeUser("Admin", "task-viewer");
    await addMembership(project.id, viewer.id, "Viewer");
    await expect(
      call("list_scheduled_task_runs", args, {
        ...ctx,
        actor: securityContextFor(viewer),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bounds list envelopes and resumes at the last emitted task", async () => {
    const { db, project, task, ctx } = await fixture();
    const { id: _id, ...data } = task;
    await db.scheduledTask.createMany({
      data: Array.from({ length: 35 }, () => ({
        ...data,
        scopeRequest: { kind: "project", projectId: project.id },
        scopeSnapshot: ctx.scope,
        schedule: { kind: "daily", hour: 9, minute: 0 },
        name: '"'.repeat(120),
      })),
    });
    const first = await call(
      "list_scheduled_tasks",
      { projectId: project.id, limit: 200 },
      ctx,
    );
    expect(first.truncated).toBe(true);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(16000);
    const second = await call(
      "list_scheduled_tasks",
      { projectId: project.id, limit: 200, cursor: first.nextCursor },
      ctx,
    );
    const ids = [
      ...(first.items as { id: string }[]),
      ...(second.items as { id: string }[]),
    ].map((x) => x.id);
    expect(ids).toHaveLength(36);
    expect(new Set(ids).size).toBe(36);
    expect(second.nextCursor).toBeNull();
  });
  it("rejects detail continuation when a task or run changes between pages", async () => {
    const { db, project, task, run, ctx } = await fixture();
    for (const [name, ids, mutate] of [
      [
        "get_scheduled_task",
        { taskId: task.id },
        () =>
          db.scheduledTask.update({
            where: { id: task.id },
            data: { instruction: "same-length edit" },
          }),
      ],
      [
        "get_scheduled_task_run",
        { runId: run.id },
        () =>
          db.scheduledTaskRun.update({
            where: { id: run.id },
            data: { workerId: "worker-2" },
          }),
      ],
    ] as const) {
      const args = { projectId: project.id, ...ids, maxChars: 100 };
      const first = await call(name, args, ctx);
      await mutate();
      await expect(
        call(
          name,
          {
            ...args,
            offset: first.nextOffset,
            expectedRevision: first.revision,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });
});
