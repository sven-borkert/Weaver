import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { reconcileProjectKnowledge } from "@weaver/core/services/knowledgeReconciliation";
import {
  invalidateLlmRouteCache,
  resolveKnowledgeRouting,
  type KnowledgeRouting,
} from "@weaver/core/services/llmRoutes";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  seedTestLlmRouting,
} from "./_harness";

let routing: KnowledgeRouting;

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  await resetDb();
  routing = (await seedTestLlmRouting()).routing;
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

describe("knowledge index operations", () => {
  it("supersedes earlier rebuilds while keeping the active generation available", async () => {
    const maintainer = await makeUser("User", "latest-rebuild");
    const project = await makeProject("Latest rebuild");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const active = await createGeneration(project.id, "active");
    setJobQueueForTests(new FakeJobQueue());
    const caller = callerFor(maintainer);
    const first = await caller.knowledge.rebuild({ projectId: project.id });
    const second = await caller.knowledge.rebuild({ projectId: project.id });
    expect(first.generationId).not.toBe(second.generationId);
    expect(
      await getPrisma().knowledgeGeneration.findUnique({
        where: { id: first.generationId },
      }),
    ).toMatchObject({ status: "superseded", supersededAt: expect.any(Date) });
    expect(
      await getPrisma().knowledgeGeneration.findUnique({
        where: { id: active.id },
      }),
    ).toMatchObject({ status: "active" });
    expect(
      await getPrisma().knowledgeGeneration.count({
        where: { projectId: project.id, status: "building" },
      }),
    ).toBe(1);
  });

  it("rejects an AI rebuild before creating a generation when routing is absent", async () => {
    const maintainer = await makeUser("User", "unconfigured-rebuild");
    const project = await makeProject("Unconfigured rebuild");
    await addMembership(project.id, maintainer.id, "Maintainer");
    await getPrisma().llmRoute.deleteMany({});
    invalidateLlmRouteCache();
    await expect(
      callerFor(maintainer).knowledge.rebuild({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await getPrisma().knowledgeGeneration.count({
        where: { projectId: project.id },
      }),
    ).toBe(0);
  });

  it("returns only bounded layer readiness to a Viewer", async () => {
    await getPrisma().llmRoute.deleteMany({});
    invalidateLlmRouteCache();
    const viewer = await makeUser("User", "knowledge-readiness");
    const project = await makeProject("Knowledge readiness");
    await addMembership(project.id, viewer.id, "Viewer");
    const [readyDocument, failedDocument] = await createDocuments(
      project.id,
      2,
      "readiness",
    );
    const db = getPrisma();
    await db.documentIndexState.createMany({
      data: [
        {
          documentId: readyDocument!.id,
          projectId: project.id,
          targetSha: readyDocument!.headCommitSha,
          keywordIndexedSha: readyDocument!.headCommitSha,
          status: "ready",
        },
        {
          documentId: failedDocument!.id,
          projectId: project.id,
          targetSha: failedDocument!.headCommitSha,
          status: "failed",
          failureKind: "internal",
          failureSummary: "Keyword projection failed",
        },
      ],
    });
    const generation = await createGeneration(project.id, "active", {
      documentTotal: 2,
      documentReadyCount: 1,
      documentFailedCount: 1,
    });
    await db.knowledgeGenerationDocument.createMany({
      data: [
        {
          generationId: generation.id,
          documentId: readyDocument!.id,
          projectId: project.id,
          targetSha: readyDocument!.headCommitSha,
          semanticIndexedSha: readyDocument!.headCommitSha,
          graphIndexedSha: readyDocument!.headCommitSha,
          configFingerprint: generation.configFingerprint,
          status: "ready",
        },
        {
          generationId: generation.id,
          documentId: failedDocument!.id,
          projectId: project.id,
          targetSha: failedDocument!.headCommitSha,
          configFingerprint: generation.configFingerprint,
          status: "failed",
          failureKind: "provider",
          failureSummary: "Provider unavailable",
        },
      ],
    });

    const readiness = await callerFor(viewer).knowledge.readiness({
      projectId: project.id,
    });

    expect(readiness).toEqual({
      keyword: "degraded",
      semantic: "degraded",
      graph: "degraded",
      aiConfigured: false,
    });
    expect(Object.keys(readiness).sort()).toEqual([
      "aiConfigured",
      "graph",
      "keyword",
      "semantic",
    ]);
  });

  it("keeps semantic ready when only the graph extraction of a document failed", async () => {
    const viewer = await makeUser("User", "knowledge-layer-readiness");
    const project = await makeProject("Knowledge layer readiness");
    await addMembership(project.id, viewer.id, "Viewer");
    const [readyDocument, embeddedDocument] = await createDocuments(
      project.id,
      2,
      "layer-readiness",
    );
    const db = getPrisma();
    await db.documentIndexState.createMany({
      data: [readyDocument!, embeddedDocument!].map((document) => ({
        documentId: document.id,
        projectId: project.id,
        targetSha: document.headCommitSha,
        keywordIndexedSha: document.headCommitSha,
        status: "ready",
      })),
    });
    const generation = await createGeneration(project.id, "active", {
      documentTotal: 2,
      documentReadyCount: 1,
      documentFailedCount: 1,
    });
    await db.knowledgeGenerationDocument.createMany({
      data: [
        {
          generationId: generation.id,
          documentId: readyDocument!.id,
          projectId: project.id,
          targetSha: readyDocument!.headCommitSha,
          semanticIndexedSha: readyDocument!.headCommitSha,
          graphIndexedSha: readyDocument!.headCommitSha,
          configFingerprint: generation.configFingerprint,
          status: "ready",
        },
        {
          generationId: generation.id,
          documentId: embeddedDocument!.id,
          projectId: project.id,
          targetSha: embeddedDocument!.headCommitSha,
          semanticIndexedSha: embeddedDocument!.headCommitSha,
          configFingerprint: generation.configFingerprint,
          status: "failed",
          failureKind: "validation",
          failureSummary: "AI provider returned invalid extraction",
        },
      ],
    });

    const readiness = await callerFor(viewer).knowledge.readiness({
      projectId: project.id,
    });

    expect(readiness).toEqual({
      keyword: "ready",
      semantic: "ready",
      graph: "degraded",
      aiConfigured: true,
    });
  });

  it("reports building instead of degraded while a rebuild covers blocked documents", async () => {
    const db = getPrisma();
    const viewer = await makeUser("User", "covered-readiness");
    const project = await makeProject("Covered readiness");
    await addMembership(project.id, viewer.id, "Viewer");
    const sha = "c".repeat(40);
    const now = new Date();
    const document = await db.document.create({
      data: {
        id: randomUUID(),
        projectId: project.id,
        path: "covered.md",
        slug: "covered",
        title: "Covered",
        excerpt: "",
        headCommitSha: sha,
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.documentIndexState.create({
      data: {
        documentId: document.id,
        projectId: project.id,
        targetSha: sha,
        keywordIndexedSha: sha,
        status: "ready",
      },
    });
    const active = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "old-space",
        embeddingModel: "old",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v2",
        status: "active",
      },
    });
    await db.knowledgeGenerationDocument.create({
      data: {
        generationId: active.id,
        documentId: document.id,
        projectId: project.id,
        targetSha: sha,
        configFingerprint: "old-space",
        status: "blocked_configuration",
      },
    });
    const readiness = () =>
      callerFor(viewer).knowledge.readiness({ projectId: project.id });

    await expect(readiness()).resolves.toMatchObject({ semantic: "degraded" });
    await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "new-space",
        embeddingModel: "new",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v2",
        status: "building",
      },
    });
    await expect(readiness()).resolves.toMatchObject({
      semantic: "building",
      graph: "building",
    });
  });

  it("reports a terminal failed generation as degraded without failure details", async () => {
    const viewer = await makeUser("User", "knowledge-failed-readiness");
    const project = await makeProject("Knowledge failed readiness");
    await addMembership(project.id, viewer.id, "Viewer");
    await createDocuments(project.id, 1, "failed-readiness");
    const generation = await createGeneration(project.id, "failed");
    await getPrisma().knowledgeGeneration.update({
      where: { id: generation.id },
      data: {
        failureKind: "provider",
        failureSummary: "SECRET provider credential failed",
        completedAt: new Date("2026-08-29T11:00:00.000Z"),
      },
    });

    const readiness = await callerFor(viewer).knowledge.readiness({
      projectId: project.id,
    });

    expect(readiness).toEqual({
      keyword: "building",
      semantic: "degraded",
      graph: "degraded",
      aiConfigured: true,
    });
    expect(JSON.stringify(readiness)).not.toContain("SECRET");
  });

  it("enforces Viewer and Maintainer boundaries without leaking project existence", async () => {
    const viewer = await makeUser("User", "knowledge-role-viewer");
    const editor = await makeUser("User", "knowledge-role-editor");
    const maintainer = await makeUser("User", "knowledge-role-maintainer");
    const outsider = await makeUser("User", "knowledge-role-outsider");
    const admin = await makeUser("Admin", "knowledge-role-admin");
    const project = await makeProject("Knowledge roles");
    await addMembership(project.id, viewer.id, "Viewer");
    await addMembership(project.id, editor.id, "Editor");
    await addMembership(project.id, maintainer.id, "Maintainer");
    await addMembership(project.id, admin.id, "Maintainer");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);

    await expect(
      callerFor(viewer).knowledge.readiness({ projectId: project.id }),
    ).resolves.toEqual({
      keyword: "empty",
      semantic: "empty",
      graph: "empty",
      aiConfigured: true,
    });
    await expect(
      callerFor(viewer).knowledge.status({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(viewer).knowledge.retryFailed({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(editor).knowledge.rebuild({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(outsider).knowledge.readiness({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(outsider).knowledge.status({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(outsider).knowledge.rebuild({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      callerFor(maintainer).knowledge.status({ projectId: project.id }),
    ).resolves.toMatchObject({ liveDocuments: 0 });
    await expect(
      callerFor(admin).knowledge.status({ projectId: project.id }),
    ).resolves.toMatchObject({ liveDocuments: 0 });
    await expect(
      callerFor(admin).knowledge.retryFailed({ projectId: project.id }),
    ).resolves.toEqual({ retried: 0, hasMore: false, nextCursor: null });
    const adminRebuild = await callerFor(admin).knowledge.rebuild({
      projectId: project.id,
    });
    expect(adminRebuild.generationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns generation counters and at most 50 safe failures", async () => {
    const maintainer = await makeUser("User", "knowledge-safe-status");
    const project = await makeProject("Knowledge safe status");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const [document] = await createDocuments(project.id, 1, "safe-status");
    const db = getPrisma();
    const activeCompletedAt = new Date("2026-08-29T10:00:00.000Z");
    const failureCompletedAt = new Date("2026-08-29T11:00:00.000Z");
    await db.documentIndexState.create({
      data: {
        documentId: document!.id,
        projectId: project.id,
        targetSha: document!.headCommitSha,
        keywordIndexedSha: document!.headCommitSha,
        status: "ready",
        completedAt: activeCompletedAt,
      },
    });
    const active = await createGeneration(project.id, "active", {
      documentTotal: 1,
      documentReadyCount: 1,
      completedAt: activeCompletedAt,
      activatedAt: activeCompletedAt,
    });
    await db.knowledgeGenerationDocument.create({
      data: {
        generationId: active.id,
        documentId: document!.id,
        projectId: project.id,
        targetSha: document!.headCommitSha,
        semanticIndexedSha: document!.headCommitSha,
        graphIndexedSha: document!.headCommitSha,
        configFingerprint: active.configFingerprint,
        status: "ready",
        completedAt: activeCompletedAt,
      },
    });
    const building = await createGeneration(project.id, "building", {
      documentTotal: 51,
      documentFailedCount: 51,
    });
    await db.knowledgeGenerationDocument.createMany({
      data: Array.from({ length: 51 }, (_, index) => ({
        generationId: building.id,
        documentId: randomUUID(),
        projectId: project.id,
        targetSha: `${index}`.padStart(40, "f").slice(-40),
        configFingerprint: building.configFingerprint,
        status: "failed" as const,
        failureKind: "provider" as const,
        failureSummary: `Safe failure ${index}`.padEnd(300, "x"),
        completedAt: failureCompletedAt,
      })),
    });

    const status = await callerFor(maintainer).knowledge.status({
      projectId: project.id,
    });

    expect(status).toMatchObject({
      readiness: {
        keyword: "ready",
        semantic: "ready",
        graph: "ready",
        aiConfigured: true,
      },
      activeGeneration: {
        id: active.id,
        status: "active",
        documentTotal: 1,
        documentReadyCount: 1,
        documentFailedCount: 0,
        completedAt: activeCompletedAt,
        embedding: {
          model: "test-embedding",
          dimensions: 1536,
          dimensionMode: null,
          vectorType: "vector",
        },
      },
      buildingGeneration: {
        id: building.id,
        status: "building",
        documentTotal: 51,
        documentReadyCount: 0,
        documentFailedCount: 51,
        completedAt: null,
        embedding: {
          model: "test-embedding",
          dimensions: 1536,
          dimensionMode: null,
          vectorType: "vector",
        },
      },
      liveDocuments: 1,
      lastCompletedAt: failureCompletedAt,
      queue: { queued: 0, active: 0 },
    });
    expect(status.failures).toHaveLength(50);
    expect(
      status.failures.every(
        (failure) =>
          Object.keys(failure).sort().join(",") ===
            "completedAt,documentId,generationId,kind,occurredAt,status,summary" &&
          failure.summary.length <= 300 &&
          failure.occurredAt.getTime() === failureCompletedAt.getTime(),
      ),
    ).toBe(true);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(document!.path);
    expect(serialized).not.toContain("sourceText");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("response");
    expect(serialized).not.toContain("credentials");
  });

  it("counts current documents extracted with an older model or prompt", async () => {
    const db = getPrisma();
    const maintainer = await makeUser("User", "outdated-extraction");
    const project = await makeProject("Outdated extraction");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: routing.configFingerprint,
        embeddingModel: routing.embedding.providerModelId,
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v2",
        status: "active",
      },
    });
    const now = new Date();
    for (const [index, extractionFingerprint] of [
      routing.extractionFingerprint,
      "older-extraction",
      "older-extraction",
    ].entries()) {
      const sha = String(index).repeat(40);
      const document = await db.document.create({
        data: {
          id: randomUUID(),
          projectId: project.id,
          path: `doc-${index}.md`,
          slug: `doc-${index}`,
          title: `Doc ${index}`,
          excerpt: "",
          headCommitSha: sha,
          lastEditedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      await db.knowledgeGenerationDocument.create({
        data: {
          generationId: generation.id,
          documentId: document.id,
          projectId: project.id,
          targetSha: sha,
          semanticIndexedSha: sha,
          graphIndexedSha: index === 2 ? null : sha,
          configFingerprint: routing.configFingerprint,
          extractionFingerprint,
          status: index === 2 ? "processing" : "ready",
        },
      });
    }

    const status = await callerFor(maintainer).knowledge.status({
      projectId: project.id,
    });

    expect(status.outdatedExtraction).toBe(1);
  });

  it("excludes unrelated queues from project knowledge counts", async () => {
    const maintainer = await makeUser("User", "knowledge-queue-status");
    const project = await makeProject("Knowledge queue status");
    const otherProject = await makeProject("Other queue status");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const queueName = `knowledge-status-${randomUUID()}`;
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    let claimedId: string | undefined;

    try {
      await boss.start();
      await boss.createQueue(queueName);
      await boss.send(queueName, { projectId: project.id, marker: "active" });
      await boss.send(queueName, { projectId: project.id, marker: "queued" });
      await boss.send(queueName, {
        projectId: otherProject.id,
        marker: "hidden",
      });
      const [claimed] = await boss.fetch(queueName);
      claimedId = claimed?.id;
      expect(claimedId).toBeTypeOf("string");

      await expect(
        callerFor(maintainer).knowledge.status({ projectId: project.id }),
      ).resolves.toMatchObject({ queue: { queued: 0, active: 0 } });
    } finally {
      if (claimedId) await boss.complete(queueName, claimedId);
      await boss.deleteQueue(queueName).catch(() => undefined);
      await boss.stop();
    }
  });

  it("creates a fresh current-configuration shadow and enqueues its coordinator", async () => {
    const maintainer = await makeUser("User", "knowledge-rebuild");
    const project = await makeProject("Knowledge rebuild");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const active = await createGeneration(project.id, "active");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await getPrisma().llmModel.update({
      where: { id: routing.embedding.modelId },
      data: { embeddingDimensionMode: "matryoshka" },
    });
    invalidateLlmRouteCache();
    const currentRouting = await resolveKnowledgeRouting(getPrisma());
    if (!currentRouting) throw new Error("Expected ready knowledge routing");
    routing = currentRouting;

    const result = await callerFor(maintainer).knowledge.rebuild({
      projectId: project.id,
    });

    const generation = await getPrisma().knowledgeGeneration.findUniqueOrThrow({
      where: { id: result.generationId },
    });
    expect(generation).toMatchObject({
      projectId: project.id,
      configFingerprint: routing.configFingerprint,
      embeddingModel: "test-embedding",
      embeddingDimensions: 1536,
      extractionSchemaVersion: 1,
      promptVersion: "prompt-v2",
      status: "building",
      documentTotal: 0,
    });
    expect(generation.routeSnapshot).toMatchObject({
      extraction: { providerModelId: "test-extraction" },
      embedding: {
        providerModelId: "test-embedding",
        embeddingDimensionMode: "matryoshka",
      },
    });
    expect(generation.id).not.toBe(active.id);
    expect(generation).toMatchObject({
      buildTrigger: "manual_rebuild",
      requestedById: maintainer.id,
    });
    await expect(
      getPrisma().knowledgeGeneration.findUnique({
        where: { id: active.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "active" });
    expect(queue.jobs).toEqual([
      {
        name: "project.generation-build",
        data: {
          projectId: project.id,
          generationId: generation.id,
          configFingerprint: routing.configFingerprint,
        },
      },
    ]);
  });

  it("keeps a committed rebuild discoverable when coordinator delivery fails", async () => {
    const maintainer = await makeUser("User", "knowledge-rebuild-recovery");
    const project = await makeProject("Knowledge rebuild recovery");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const [document] = await createDocuments(project.id, 1, "rebuild-recovery");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const send = vi
      .spyOn(queue, "send")
      .mockRejectedValueOnce(new Error("SECRET broker endpoint failed"));
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await callerFor(maintainer).knowledge.rebuild({
      projectId: project.id,
    });

    const generation = await getPrisma().knowledgeGeneration.findUniqueOrThrow({
      where: { id: result.generationId },
      select: { status: true, configFingerprint: true },
    });
    expect(generation.status).toBe("building");
    expect(queue.jobs).toEqual([]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("SECRET");

    send.mockRestore();
    await reconcileProjectKnowledge(
      knowledgeSystemContextForTests(),
      getPrisma(),
      project.id,
    );

    expect(queue.jobs).toContainEqual({
      name: "document.ai-enrich",
      data: {
        projectId: project.id,
        generationId: result.generationId,
        documentId: document!.id,
        sourceCommitSha: document!.headCommitSha,
        pathAtSha: document!.path,
        configFingerprint: generation.configFingerprint,
      },
    });
    errorLog.mockRestore();
  });

  it("dates a failure without a completion time by its last update", async () => {
    const maintainer = await makeUser("User", "knowledge-failure-dates");
    const project = await makeProject("Knowledge failure dates");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const [blocked, failed] = await createDocuments(project.id, 2, "dates");
    const generation = await createGeneration(project.id, "building");
    const failedCompletedAt = new Date("2026-08-29T12:00:00.000Z");
    await getPrisma().knowledgeGenerationDocument.createMany({
      data: [
        retryState(generation, blocked!, "blocked_configuration", null),
        retryState(generation, failed!, "failed", failedCompletedAt),
      ],
    });

    const status = await callerFor(maintainer).knowledge.status({
      projectId: project.id,
    });

    expect(status.failures.map((failure) => failure.documentId)).toEqual([
      blocked!.id,
      failed!.id,
    ]);
    expect(status.failures[0]).toMatchObject({ completedAt: null });
    expectRecentUtc(status.failures[0]!.occurredAt);
    expect(status.failures[1]!.occurredAt).toEqual(failedCompletedAt);
  });

  it("stores retry timestamps as UTC wall-clock like Prisma writes", async () => {
    const maintainer = await makeUser("User", "knowledge-retry-utc");
    const project = await makeProject("Knowledge retry utc");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const [document] = await createDocuments(project.id, 1, "retry-utc");
    const generation = await createGeneration(project.id, "active", {
      configFingerprint: "retry-utc",
    });
    await getPrisma().knowledgeGenerationDocument.create({
      data: retryState(
        generation,
        document!,
        "failed",
        new Date("2026-08-29T12:00:00.000Z"),
      ),
    });
    setJobQueueForTests(new FakeJobQueue());

    await callerFor(maintainer).knowledge.retryFailed({
      projectId: project.id,
    });

    const state =
      await getPrisma().knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document!.id,
          },
        },
      });
    expect(state.status).toBe("pending");
    expectRecentUtc(state.updatedAt);
  });

  it("refreshes denormalized generation counters after retry", async () => {
    const maintainer = await makeUser("User", "knowledge-retry-counters");
    const project = await makeProject("Knowledge retry counters");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const documents = await createDocuments(project.id, 5, "retry-counters");
    const generation = await createGeneration(project.id, "active", {
      configFingerprint: "retry-counters",
      documentTotal: 9,
      documentReadyCount: 7,
      documentFailedCount: 2,
    });
    const completedAt = new Date("2026-08-29T12:00:00.000Z");
    await getPrisma().knowledgeGenerationDocument.createMany({
      data: [
        retryState(generation, documents[0]!, "failed", completedAt),
        {
          ...retryState(generation, documents[1]!, "failed", completedAt),
          targetSha: "0".repeat(40),
        },
        {
          ...retryState(generation, documents[2]!, "failed", completedAt),
          configFingerprint: "mismatched-failed-fingerprint",
        },
        {
          generationId: generation.id,
          documentId: documents[3]!.id,
          projectId: project.id,
          targetSha: documents[3]!.headCommitSha,
          semanticIndexedSha: documents[3]!.headCommitSha,
          graphIndexedSha: documents[3]!.headCommitSha,
          configFingerprint: "mismatched-ready-fingerprint",
          status: "ready",
          completedAt,
        },
        {
          generationId: generation.id,
          documentId: documents[4]!.id,
          projectId: project.id,
          targetSha: documents[4]!.headCommitSha,
          semanticIndexedSha: documents[4]!.headCommitSha,
          graphIndexedSha: documents[4]!.headCommitSha,
          configFingerprint: generation.configFingerprint,
          status: "ready",
          completedAt,
        },
      ],
    });
    setJobQueueForTests(new FakeJobQueue());

    await expect(
      callerFor(maintainer).knowledge.retryFailed({ projectId: project.id }),
    ).resolves.toEqual({ retried: 1, hasMore: false, nextCursor: null });

    await expect(
      callerFor(maintainer).knowledge.status({ projectId: project.id }),
    ).resolves.toMatchObject({
      activeGeneration: {
        id: generation.id,
        documentTotal: 5,
        documentReadyCount: 1,
        documentFailedCount: 0,
      },
    });
  });

  it("retries failed documents in stable bounded pages", async () => {
    const maintainer = await makeUser("User", "knowledge-retry-pages");
    const project = await makeProject("Knowledge retry pages");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const documents = await createDocuments(project.id, 205, "retry-pages");
    const generation = await createGeneration(project.id, "active", {
      configFingerprint: "retry-pages",
      documentTotal: documents.length,
      documentFailedCount: documents.length,
    });
    await getPrisma().knowledgeGenerationDocument.createMany({
      data: documents.map((document) =>
        retryState(
          generation,
          document,
          "failed",
          new Date("2026-08-29T12:00:00.000Z"),
        ),
      ),
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);

    const first = await callerFor(maintainer).knowledge.retryFailed({
      projectId: project.id,
    });

    expect(first).toMatchObject({ retried: 200, hasMore: true });
    expect(first.nextCursor).toEqual({
      generationId: generation.id,
      documentId: expect.any(String),
    });
    expect(queue.jobs).toHaveLength(200);

    const second = await callerFor(maintainer).knowledge.retryFailed({
      projectId: project.id,
      cursor: first.nextCursor!,
    });

    expect(second).toEqual({ retried: 5, hasMore: false, nextCursor: null });
    expect(queue.jobs).toHaveLength(205);
    expect(
      await getPrisma().knowledgeGenerationDocument.count({
        where: { generationId: generation.id, status: "pending" },
      }),
    ).toBe(205);
  });

  it("recovers every pending retry after a partial broker delivery failure", async () => {
    const maintainer = await makeUser("User", "knowledge-retry-recovery");
    const project = await makeProject("Knowledge retry recovery");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const documents = await createDocuments(project.id, 2, "retry-recovery");
    const generation = await createGeneration(project.id, "active", {
      configFingerprint: "retry-recovery",
      documentTotal: 2,
      documentFailedCount: 2,
    });
    await getPrisma().knowledgeGenerationDocument.createMany({
      data: documents.map((document) =>
        retryState(
          generation,
          document,
          "failed",
          new Date("2026-08-29T12:00:00.000Z"),
        ),
      ),
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const send = vi
      .spyOn(queue, "send")
      .mockRejectedValueOnce(new Error("SECRET broker endpoint failed"));
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      callerFor(maintainer).knowledge.retryFailed({ projectId: project.id }),
    ).resolves.toEqual({ retried: 1, hasMore: true, nextCursor: null });

    await expect(
      getPrisma().knowledgeGenerationDocument.findMany({
        where: { generationId: generation.id },
        orderBy: { documentId: "asc" },
        select: { status: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([{ status: "failed" }, { status: "pending" }]),
    );
    expect(
      queue.jobs.filter((job) => job.name === "document.ai-enrich"),
    ).toHaveLength(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("SECRET");

    send.mockRestore();
    await reconcileProjectKnowledge(
      knowledgeSystemContextForTests(),
      getPrisma(),
      project.id,
    );

    const enrichmentJobs = queue.jobs.filter(
      (job) => job.name === "document.ai-enrich",
    );
    expect(enrichmentJobs).toHaveLength(2);
    expect(enrichmentJobs.map((job) => job.data.documentId).sort()).toEqual(
      documents.map((document) => document.id).sort(),
    );
    errorLog.mockRestore();
  });

  it("retries only failed current live document SHAs in active or building generations", async () => {
    const maintainer = await makeUser("User", "knowledge-retry");
    const project = await makeProject("Knowledge retry");
    const otherProject = await makeProject("Knowledge retry hidden");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const documents = await createDocuments(project.id, 5, "retry");
    const [hiddenDocument] = await createDocuments(
      otherProject.id,
      1,
      "retry-hidden",
    );
    const active = await createGeneration(project.id, "active", {
      configFingerprint: "retry-active",
    });
    const building = await createGeneration(project.id, "building", {
      configFingerprint: "retry-building",
    });
    const superseded = await createGeneration(project.id, "superseded", {
      configFingerprint: "retry-superseded",
    });
    const hiddenGeneration = await createGeneration(otherProject.id, "active", {
      configFingerprint: "retry-hidden",
    });
    const deletedDocumentId = randomUUID();
    const completedAt = new Date("2026-08-29T12:00:00.000Z");
    const db = getPrisma();
    await db.knowledgeGenerationDocument.createMany({
      data: [
        retryState(active, documents[0]!, "failed", completedAt),
        retryState(
          building,
          documents[1]!,
          "blocked_configuration",
          completedAt,
        ),
        retryState(active, documents[2]!, "pending", null),
        {
          ...retryState(active, documents[3]!, "failed", completedAt),
          targetSha: "0".repeat(40),
        },
        {
          generationId: active.id,
          documentId: deletedDocumentId,
          projectId: project.id,
          targetSha: "d".repeat(40),
          configFingerprint: active.configFingerprint,
          status: "failed",
          failureKind: "internal",
          failureSummary: "Deleted source failed",
          completedAt,
        },
        retryState(superseded, documents[4]!, "failed", completedAt),
        retryState(hiddenGeneration, hiddenDocument!, "failed", completedAt),
      ],
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);

    await expect(
      callerFor(maintainer).knowledge.retryFailed({ projectId: project.id }),
    ).resolves.toEqual({ retried: 2, hasMore: false, nextCursor: null });

    const states = await db.knowledgeGenerationDocument.findMany({
      select: {
        generationId: true,
        documentId: true,
        status: true,
        failureKind: true,
        failureSummary: true,
        completedAt: true,
      },
    });
    const stateByIdentity = new Map(
      states.map((state) => [
        `${state.generationId}:${state.documentId}`,
        state,
      ]),
    );
    for (const [generation, document] of [
      [active, documents[0]!],
      [building, documents[1]!],
    ] as const) {
      expect(stateByIdentity.get(`${generation.id}:${document.id}`)).toEqual({
        generationId: generation.id,
        documentId: document.id,
        status: "pending",
        failureKind: null,
        failureSummary: null,
        completedAt: null,
      });
    }
    expect(
      stateByIdentity.get(`${active.id}:${documents[2]!.id}`)?.status,
    ).toBe("pending");
    expect(
      stateByIdentity.get(`${active.id}:${documents[3]!.id}`)?.status,
    ).toBe("failed");
    expect(
      stateByIdentity.get(`${active.id}:${deletedDocumentId}`)?.status,
    ).toBe("failed");
    expect(
      stateByIdentity.get(`${superseded.id}:${documents[4]!.id}`)?.status,
    ).toBe("failed");
    expect(
      stateByIdentity.get(`${hiddenGeneration.id}:${hiddenDocument!.id}`)
        ?.status,
    ).toBe("failed");
    expect(queue.jobs).toEqual(
      [
        { generation: active, document: documents[0]! },
        { generation: building, document: documents[1]! },
      ]
        .sort((left, right) =>
          left.generation.id.localeCompare(right.generation.id),
        )
        .map(({ generation, document }) => ({
          name: "document.ai-enrich" as const,
          data: {
            projectId: project.id,
            generationId: generation.id,
            documentId: document.id,
            sourceCommitSha: document.headCommitSha,
            pathAtSha: document.path,
            configFingerprint: generation.configFingerprint,
          },
        })),
    );
  });
});

async function createDocuments(
  projectId: string,
  count: number,
  suffix: string,
) {
  const db = getPrisma();
  const documents = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    projectId,
    path: `${suffix}-${index}.md`,
    slug: `${suffix}-${index}`,
    title: `${suffix} ${index}`,
    excerpt: `SOURCE-TEXT-${suffix}-${index}`,
    headCommitSha: `${index + 1}`.repeat(40).slice(0, 40),
    lastEditedAt: new Date("2026-08-29T09:00:00.000Z"),
    createdAt: new Date("2026-08-29T09:00:00.000Z"),
    updatedAt: new Date("2026-08-29T09:00:00.000Z"),
  }));
  await db.document.createMany({ data: documents });
  return documents;
}

async function createGeneration(
  projectId: string,
  status: "active" | "building" | "failed" | "superseded",
  overrides: Partial<{
    configFingerprint: string;
    documentTotal: number;
    documentReadyCount: number;
    documentFailedCount: number;
    completedAt: Date;
    activatedAt: Date;
  }> = {},
) {
  return getPrisma().knowledgeGeneration.create({
    data: {
      projectId,
      configFingerprint:
        overrides.configFingerprint ?? `knowledge-${status}-${randomUUID()}`,
      embeddingModel: "test-embedding",
      embeddingDimensions: 1536,
      extractionSchemaVersion: 1,
      promptVersion: "prompt-v1",
      status,
      documentTotal: overrides.documentTotal ?? 0,
      documentReadyCount: overrides.documentReadyCount ?? 0,
      documentFailedCount: overrides.documentFailedCount ?? 0,
      completedAt: overrides.completedAt,
      activatedAt: overrides.activatedAt,
      supersededAt: status === "superseded" ? new Date() : undefined,
    },
  });
}

function retryState(
  generation: Awaited<ReturnType<typeof createGeneration>>,
  document: Awaited<ReturnType<typeof createDocuments>>[number],
  status: "failed" | "blocked_configuration" | "pending",
  completedAt: Date | null,
) {
  return {
    generationId: generation.id,
    documentId: document.id,
    projectId: generation.projectId,
    targetSha: document.headCommitSha,
    configFingerprint: generation.configFingerprint,
    status,
    failureKind:
      status === "blocked_configuration"
        ? ("configuration" as const)
        : status === "failed"
          ? ("provider" as const)
          : null,
    failureSummary: status === "pending" ? null : `Failure for ${document.id}`,
    completedAt,
  };
}

function expectRecentUtc(value: Date | null | undefined): void {
  expect(value).toBeInstanceOf(Date);
  expect(Math.abs(value!.getTime() - Date.now())).toBeLessThan(60_000);
}
