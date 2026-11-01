import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@weaver/db/client";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import {
  defaultVectorSpaceKey,
  knowledgeExtractionFingerprint,
  knowledgeIndexFingerprint,
} from "@weaver/core/knowledge/identity";
import {
  KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
  KNOWLEDGE_PROMPT_VERSION,
} from "@weaver/core/knowledge/config";
import { reconcileProjectKnowledge } from "@weaver/core/services/knowledgeReconciliation";
import {
  invalidateLlmRouteCache,
  knowledgeRouteSnapshot,
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

const FOLLOWUP_MIGRATION = new URL(
  "../../../../packages/db/prisma/migrations/20260926090400_knowledge_identity_followups/migration.sql",
  import.meta.url,
);

async function snapshotGeneration(
  projectId: string,
  routing: KnowledgeRouting,
  configFingerprint: string,
) {
  return getPrisma().knowledgeGeneration.create({
    data: {
      projectId,
      configFingerprint,
      embeddingModel: routing.embedding.providerModelId,
      embeddingDimensions: routing.embeddingDimensions,
      extractionSchemaVersion: routing.extractionSchemaVersion,
      promptVersion: routing.promptVersion,
      routeSnapshot: knowledgeRouteSnapshot(
        routing,
      ) as unknown as Prisma.InputJsonObject,
      status: "active",
      activatedAt: new Date(),
    },
  });
}

const fieldCases = [
  {
    providerType: "ollama",
    endpoint: "http://ollama.test:11434",
    providerModelId: "qwen3-embedding:4b",
    upstreamProvider: null,
  },
  {
    providerType: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    providerModelId: "a|b\\c",
    upstreamProvider: "prov|x",
  },
  {
    providerType: "openai_compatible",
    endpoint: "https://modèles.example/v1",
    providerModelId: "größe-嵌入",
    upstreamProvider: "",
  },
] as const;

describe("knowledge identity SQL parity", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("computes the same digests in SQL and TypeScript", async () => {
    const db = getPrisma();
    for (const model of fieldCases) {
      const [row] = await db.$queryRaw<
        Array<{ key: string; index: string; extraction: string }>
      >`
        SELECT weaver_knowledge_vector_space_key(${model.providerType}, ${model.endpoint}, ${model.providerModelId}, ${model.upstreamProvider}) AS key,
               weaver_knowledge_index_fingerprint(
                 weaver_knowledge_vector_space_key(${model.providerType}, ${model.endpoint}, ${model.providerModelId}, ${model.upstreamProvider}),
                 1536, 'matryoshka', 1) AS index,
               weaver_knowledge_extraction_fingerprint(${model.providerType}, ${model.endpoint}, ${model.providerModelId}, ${model.upstreamProvider}, 'prompt-v2') AS extraction
      `;
      const key = defaultVectorSpaceKey(model);
      expect(row).toEqual({
        key,
        index: knowledgeIndexFingerprint(
          {
            vectorSpaceKey: key,
            embeddingDimensions: 1536,
            embeddingDimensionMode: "matryoshka",
          },
          1,
        ),
        extraction: knowledgeExtractionFingerprint(model, "prompt-v2"),
      });
    }
    const [keywordOnly] = await db.$queryRaw<Array<{ value: string }>>`
      SELECT weaver_knowledge_keyword_only_fingerprint(1) AS value
    `;
    expect(keywordOnly!.value).toBe(knowledgeIndexFingerprint(null, 1));
  });

  it("rewrites matching rows once and leaves stale and snapshot-less rows alone", async () => {
    const db = getPrisma();
    const project = await makeProject("Fingerprint rewrite");
    const embedding = fieldCases[0];
    const routeSnapshot = {
      embedding: { ...embedding, embeddingDimensionMode: "matryoshka" },
      extraction: {
        providerType: "openai_compatible",
        endpoint: "https://models.example/v1",
        providerModelId: "old-extract",
      },
    };
    const snapshotted = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "legacy-snapshotted",
        embeddingModel: embedding.providerModelId,
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v2",
        routeSnapshot,
        status: "active",
      },
    });
    const snapshotless = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "legacy-snapshotless",
        embeddingModel: "old-embedding",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "superseded",
      },
    });
    const readyDocument = randomUUID();
    const staleDocument = randomUUID();
    await db.knowledgeGenerationDocument.createMany({
      data: [
        {
          generationId: snapshotted.id,
          documentId: readyDocument,
          projectId: project.id,
          targetSha: "a".repeat(40),
          graphIndexedSha: "a".repeat(40),
          configFingerprint: "legacy-snapshotted",
          status: "ready",
        },
        {
          generationId: snapshotted.id,
          documentId: staleDocument,
          projectId: project.id,
          targetSha: "b".repeat(40),
          configFingerprint: "older-stale",
          status: "pending",
        },
      ],
    });

    await db.$executeRaw`SELECT weaver_knowledge_rewrite_fingerprints_v2()`;
    await db.$executeRaw`SELECT weaver_knowledge_rewrite_fingerprints_v2()`;

    const expected = knowledgeIndexFingerprint(
      {
        vectorSpaceKey: defaultVectorSpaceKey(embedding),
        embeddingDimensions: 1536,
        embeddingDimensionMode: "matryoshka",
      },
      1,
    );
    await expect(
      db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: snapshotted.id },
        select: { configFingerprint: true },
      }),
    ).resolves.toEqual({ configFingerprint: expected });
    await expect(
      db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: snapshotless.id },
        select: { configFingerprint: true },
      }),
    ).resolves.toEqual({ configFingerprint: "legacy-snapshotless" });
    const states = await db.knowledgeGenerationDocument.findMany({
      where: { generationId: snapshotted.id },
      select: {
        documentId: true,
        configFingerprint: true,
        extractionFingerprint: true,
        extractionModel: true,
      },
    });
    expect(states.find((row) => row.documentId === readyDocument)).toEqual({
      documentId: readyDocument,
      configFingerprint: expected,
      extractionFingerprint: knowledgeExtractionFingerprint(
        routeSnapshot.extraction,
        "prompt-v2",
      ),
      extractionModel: "old-extract",
    });
    expect(states.find((row) => row.documentId === staleDocument)).toEqual({
      documentId: staleDocument,
      configFingerprint: "older-stale",
      extractionFingerprint: null,
      extractionModel: null,
    });
  });

  it.each([null, "e".repeat(64)])(
    "rewrites a real route snapshot to exactly the live fingerprint (verified key %s)",
    async (vectorSpaceKey) => {
      const db = getPrisma();
      const { routing } = await seedTestLlmRouting();
      await db.llmModel.update({
        where: { id: routing.embedding.modelId },
        data: { vectorSpaceKey },
      });
      invalidateLlmRouteCache();
      const live = (await resolveKnowledgeRouting(db))!;
      const project = await makeProject("Real snapshot rewrite");
      const generation = await snapshotGeneration(
        project.id,
        live,
        "legacy-real-shape",
      );

      await db.$executeRawUnsafe(
        await readFile(
          new URL(
            "../../../../packages/db/prisma/migrations/20261025150000_verified_knowledge_fingerprints/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );

      await expect(
        db.knowledgeGeneration.findUniqueOrThrow({
          where: { id: generation.id },
          select: { configFingerprint: true },
        }),
      ).resolves.toEqual({ configFingerprint: live.configFingerprint });
      if (vectorSpaceKey) {
        expect(live.configFingerprint).toBe(
          knowledgeIndexFingerprint(
            {
              vectorSpaceKey,
              embeddingDimensions: 1536,
              embeddingDimensionMode: "native",
            },
            KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
          ),
        );
      }
    },
  );

  it("rewrites a keyword-only generation to the keyword-only fingerprint", async () => {
    const db = getPrisma();
    const project = await makeProject("Keyword-only rewrite");
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "legacy-keyword-only",
        embeddingModel: "unconfigured",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v2",
        status: "active",
      },
    });

    await db.$executeRaw`SELECT weaver_knowledge_rewrite_fingerprints_v2()`;

    await expect(
      db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: generation.id },
        select: { configFingerprint: true },
      }),
    ).resolves.toEqual({
      configFingerprint: knowledgeIndexFingerprint(null, 1),
    });
  });

  it("resolves routing with the verified key and the extraction fingerprint", async () => {
    const db = getPrisma();
    const { routing } = await seedTestLlmRouting();
    await db.llmModel.update({
      where: { id: routing.embedding.modelId },
      data: { vectorSpaceKey: "f".repeat(64) },
    });
    invalidateLlmRouteCache();
    const resolved = await resolveKnowledgeRouting(db);
    expect(resolved?.configFingerprint).toBe(
      knowledgeIndexFingerprint(
        {
          vectorSpaceKey: "f".repeat(64),
          embeddingDimensions: 1536,
          embeddingDimensionMode: "native",
        },
        KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
      ),
    );
    expect(resolved?.extractionFingerprint).toBe(
      knowledgeExtractionFingerprint(
        routing.extraction,
        KNOWLEDGE_PROMPT_VERSION,
      ),
    );
  });
});

