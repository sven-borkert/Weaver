import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError } from "@weaver/core/ai/types";
import { lockLiveKnowledgeProject } from "@weaver/core/services/knowledgeTargets";
import type { AiProvider } from "@weaver/core/ai/types";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { syncDocumentKeywordIndex } from "@weaver/core/services/keywordIndex";
import {
  blockGenerationDocumentForConfiguration,
  cleanupSupersededGenerations,
  activateCompletedGeneration,
  processGenerationDocument,
  startGenerationBuild,
} from "@weaver/core/services/knowledgeGenerations";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

const context = knowledgeSystemContextForTests();
const usage = {
  inputTokens: 1,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 1,
  durationMs: 1,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    embeddingRequestByteLength: (values) =>
      Buffer.byteLength(JSON.stringify(values)),
    embed: async (values) => ({
      vectors: values.map(() => Array(1536).fill(0.25) as number[]),
      usage,
    }),
    extract: async () => ({ data: { entities: [], relations: [] }, usage }),
    ...overrides,
  };
}

async function fixture() {
  const db = getPrisma();
  const editor = await makeUser("User", `processing-${randomUUID()}`);
  const project = await makeProject("Processing recovery");
  await addMembership(project.id, editor.id, "Editor");
  const document = await callerFor(editor).document.create({
    projectId: project.id,
    folderPath: [],
    title: "Recovery",
    contentJson: parseDocumentBody(
      "A source whose processing must recover safely.",
    ),
  });
  const source = {
    projectId: project.id,
    documentId: document.id,
    sourceCommitSha: document.headCommitSha,
    pathAtSha: document.path,
  };
  await syncDocumentKeywordIndex(context, db, source);
  const generation = await startGenerationBuild(context, db, {
    projectId: project.id,
    configFingerprint: "processing-config",
    embeddingModel: "embedding",
    embeddingDimensions: 1536,
    extractionSchemaVersion: 1,
    promptVersion: "processing-v1",
    routeSnapshot: null,
  });
  if (!generation) throw new Error("expected a generation");
  const input = {
    ...source,
    generationId: generation.id,
    configFingerprint: generation.configFingerprint,
    providerName: "test",
    embeddingConnectionId: null,
    embeddingModel: "embedding",
    embeddingDimensions: 1536 as const,
    inputCostMicrosPerMillion: null,
    outputCostMicrosPerMillion: null,
    currency: null,
    extractionModel: "extraction",
    extractionFingerprint: "test-extraction-fingerprint",
    extractionProviderName: "test",
    extractionConnectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    extractionInputCostMicrosPerMillion: null,
    extractionOutputCostMicrosPerMillion: null,
    extractionCurrency: null,
  };
  const state = () =>
    db.knowledgeGenerationDocument.findUniqueOrThrow({
      where: {
        generationId_documentId: {
          generationId: generation.id,
          documentId: document.id,
        },
      },
    });
  return { db, input, generation, state };
}