describe("released identity migration recovery", () => {
  beforeEach(resetDb);
  it("can finish a partial schema twice inside an atomic recovery transaction", async () => {
    const db = getPrisma();
    const project = await makeProject("Recovery");
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "old",
        embeddingModel: "unconfigured",
        embeddingDimensions: 0,
        extractionSchemaVersion: 1,
        promptVersion: "old",
        status: "active",
      },
    });
    const recovery = (
      await readFile(
        new URL(
          "../../../../packages/db/prisma/recovery/knowledge-index-identity.sql",
          import.meta.url,
        ),
        "utf8",
      )
    )
      .replace(/^BEGIN;\n/, "")
      .replace(/COMMIT;\s*$/, "");
    const schema = `recovery_${randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("rollback isolated recovery fixture");
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `CREATE SCHEMA "${schema}"; SET LOCAL search_path = "${schema}", public`,
        );
        for (const table of [
          "LlmModel",
          "KnowledgeGeneration",
          "KnowledgeGenerationDocument",
          "KnowledgeEmbedding",
        ]) {
          await tx.$executeRawUnsafe(
            `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL); INSERT INTO "${schema}"."${table}" SELECT * FROM public."${table}"`,
          );
        }
        await tx.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."_prisma_migrations" (migration_name text, finished_at timestamp, rolled_back_at timestamp); INSERT INTO "${schema}"."_prisma_migrations" (migration_name) VALUES ('20260926090000_knowledge_index_identity')`,
        );
        await tx.$executeRawUnsafe(recovery);
        await tx.$executeRawUnsafe(recovery);
        const rows = await tx.$queryRawUnsafe<{ configFingerprint: string }[]>(
          `SELECT "configFingerprint" FROM "${schema}"."KnowledgeGeneration" WHERE id = '${generation.id}'`,
        );
        expect(rows[0]!.configFingerprint).toBe(
          knowledgeIndexFingerprint(null, 1),
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(
      (
        await db.knowledgeGeneration.findUniqueOrThrow({
          where: { id: generation.id },
        })
      ).configFingerprint,
    ).toBe("old");
  });
});