describe("knowledge processing delivery ownership", () => {
  it("retries exhausted entity resolution races and reuses unchanged staged vectors", async () => {
    const { db, input, state } = await fixture();
    const mutable = await db.graphEntity.create({
      data: {
        projectId: input.projectId,
        generationId: input.generationId,
        canonicalName: "Mutable",
        normalizedName: "mutable",
        entityType: "Concept",
      },
    });
    const embedded: string[] = [];
    let drift = 0;
    const racing = provider({
      extract: async () => ({
        usage,
        data: {
          relations: [],
          entities: ["Mutable", "Stable"].map((name) => ({
            key: name,
            name,
            type: "Concept",
            aliases: [],
            description: null,
            mentionText: name,
            confidence: 1,
          })),
        },
      }),
      embed: async (texts) => {
        embedded.push(...texts);
        if (texts.some((text) => text.startsWith("Mutable\n"))) {
          drift += 1;
          await db.graphEntityAlias.create({
            data: {
              projectId: input.projectId,
              entityId: mutable.id,
              alias: `Concurrent ${drift}`,
              normalizedAlias: `concurrent ${drift}`,
            },
          });
        }
        return {
          vectors: texts.map(() => Array(1536).fill(0.25) as number[]),
          usage,
        };
      },
    });
    await expect(
      processGenerationDocument(context, db, racing, input),
    ).rejects.toThrow("Entity resolution changed repeatedly");
    expect(await state()).toMatchObject({
      status: "failed",
      failureKind: "internal",
      completedAt: null,
    });
    expect(embedded.filter((text) => text.startsWith("Stable\n"))).toHaveLength(
      1,
    );
  });

  it("allows project child inserts while knowledge publication holds its lock", async () => {
    const { db, input } = await fixture();
    const locked = deferred();
    const release = deferred();
    const holding = db.$transaction(async (tx) => {
      await lockLiveKnowledgeProject(tx, input.projectId);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      const original = await db.document.findUniqueOrThrow({
        where: { id: input.documentId },
      });
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        const {
          normalizedTitle: _title,
          normalizedTitleHash: _hash,
          appearance: _appearance,
          ...data
        } = original;
        await tx.document.create({
          data: {
            ...data,
            id: randomUUID(),
            path: "independent.md",
            slug: "independent",
          },
        });
      });
    } finally {
      release.resolve();
      await holding;
    }
  });

  it("invalidates superseded graph facts on terminal extraction failure", async () => {
    const { db, input } = await fixture();
    const entity = await db.graphEntity.create({
      data: {
        projectId: input.projectId,
        generationId: input.generationId,
        canonicalName: "Old fact",
        normalizedName: "old fact",
        entityType: "Concept",
        description: "Old description",
      },
    });
    const mention = await db.entityMention.create({
      data: {
        projectId: input.projectId,
        generationId: input.generationId,
        entityId: entity.id,
        documentId: input.documentId,
        sourceCommitSha: "a".repeat(40),
        sourceChunkId: "b".repeat(64),
        mentionText: "Old fact",
        sourceDescription: "Old description",
        confidence: 1,
      },
    });
    await processGenerationDocument(
      context,
      db,
      provider({
        extract: async () => {
          throw new AiProviderError("Invalid extraction", {
            kind: "validation",
            retryable: false,
          });
        },
      }),
      input,
    );
    expect(
      (await db.entityMention.findUniqueOrThrow({ where: { id: mention.id } }))
        .invalidatedAt,
    ).not.toBeNull();
    expect(
      (await db.graphEntity.findUniqueOrThrow({ where: { id: entity.id } }))
        .description,
    ).toBeNull();
  });

  it("repairs unrelated missing entity vectors immediately after successful publication", async () => {
    const { db, input } = await fixture();
    const original = await db.document.findUniqueOrThrow({
      where: { id: input.documentId },
    });
    const {
      normalizedTitle: _title,
      normalizedTitleHash: _hash,
      appearance: _appearance,
      ...data
    } = original;
    const other = await db.document.create({
      data: { ...data, id: randomUUID(), path: "other.md", slug: "other" },
    });
    const entity = await db.graphEntity.create({
      data: {
        projectId: input.projectId,
        generationId: input.generationId,
        canonicalName: "Other fact",
        normalizedName: "other fact",
        entityType: "Concept",
      },
    });
    await db.entityMention.create({
      data: {
        projectId: input.projectId,
        generationId: input.generationId,
        entityId: entity.id,
        documentId: other.id,
        sourceCommitSha: other.headCommitSha,
        sourceChunkId: "b".repeat(64),
        mentionText: "Other fact",
        confidence: 1,
      },
    });
    await processGenerationDocument(context, db, provider(), input);
    expect(
      await db.knowledgeEmbedding.count({
        where: { ownerType: "entity", ownerId: entity.id },
      }),
    ).toBe(1);
  });

  beforeEach(async () => {
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    setJobQueueForTests(new FakeJobQueue());
    await resetDb();
  });
  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it.each(["embedding", "graph"] as const)(
    "reclaims a newer retry and fences the prior %s publication",
    async (phase) => {
      const { db, input, state } = await fixture();
      const firstEntered = deferred();
      const secondEntered = deferred();
      const releaseFirst = deferred();
      const releaseSecond = deferred();
      const jobId = randomUUID();
      function waiting(
        entered: ReturnType<typeof deferred>,
        release: ReturnType<typeof deferred>,
        name: string,
      ) {
        const base = provider();
        return provider({
          embed: async (values, options) => {
            if (phase === "embedding") {
              entered.resolve();
              await release.promise;
            }
            return base.embed(values, options);
          },
          extract: async () => {
            if (phase === "graph") {
              entered.resolve();
              await release.promise;
            }
            return {
              data: {
                entities: [
                  {
                    key: name,
                    name,
                    type: "Concept",
                    aliases: [],
                    description: null,
                    mentionText: name,
                    confidence: 0.9,
                  },
                ],
                relations: [],
              },
              usage,
            };
          },
        });
      }
      const first = processGenerationDocument(
        context,
        db,
        waiting(firstEntered, releaseFirst, "Old"),
        input,
        { delivery: { jobId, retryCount: 0 } },
      );
      await firstEntered.promise;
      const second = processGenerationDocument(
        context,
        db,
        waiting(secondEntered, releaseSecond, "New"),
        input,
        { delivery: { jobId, retryCount: 1 } },
      );
      try {
        expect(
          await Promise.race([
            secondEntered.promise.then(() => true),
            second.then(() => false),
          ]),
        ).toBe(true);
        releaseFirst.resolve();
        expect(await first).toEqual({ outcome: "stale" });
        expect(await state()).toMatchObject({
          status: "processing",
          attempts: 2,
          processingJobId: jobId,
          processingRetryCount: 1,
        });
        expect(
          await db.graphEntity.count({
            where: { generationId: input.generationId },
          }),
        ).toBe(0);
        if (phase === "embedding")
          expect(
            await db.knowledgeEmbedding.count({
              where: { generationId: input.generationId },
            }),
          ).toBe(0);
        releaseSecond.resolve();
        expect(await second).toEqual({ outcome: "ready" });
        expect(
          await db.graphEntity.findMany({
            where: { generationId: input.generationId },
            select: { canonicalName: true },
          }),
        ).toEqual([{ canonicalName: "New" }]);
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        await Promise.allSettled([first, second]);
      }
    },
  );

  it("releases an interrupted claim immediately for a replacement worker", async () => {
    const { db, input, state } = await fixture();
    const entered = deferred();
    const controller = new AbortController();
    const running = processGenerationDocument(
      context,
      db,
      provider({
        embed: async (_values, options) => {
          entered.resolve();
          await new Promise<void>((_resolve, reject) =>
            options!.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("Cancelled", "AbortError")),
              { once: true },
            ),
          );
          throw new Error("unreachable");
        },
      }),
      input,
      {
        signal: controller.signal,
        delivery: { jobId: randomUUID(), retryCount: 0 },
      },
    );
    await entered.promise;
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(await state()).toMatchObject({
      status: "pending",
      processingClaimToken: null,
    });
    expect(
      await processGenerationDocument(context, db, provider(), input, {
        delivery: { jobId: randomUUID(), retryCount: 0 },
      }),
    ).toEqual({ outcome: "ready" });
  });

  it("ends a configuration-blocked shadow generation while preserving active data", async () => {
    const { db, input, generation } = await fixture();
    const active = await db.knowledgeGeneration.create({
      data: {
        projectId: input.projectId,
        configFingerprint: "old-config",
        embeddingModel: "embedding",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "old",
        status: "active",
        activatedAt: new Date(),
      },
    });
    await blockGenerationDocumentForConfiguration(context, db, input);
    expect(
      await db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: generation.id },
      }),
    ).toMatchObject({
      status: "failed",
      failureKind: "configuration",
      completedAt: expect.any(Date),
    });
    expect(
      await db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: active.id },
      }),
    ).toMatchObject({ status: "active" });
  });

  it("repairs a configuration-blocked document whose generation handoff was interrupted", async () => {
    const { db, input, generation } = await fixture();
    await db.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId: generation.id,
          documentId: input.documentId,
        },
      },
      data: {
        status: "blocked_configuration",
        failureKind: "configuration",
        completedAt: new Date(),
      },
    });
    expect(await activateCompletedGeneration(context, db, input)).toBe(false);
    expect(
      await db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: generation.id },
      }),
    ).toMatchObject({ status: "failed", failureKind: "configuration" });
  });

  it("never reclaims an unidentified recent legacy processing claim", async () => {
    const { db, input, state } = await fixture();
    await db.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId: input.generationId,
          documentId: input.documentId,
        },
      },
      data: { status: "processing", attempts: 1, lastAttemptAt: new Date() },
    });
    expect(
      await processGenerationDocument(context, db, provider(), input, {
        delivery: { jobId: randomUUID(), retryCount: 1 },
      }),
    ).toEqual({ outcome: "stale" });
    expect(await state()).toMatchObject({ status: "processing", attempts: 1 });
  });

  it("limits generation retention cleanup while keeping the newest fallback", async () => {
    const { db, input } = await fixture();
    const expiredAt = new Date(Date.now() - 10 * 86_400_000);
    const fallback = await db.knowledgeGeneration.create({
      data: {
        projectId: input.projectId,
        configFingerprint: "fallback",
        embeddingModel: "embedding",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "old",
        status: "superseded",
        supersededAt: expiredAt,
      },
    });
    await db.knowledgeGeneration.createMany({
      data: Array.from({ length: 205 }, () => ({
        projectId: input.projectId,
        configFingerprint: "expired",
        embeddingModel: "embedding",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "old",
        status: "failed" as const,
        completedAt: expiredAt,
      })),
    });
    expect(
      await cleanupSupersededGenerations(context, db, input.projectId),
    ).toBe(200);
    expect(
      await db.knowledgeGeneration.count({
        where: { projectId: input.projectId, status: "failed" },
      }),
    ).toBe(5);
    expect(
      await db.knowledgeGeneration.findUnique({ where: { id: fallback.id } }),
    ).not.toBeNull();
    expect(
      await cleanupSupersededGenerations(context, db, input.projectId),
    ).toBe(5);
  });
});