describe("knowledge identity follow-up migration", () => {
  let queue: FakeJobQueue;

  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    queue = new FakeJobQueue();
    setJobQueueForTests(queue);
  });
  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it("releases claims taken under the old fingerprint so reconciliation re-enqueues them", async () => {
    const db = getPrisma();
    await seedTestLlmRouting();
    const live = (await resolveKnowledgeRouting(db))!;
    const maintainer = await makeUser(
      "User",
      `claim-release-${randomUUID().slice(0, 8)}`,
    );
    const project = await makeProject("Claim release");
    await addMembership(project.id, maintainer.id, "Maintainer");
    const document = await callerFor(maintainer).document.create({
      projectId: project.id,
      folderPath: [],
      title: "Claimed",
      contentJson: parseDocumentBody("# Claimed\n\nBody.\n"),
    });
    const generation = await snapshotGeneration(
      project.id,
      live,
      "legacy-v1-fingerprint",
    );
    await db.knowledgeGenerationDocument.create({
      data: {
        generationId: generation.id,
        documentId: document.id,
        projectId: project.id,
        targetSha: document.headCommitSha,
        configFingerprint: "legacy-v1-fingerprint",
        status: "processing",
        attempts: 2,
        processingClaimToken: randomUUID(),
        processingJobId: randomUUID(),
        processingRetryCount: 0,
        lastAttemptAt: new Date(),
      },
    });
    await db.$executeRaw`SELECT weaver_knowledge_rewrite_fingerprints_v2()`;
    const context = knowledgeSystemContextForTests();
    const enrichJobs = () =>
      queue.jobs
        .filter((job) => job.name === "document.ai-enrich")
        .map((job) => job.data);
    queue.jobs.length = 0;

    await reconcileProjectKnowledge(context, db, project.id);
    expect(enrichJobs()).toEqual([]);

    await db.$executeRawUnsafe(await readFile(FOLLOWUP_MIGRATION, "utf8"));
    await reconcileProjectKnowledge(context, db, project.id);

    await expect(
      db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        select: {
          status: true,
          attempts: true,
          targetSha: true,
          configFingerprint: true,
          processingClaimToken: true,
          processingJobId: true,
          processingRetryCount: true,
          lastAttemptAt: true,
        },
      }),
    ).resolves.toEqual({
      status: "pending",
      attempts: 2,
      targetSha: document.headCommitSha,
      configFingerprint: live.configFingerprint,
      processingClaimToken: null,
      processingJobId: null,
      processingRetryCount: null,
      lastAttemptAt: null,
    });
    expect(enrichJobs()).toEqual([
      {
        projectId: project.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
        generationId: generation.id,
        configFingerprint: live.configFingerprint,
      },
    ]);
  });
});
