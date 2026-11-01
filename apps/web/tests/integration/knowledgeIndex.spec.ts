import { createHash, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import pgvector from "pgvector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@weaver/db/client";

import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS } from "@weaver/core/jobs/types";
import type { ExtractionResponse } from "@weaver/core/knowledge/extraction";
import type {
  AiProvider,
  EmbeddingResult,
  ExtractionResult,
} from "@weaver/core/ai/types";
import { AiProviderError } from "@weaver/core/ai/types";
import { createKnowledgeProvider } from "@weaver/core/ai/registry";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import * as gitStore from "@weaver/git-store";
import { parseDocumentFile } from "@weaver/core/documents/frontmatter";
import { upgradeDocumentHeaders } from "@weaver/core/services/documentHeaderUpgrade";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import {
  loadDocumentIndexSource,
  loadTableSearchSource,
} from "@weaver/core/services/knowledgeSources";
import {
  syncDocumentKeywordIndex,
  syncTableKeywordIndex,
} from "@weaver/core/services/keywordIndex";
import {
  reconcileAllProjects,
  reconcileProjectKnowledge,
} from "@weaver/core/services/knowledgeReconciliation";
import { refreshEntityDescriptions } from "@weaver/core/services/knowledgeEntityDescriptions";
import { embedGenerationDocument } from "@weaver/core/services/knowledgeEmbeddings";
import {
  enrichGenerationDocument,
  repairMissingEntityEmbeddings,
} from "@weaver/core/services/knowledgeEnrichment";
import {
  activateCompletedGeneration,
  blockGenerationBuildForConfiguration,
  blockGenerationDocumentForConfiguration,
  cleanupSupersededGenerations,
  deleteKnowledgeContent,
  ensureGenerationForCurrentConfig,
  failGeneration,
  processGenerationDocument,
  recordDocumentChangeForGenerations,
  resumeGenerationBuild,
  startGenerationBuild,
  type GenerationConfiguration,
} from "@weaver/core/services/knowledgeGenerations";
import type { KnowledgeRouting } from "@weaver/core/services/llmRoutes";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

async function setupEditor(suffix: string) {
  const editor = await makeUser("User", `knowledge-index-${suffix}`);
  const project = await makeProject(`Knowledge index ${suffix}`);
  await addMembership(project.id, editor.id, "Editor");
  return { caller: callerFor(editor), editor, project };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createTestPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
}

async function waitForCondition<T>(check: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await check();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("database condition was not observed");
}

async function deleteDocumentBeforeTransaction<T>(
  db: PrismaClient,
  transactionOrdinal: number,
  target: {
    projectId: string;
    documentId: string;
    sourceCommitSha: string;
  },
  action: () => Promise<T>,
): Promise<T> {
  type InteractiveTransaction = (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ) => Promise<unknown>;
  const originalTransaction = db.$transaction.bind(
    db,
  ) as InteractiveTransaction;
  let transactionCount = 0;
  let intercepted = false;
  const transactionSpy = vi.spyOn(db, "$transaction");
  transactionSpy.mockImplementation(
    (
      callback: Parameters<InteractiveTransaction>[0],
      options?: Parameters<InteractiveTransaction>[1],
    ) => {
      transactionCount += 1;
      const run = () => originalTransaction(callback, options);
      if (transactionCount !== transactionOrdinal) return run();
      intercepted = true;
      transactionSpy.mockRestore();
      return (async () => {
        await db.document.delete({ where: { id: target.documentId } });
        await deleteKnowledgeContent(knowledgeSystemContextForTests(), db, {
          projectId: target.projectId,
          sourceType: "document",
          sourceId: target.documentId,
          sourceCommitSha: target.sourceCommitSha,
        });
        return run();
      })();
    },
  );
  try {
    return await action();
  } finally {
    transactionSpy.mockRestore();
    expect(intercepted).toBe(true);
  }
}

const embeddingConnectionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const extractionConnectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const embeddingIdentity = {
  providerName: "test-provider",
  embeddingConnectionId,
  embeddingModel: "test-embedding",
  embeddingDimensions: 1536 as const,
  inputCostMicrosPerMillion: 1_000_000,
  outputCostMicrosPerMillion: 4_000_000,
  currency: "USD",
};

function embeddingRequestByteLength(input: string[]): number {
  return Buffer.byteLength(
    JSON.stringify({ model: embeddingIdentity.embeddingModel, input }),
    "utf8",
  );
}

const enrichmentIdentity = {
  ...embeddingIdentity,
  extractionModel: "test-extraction",
  extractionFingerprint: "test-extraction-fingerprint",
  extractionProviderName: "test-extraction-provider",
  extractionConnectionId,
  extractionInputCostMicrosPerMillion: 2_000_000,
  extractionOutputCostMicrosPerMillion: 5_000_000,
  extractionCurrency: "EUR",
};

function generationConfiguration(projectId: string, configFingerprint: string) {
  return {
    projectId,
    configFingerprint,
    embeddingModel: embeddingIdentity.embeddingModel,
    embeddingDimensions: embeddingIdentity.embeddingDimensions,
    extractionSchemaVersion: 1,
    promptVersion: "prompt-v1",
    routeSnapshot: {
      extraction: {
        connectionId: extractionConnectionId,
        connectionName: "Extraction provider",
        providerType: "openai_compatible" as const,
        endpoint: "https://extract.test/v1",
        modelId: "extraction-model-id",
        providerModelId: "test-extraction",
        embeddingDimensionMode: "native" as const,
      },
      embedding: {
        connectionId: embeddingConnectionId,
        connectionName: "Embedding provider",
        providerType: "openai_compatible" as const,
        endpoint: "https://embed.test/v1",
        modelId: "embedding-model-id",
        providerModelId: "test-embedding",
        embeddingDimensionMode: "native" as const,
      },
    },
  } satisfies GenerationConfiguration;
}

async function markLiveGenerationDocumentsReady(
  db: PrismaClient,
  projectId: string,
  generationId: string,
): Promise<void> {
  const documents = await db.document.findMany({
    where: { projectId },
    orderBy: { id: "asc" },
    select: { id: true, headCommitSha: true },
  });
  for (const document of documents) {
    await db.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId,
          documentId: document.id,
        },
      },
      data: {
        targetSha: document.headCommitSha,
        semanticIndexedSha: document.headCommitSha,
        graphIndexedSha: document.headCommitSha,
        status: "ready",
        failureKind: null,
        failureSummary: null,
        completedAt: new Date(),
      },
    });
  }
}

const successfulExtractionUsage = {
  inputTokens: 11,
  outputTokens: 7,
  cachedTokens: 0,
  totalTokens: 18,
  durationMs: 6,
};

const graphExtraction = {
  entities: [
    {
      key: "acme",
      name: "Acme GmbH",
      type: "Organization",
      aliases: ["ACME"],
      description: "A manufacturing company.",
      mentionText: "Acme",
      confidence: 0.95,
    },
    {
      key: "atlas",
      name: "Atlas Platform",
      type: "Product",
      aliases: ["Atlas"],
      description: "An operations platform.",
      mentionText: "Atlas",
      confidence: 0.9,
    },
  ],
  relations: [
    {
      sourceKey: "acme",
      targetKey: "atlas",
      type: "Uses Product",
      description: "Acme uses Atlas.",
      confidence: 0.85,
      validFrom: "2026-01-02T00:00:00.000Z",
      validTo: "2026-12-31T00:00:00.000Z",
    },
  ],
};

function embeddingProvider(
  embed: (input: string[]) => Promise<EmbeddingResult>,
): AiProvider {
  return {
    embeddingRequestByteLength,
    embed,
    async extract() {
      throw new Error("not used");
    },
  };
}

function enrichmentProvider(input: {
  extract?: (request: {
    documentId: string;
    chunkId: string;
    title: string;
    headingPath: string[];
    text: string;
  }) => Promise<ExtractionResult>;
  embed?: (values: string[]) => Promise<EmbeddingResult>;
}): AiProvider {
  return {
    embeddingRequestByteLength,
    embed:
      input.embed ??
      (async (values) => ({
        vectors: values.map(() => Array(1536).fill(0.25) as number[]),
        usage: {
          inputTokens: values.length,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: values.length,
          durationMs: 4,
        },
      })),
    extract:
      input.extract ??
      (async () => ({
        data: graphExtraction,
        usage: successfulExtractionUsage,
      })),
  };
}

function extractionBatch(
  firstEntity: number,
  entityCount: number,
  relationCount: number,
): ExtractionResponse {
  const entities = Array.from({ length: entityCount }, (_, index) => ({
    key: `entity-${firstEntity + index}`,
    name: `Entity ${firstEntity + index}`,
    type: "Concept",
    aliases: [],
    description: null,
    mentionText: `Entity ${firstEntity + index}`,
    confidence: 0.8,
  }));
  return {
    entities,
    relations: Array.from({ length: relationCount }, (_, index) => ({
      sourceKey: entities[index % entities.length]!.key,
      targetKey: entities[(index + 1) % entities.length]!.key,
      type: `Relation ${firstEntity}-${index}`,
      description: `Evidence ${firstEntity}-${index}`,
      confidence: 0.75,
      validFrom: null,
      validTo: null,
    })),
  };
}

async function replaceWithTwoEnrichmentChunks(
  db: PrismaClient,
  input: { projectId: string; documentId: string; sourceCommitSha: string },
) {
  await db.documentSearchChunk.deleteMany({
    where: { documentId: input.documentId },
  });
  const chunks = [
    "First bounded graph chunk.",
    "Second bounded graph chunk.",
  ].map((content, ordinal) => ({
    id: createHash("sha256")
      .update(`enrichment-chunk-${input.documentId}-${ordinal}`)
      .digest("hex"),
    projectId: input.projectId,
    documentId: input.documentId,
    ordinal,
    sourceCommitSha: input.sourceCommitSha,
    contentHash: createHash("sha256").update(content).digest("hex"),
    headingPath: ["Graph Source", `Section ${ordinal + 1}`],
    content,
  }));
  await db.documentSearchChunk.createMany({ data: chunks });
  return chunks;
}

async function makeGenerationDocument(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    sourceCommitSha: string;
    configFingerprint: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
  },
) {
  const generation = await db.knowledgeGeneration.create({
    data: {
      projectId: input.projectId,
      configFingerprint: input.configFingerprint,
      embeddingModel: input.embeddingModel ?? embeddingIdentity.embeddingModel,
      embeddingDimensions:
        input.embeddingDimensions ?? embeddingIdentity.embeddingDimensions,
      extractionSchemaVersion: 1,
      promptVersion: "prompt-v1",
      status: "building",
    },
  });
  await db.knowledgeGenerationDocument.create({
    data: {
      generationId: generation.id,
      documentId: input.documentId,
      projectId: input.projectId,
      targetSha: input.sourceCommitSha,
      configFingerprint: input.configFingerprint,
      status: "processing",
    },
  });
  return generation;
}

async function seedRawEmbedding(
  db: PrismaClient,
  input: {
    projectId: string;
    generationId: string;
    ownerId: string;
    contentHash: string;
    configFingerprint: string;
    model: string;
    vector: number[];
  },
) {
  const sqlVector = pgvector.toSql(input.vector);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeEmbedding"
      ("id", "projectId", "generationId", "ownerType", "ownerId",
       "contentHash", "configFingerprint", "model",
       "embeddingDimensions", "embedding", "createdAt")
    VALUES
      (${randomUUID()}::uuid, ${input.projectId}::uuid,
       ${input.generationId}::uuid, 'document_chunk', ${input.ownerId},
       ${input.contentHash}, ${input.configFingerprint}, ${input.model},
       ${input.vector.length}, ${sqlVector}::vector, now())
  `);
}

async function setupEmbeddingDocument(
  suffix: string,
  configFingerprint = "embedding-config",
) {
  const { caller, project } = await setupEditor(`embedding-${suffix}`);
  const document = await caller.document.create({
    projectId: project.id,
    folderPath: [],
    title: "Embedding Source",
    contentJson: parseDocumentBody(
      "# Embedding Source\n\nIntro text.\n\n## Runbook\n\nRotate the credential.\n",
    ),
  });
  const db = getPrisma();
  const context = knowledgeSystemContextForTests();
  await syncDocumentKeywordIndex(context, db, {
    projectId: project.id,
    documentId: document.id,
    sourceCommitSha: document.headCommitSha,
    pathAtSha: document.path,
  });
  const generation = await makeGenerationDocument(db, {
    projectId: project.id,
    documentId: document.id,
    sourceCommitSha: document.headCommitSha,
    configFingerprint,
  });
  return { context, db, document, generation, project };
}

async function setupEnrichmentDocument(suffix: string) {
  const { caller, editor, project } = await setupEditor(`enrichment-${suffix}`);
  const document = await caller.document.create({
    projectId: project.id,
    folderPath: [],
    title: "Graph Source",
    contentJson: parseDocumentBody(
      "# Graph Source\n\nAcme uses Atlas for operations.\n",
    ),
  });
  const db = getPrisma();
  const context = knowledgeSystemContextForTests();
  await syncDocumentKeywordIndex(context, db, {
    projectId: project.id,
    documentId: document.id,
    sourceCommitSha: document.headCommitSha,
    pathAtSha: document.path,
  });
  const generation = await makeGenerationDocument(db, {
    projectId: project.id,
    documentId: document.id,
    sourceCommitSha: document.headCommitSha,
    configFingerprint: `enrichment-config-${suffix}`,
  });
  return { caller, context, db, document, editor, generation, project };
}

let knowledgeQueue: FakeJobQueue;

describe("local knowledge indexing", () => {
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    knowledgeQueue = new FakeJobQueue();
    setJobQueueForTests(knowledgeQueue);
    await resetDb();
  });

  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it.each(["document", "folder", "reconciliation", "building"] as const)(
    "preserves completed AI indexing after a %s move",
    async (kind) => {
      const { caller, context, db, document, project, generation } =
        await setupEnrichmentDocument(`move-${kind}`);
      if (kind === "building") {
        await caller.document.create({
          projectId: project.id,
          folderPath: [],
          title: "Unfinished source",
          contentJson: parseDocumentBody("Still needs indexing"),
        });
      }
      const input = {
        projectId: project.id,
        documentId: document.id,
        generationId: generation.id,
        configFingerprint: generation.configFingerprint,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
        ...enrichmentIdentity,
      };
      await processGenerationDocument(
        context,
        db,
        enrichmentProvider({}),
        input,
      );
      const before = await db.knowledgeGenerationDocument.findFirstOrThrow({
        where: { generationId: generation.id, documentId: document.id },
      });
      const mentions = await db.entityMention.findMany({
        where: { documentId: document.id },
      });
      const evidence = await db.relationEvidence.findMany({
        where: { documentId: document.id },
      });
      expect(mentions.length).toBeGreaterThan(0);
      expect(evidence.length).toBeGreaterThan(0);
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Destination",
      });
      await caller.document.move({
        projectId: project.id,
        documentId: document.id,
        folderPath: ["destination"],
      });
      if (kind === "folder") {
        await caller.folder.rename({
          projectId: project.id,
          path: ["destination"],
          name: "Renamed",
        });
      }
      const moved = await db.document.findUniqueOrThrow({
        where: { id: document.id },
      });
      const payload = {
        ...input,
        sourceCommitSha: moved.headCommitSha,
        pathAtSha: moved.path,
      };
      if (kind === "building") {
        await resumeGenerationBuild(context, db, {
          projectId: project.id,
          generationId: generation.id,
          configFingerprint: generation.configFingerprint,
        });
      }
      if (kind === "reconciliation") {
        await reconcileProjectKnowledge(context, db, project.id);
      }
      expect(await syncDocumentKeywordIndex(context, db, payload)).toEqual({
        outcome: "indexed",
      });
      expect(
        await recordDocumentChangeForGenerations(context, db, payload),
      ).toBe(0);
      expect(
        await db.knowledgeGenerationDocument.findFirstOrThrow({
          where: { generationId: generation.id, documentId: document.id },
        }),
      ).toMatchObject({
        status: "ready",
        targetSha: moved.headCommitSha,
        semanticIndexedSha: moved.headCommitSha,
        graphIndexedSha: moved.headCommitSha,
        attempts: before.attempts,
        completedAt: before.completedAt,
      });
      const chunks = await db.documentSearchChunk.findMany({
        where: { documentId: document.id },
      });
      for (const chunk of chunks) {
        expect(chunk.sourceCommitSha).toBe(moved.headCommitSha);
        expect(
          await db.knowledgeEmbedding.count({
            where: {
              generationId: generation.id,
              ownerType: "document_chunk",
              ownerId: chunk.id,
            },
          }),
        ).toBe(1);
      }
      const currentMentions = await db.entityMention.findMany({
        where: { documentId: document.id },
      });
      const currentEvidence = await db.relationEvidence.findMany({
        where: { documentId: document.id },
      });
      for (const [current, rows] of [
        [currentMentions, mentions],
        [currentEvidence, evidence],
      ] as const) {
        expect(current).toHaveLength(rows.length);
        for (const row of current) {
          expect(
            rows.some(
              (old) =>
                old.id === row.id &&
                old.recordedAt.getTime() === row.recordedAt.getTime(),
            ),
          ).toBe(true);
          expect(row.sourceCommitSha).toBe(moved.headCommitSha);
          expect(chunks.some((chunk) => chunk.id === row.sourceChunkId)).toBe(
            true,
          );
          expect(row.invalidatedAt).toBeNull();
        }
      }
      const extract = vi.fn<AiProvider["extract"]>();
      const embed = vi.fn<AiProvider["embed"]>();
      await processGenerationDocument(
        context,
        db,
        enrichmentProvider({ extract, embed }),
        payload,
      );
      expect(extract).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      // Duplicate deliveries must keep the carried graph evidence live.
      await syncDocumentKeywordIndex(context, db, payload);
      expect(
        await recordDocumentChangeForGenerations(context, db, payload),
      ).toBe(0);
    },
  );

  it("preserves completed AI indexing after a header-only rewrite", async () => {
    const { context, db, document, editor, project, generation } =
      await setupEnrichmentDocument("header-rewrite");
    const input = {
      projectId: project.id,
      documentId: document.id,
      generationId: generation.id,
      configFingerprint: generation.configFingerprint,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      ...enrichmentIdentity,
    };
    await processGenerationDocument(context, db, enrichmentProvider({}), input);
    const before = await db.knowledgeGenerationDocument.findFirstOrThrow({
      where: { generationId: generation.id, documentId: document.id },
    });
    const mentions = await db.entityMention.findMany({
      where: { documentId: document.id },
    });
    expect(mentions.length).toBeGreaterThan(0);

    // The same body in the pre-authorship YAML format, as an older Weaver wrote it.
    await withProjectRepo(project.id, async (repo) => {
      const { meta, body } = parseDocumentFile(
        await repo.readFileFromWorktree(document.path),
        "markdown",
      );
      await repo.writeFileAtomic(
        document.path,
        `---\nid: ${meta.id}\ntitle: ${JSON.stringify(meta.title)}\n` +
          `created: ${meta.created}\nupdated: ${meta.updated}\n---\n\n${body}`,
      );
      await repo.commitAll("update: old format", {
        name: "Editor",
        email: editor.email,
        userId: editor.id,
      });
    });
    await db.project.update({
      where: { id: project.id },
      data: { documentHeaderVersion: 1 },
    });
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 1,
    });
    const upgraded = await db.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(upgraded.headCommitSha).not.toBe(document.headCommitSha);
    const payload = {
      ...input,
      sourceCommitSha: upgraded.headCommitSha,
      pathAtSha: upgraded.path,
    };

    expect(await syncDocumentKeywordIndex(context, db, payload)).toEqual({
      outcome: "indexed",
    });
    expect(await recordDocumentChangeForGenerations(context, db, payload)).toBe(
      0,
    );
    expect(
      await db.knowledgeGenerationDocument.findFirstOrThrow({
        where: { generationId: generation.id, documentId: document.id },
      }),
    ).toMatchObject({
      status: "ready",
      targetSha: upgraded.headCommitSha,
      semanticIndexedSha: upgraded.headCommitSha,
      graphIndexedSha: upgraded.headCommitSha,
      attempts: before.attempts,
      completedAt: before.completedAt,
    });
    const currentMentions = await db.entityMention.findMany({
      where: { documentId: document.id },
    });
    expect(currentMentions).toHaveLength(mentions.length);
    for (const row of currentMentions) {
      expect(row.sourceCommitSha).toBe(upgraded.headCommitSha);
      expect(row.invalidatedAt).toBeNull();
    }
    const extract = vi.fn<AiProvider["extract"]>();
    const embed = vi.fn<AiProvider["embed"]>();
    await processGenerationDocument(
      context,
      db,
      enrichmentProvider({ extract, embed }),
      payload,
    );
    expect(extract).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("carries a moved chunk's vector forward when its recorded model name differs from the generation's but the fingerprint matches", async () => {
    const { caller, context, db, document, project, generation } =
      await setupEnrichmentDocument("move-model-name");
    const input = {
      projectId: project.id,
      documentId: document.id,
      generationId: generation.id,
      configFingerprint: generation.configFingerprint,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      ...enrichmentIdentity,
    };
    await processGenerationDocument(context, db, enrichmentProvider({}), input);
    expect(generation.embeddingModel).not.toBe("qwen/qwen3-embedding-4b");
    // Simulate a compatible embedding model recorded under another name.
    await db.$executeRaw`
      UPDATE "KnowledgeEmbedding"
      SET "model" = 'qwen/qwen3-embedding-4b'
      WHERE "generationId" = ${generation.id}::uuid
        AND "ownerType" = 'document_chunk'
    `;

    await caller.folder.create({
      projectId: project.id,
      parentPath: [],
      name: "Destination",
    });
    await caller.document.move({
      projectId: project.id,
      documentId: document.id,
      folderPath: ["destination"],
    });
    const moved = await db.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    const payload = {
      ...input,
      sourceCommitSha: moved.headCommitSha,
      pathAtSha: moved.path,
    };

    expect(await syncDocumentKeywordIndex(context, db, payload)).toEqual({
      outcome: "indexed",
    });

    const chunks = await db.documentSearchChunk.findMany({
      where: { documentId: document.id },
    });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.sourceCommitSha).toBe(moved.headCommitSha);
      const rows = await db.knowledgeEmbedding.findMany({
        where: {
          generationId: generation.id,
          ownerType: "document_chunk",
          ownerId: chunk.id,
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model).toBe("qwen/qwen3-embedding-4b");
    }
  });

  it("keeps move counters consistent with another document awaiting reindexing", async () => {
    const { caller, context, db, document, project, generation } =
      await setupEnrichmentDocument("move-counters");
    const input = {
      projectId: project.id,
      documentId: document.id,
      generationId: generation.id,
      configFingerprint: generation.configFingerprint,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      ...enrichmentIdentity,
    };
    await processGenerationDocument(context, db, enrichmentProvider({}), input);
    const other = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Other",
      contentJson: parseDocumentBody("Other content"),
    });
    const otherInput = {
      ...input,
      documentId: other.id,
      sourceCommitSha: other.headCommitSha,
      pathAtSha: other.path,
    };
    await syncDocumentKeywordIndex(context, db, otherInput);
    await recordDocumentChangeForGenerations(context, db, otherInput);
    await processGenerationDocument(
      context,
      db,
      enrichmentProvider({}),
      otherInput,
    );
    await caller.folder.create({
      projectId: project.id,
      parentPath: [],
      name: "Destination",
    });
    const moved = await caller.document.move({
      projectId: project.id,
      documentId: document.id,
      folderPath: ["destination"],
    });
    const edited = await caller.document.update({
      projectId: project.id,
      documentId: other.id,
      baseCommitSha: other.headCommitSha,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("Changed other content"),
      },
      changeSummary: "Change other source",
    });
    await syncDocumentKeywordIndex(context, db, {
      ...input,
      sourceCommitSha: moved.headCommitSha,
      pathAtSha: moved.path,
    });
    const editedInput = {
      ...otherInput,
      sourceCommitSha: edited.headCommitSha,
      pathAtSha: edited.path,
    };
    await syncDocumentKeywordIndex(context, db, editedInput);
    await recordDocumentChangeForGenerations(context, db, editedInput);
    expect(
      await db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: generation.id },
      }),
    ).toMatchObject({ documentReadyCount: 1, documentTotal: 2 });
  });

  it("restores canonical descriptions refreshed while a document move awaited sync", async () => {
    const { caller, context, db, document, project, generation } =
      await setupEnrichmentDocument("move-descriptions");
    const input = {
      projectId: project.id,
      documentId: document.id,
      generationId: generation.id,
      configFingerprint: generation.configFingerprint,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      ...enrichmentIdentity,
    };
    await processGenerationDocument(context, db, enrichmentProvider({}), input);
    const entity = await db.graphEntity.findFirstOrThrow({
      where: { projectId: project.id, canonicalName: "Acme GmbH" },
    });
    expect(entity.description).toBe("A manufacturing company.");
    await caller.folder.create({
      projectId: project.id,
      parentPath: [],
      name: "Destination",
    });
    const moved = await caller.document.move({
      projectId: project.id,
      documentId: document.id,
      folderPath: ["destination"],
    });
    await db.$transaction((tx) =>
      refreshEntityDescriptions(tx, {
        projectId: project.id,
        documentId: document.id,
      }),
    );
    expect(
      await db.graphEntity.findUniqueOrThrow({ where: { id: entity.id } }),
    ).toMatchObject({ description: null });
    const payload = {
      ...input,
      sourceCommitSha: moved.headCommitSha,
      pathAtSha: moved.path,
    };
    await syncDocumentKeywordIndex(context, db, payload);
    expect(
      await db.graphEntity.findUniqueOrThrow({ where: { id: entity.id } }),
    ).toMatchObject({ description: entity.description });
    expect(await recordDocumentChangeForGenerations(context, db, payload)).toBe(
      0,
    );
  });

  it.each([
    "body",
    "title",
    "unfinished",
    "missing vectors",
    "missing chunks",
  ] as const)(
    "reindexes moved documents with %s changes or incomplete indexes",
    async (change) => {
      const { caller, context, db, document, project, generation } =
        await setupEnrichmentDocument(
          `move-fallback-${change.replaceAll(" ", "-")}`,
        );
      const input = {
        projectId: project.id,
        documentId: document.id,
        generationId: generation.id,
        configFingerprint: generation.configFingerprint,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
        ...enrichmentIdentity,
      };
      if (change !== "unfinished")
        await processGenerationDocument(
          context,
          db,
          enrichmentProvider({}),
          input,
        );
      if (change === "body" || change === "title") {
        await caller.document.update({
          projectId: project.id,
          documentId: document.id,
          baseCommitSha: document.headCommitSha,
          ...(change === "title" ? { title: "Changed title" } : {}),
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody(
              change === "body"
                ? "Changed content"
                : "# Graph Source\n\nAcme uses Atlas for operations.\n",
            ),
          },
          changeSummary: "Change before move",
        });
      }
      if (change === "missing vectors")
        await db.knowledgeEmbedding.deleteMany({
          where: { generationId: generation.id, ownerType: "document_chunk" },
        });
      if (change === "missing chunks")
        await db.documentSearchChunk.deleteMany({
          where: { documentId: document.id },
        });
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Destination",
      });
      const moved = await caller.document.move({
        projectId: project.id,
        documentId: document.id,
        folderPath: ["destination"],
      });
      const payload = {
        ...input,
        sourceCommitSha: moved.headCommitSha,
        pathAtSha: moved.path,
      };
      await syncDocumentKeywordIndex(context, db, payload);
      expect(
        await recordDocumentChangeForGenerations(context, db, payload),
      ).toBe(1);
      const extract = vi.fn(async () => ({
        data: graphExtraction,
        usage: successfulExtractionUsage,
      }));
      await processGenerationDocument(
        context,
        db,
        enrichmentProvider({ extract }),
        payload,
      );
      expect(extract).toHaveBeenCalled();
      expect(
        await db.knowledgeGenerationDocument.findFirstOrThrow({
          where: { generationId: generation.id },
        }),
      ).toMatchObject({
        status: "ready",
        graphIndexedSha: moved.headCommitSha,
      });
    },
  );

  it.each(["validation", "source_missing"] as const)(
    "knowledge review: terminal keyword %s finishes the generation without provider work",
    async (failureKind) => {
      const fixture = await setupEnrichmentDocument(`keyword-${failureKind}`);
      const { context, db, document, project, generation } = fixture;
      await db.documentIndexState.update({
        where: { documentId: document.id },
        data: {
          status: "failed",
          failureKind,
          completedAt: new Date(),
          keywordIndexedSha: null,
        },
      });
      let calls = 0;
      const provider = enrichmentProvider({
        embed: async () => {
          calls++;
          throw new Error("must not call");
        },
      });
      expect(
        await processGenerationDocument(context, db, provider, {
          projectId: project.id,
          generationId: generation.id,
          documentId: document.id,
          sourceCommitSha: document.headCommitSha,
          pathAtSha: document.path,
          configFingerprint: generation.configFingerprint,
          ...enrichmentIdentity,
        }),
      ).toEqual({ outcome: "failed" });
      expect(calls).toBe(0);
      expect(
        await db.knowledgeGenerationDocument.findFirst({
          where: { generationId: generation.id },
        }),
      ).toMatchObject({ failureKind, completedAt: expect.any(Date) });
      expect(
        await db.knowledgeGeneration.findUnique({
          where: { id: generation.id },
        }),
      ).toMatchObject({ status: "active", documentFailedCount: 1 });
    },
  );

  it.each([false, true])(
    "knowledge review: provider failure terminates after its retry budget (%s)",
    async (retryable) => {
      const { context, db, document, project, generation } =
        await setupEnrichmentDocument(`provider-budget-${retryable}`);
      const input = {
        projectId: project.id,
        generationId: generation.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
        configFingerprint: generation.configFingerprint,
        ...enrichmentIdentity,
      };
      let calls = 0;
      const provider = enrichmentProvider({
        embed: async () => {
          calls++;
          throw new AiProviderError("Unavailable", {
            kind: "provider",
            retryable,
          });
        },
      });
      for (let attempt = 0; attempt < (retryable ? 5 : 0); attempt++) {
        await expect(
          processGenerationDocument(context, db, provider, input),
        ).rejects.toMatchObject({ retryable: true });
        await recordDocumentChangeForGenerations(context, db, input);
      }
      expect(
        await processGenerationDocument(context, db, provider, input),
      ).toEqual({ outcome: "failed" });
      await processGenerationDocument(context, db, provider, input);
      expect(calls).toBe(retryable ? 6 : 1);
      expect(
        await db.knowledgeGeneration.findUnique({
          where: { id: generation.id },
        }),
      ).toMatchObject({ status: "active", documentFailedCount: 1 });
      knowledgeQueue.jobs.length = 0;
      await reconcileProjectKnowledge(context, db, project.id);
      expect(
        knowledgeQueue.jobs.filter((job) => job.name === "document.ai-enrich"),
      ).toEqual([]);
    },
  );

  it("knowledge review: embeddings become available even when graph extraction fails", async () => {
    const { context, db, document, project, generation } =
      await setupEnrichmentDocument("semantic-independent");
    await processGenerationDocument(
      context,
      db,
      enrichmentProvider({
        extract: async () => {
          throw new AiProviderError("Invalid extraction", {
            kind: "validation",
            retryable: false,
          });
        },
      }),
      {
        projectId: project.id,
        generationId: generation.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
        configFingerprint: generation.configFingerprint,
        ...enrichmentIdentity,
      },
    );
    expect(
      await db.knowledgeGenerationDocument.findFirst({
        where: { generationId: generation.id },
      }),
    ).toMatchObject({
      semanticIndexedSha: document.headCommitSha,
      graphIndexedSha: null,
      status: "failed",
    });
    expect(
      await db.knowledgeEmbedding.count({
        where: { generationId: generation.id, ownerType: "document_chunk" },
      }),
    ).toBeGreaterThan(0);
  });

  it("knowledge review: save and delete prune obsolete chunks and embeddings", async () => {
    const { context, db, document, project, generation, caller } =
      await setupEnrichmentDocument("prune-projections");
    const input = {
      projectId: project.id,
      generationId: generation.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      configFingerprint: generation.configFingerprint,
      ...enrichmentIdentity,
    };
    await embedGenerationDocument(context, db, enrichmentProvider({}), input);
    expect(
      await db.knowledgeEmbedding.count({ where: { projectId: project.id } }),
    ).toBeGreaterThan(0);
    const saved = await caller.document.update({
      projectId: project.id,
      documentId: document.id,
      baseCommitSha: document.headCommitSha,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("Changed body"),
      },
      changeSummary: "Replace indexed content",
    });
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: saved.headCommitSha,
      pathAtSha: saved.path,
    });
    expect(
      await db.documentSearchChunk.count({
        where: {
          documentId: document.id,
          sourceCommitSha: document.headCommitSha,
        },
      }),
    ).toBe(0);
    expect(
      await db.knowledgeEmbedding.count({ where: { projectId: project.id } }),
    ).toBe(0);
    await recordDocumentChangeForGenerations(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: saved.headCommitSha,
      pathAtSha: saved.path,
    });
    await embedGenerationDocument(context, db, enrichmentProvider({}), {
      ...input,
      sourceCommitSha: saved.headCommitSha,
    });
    expect(
      await db.knowledgeEmbedding.count({ where: { projectId: project.id } }),
    ).toBeGreaterThan(0);
    await db.document.delete({ where: { id: document.id } });
    await deleteKnowledgeContent(context, db, {
      projectId: project.id,
      sourceType: "document",
      sourceId: document.id,
      sourceCommitSha: saved.headCommitSha,
    });
    expect(
      await db.knowledgeEmbedding.count({ where: { projectId: project.id } }),
    ).toBe(0);
    const freshQueue = new FakeJobQueue();
    setJobQueueForTests(freshQueue);
    await reconcileProjectKnowledge(context, db, project.id);
    expect(
      freshQueue.jobs.filter((job) => job.name === "content.delete"),
    ).toEqual([]);
  });

  it("knowledge review: failed generations expire without removing recent failures", async () => {
    const { context, db, project, generation } =
      await setupEnrichmentDocument("prune-failed");
    await db.knowledgeGeneration.update({
      where: { id: generation.id },
      data: {
        status: "failed",
        completedAt: new Date(Date.now() - 8 * 86400000),
      },
    });
    const recent = await db.knowledgeGeneration.create({
      data: {
        ...generationConfiguration(project.id, "recent-failed"),
        status: "failed",
        completedAt: new Date(),
      },
    });
    expect(await cleanupSupersededGenerations(context, db, project.id)).toBe(1);
    expect(
      await db.knowledgeGeneration.findUnique({ where: { id: generation.id } }),
    ).toBeNull();
    expect(
      await db.knowledgeGeneration.findUnique({ where: { id: recent.id } }),
    ).not.toBeNull();
  });

  it("knowledge review: empty documents retain keyword readiness without chunks", async () => {
    const { caller, project } = await setupEditor("empty-keyword");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Empty source",
      contentJson: parseDocumentBody(""),
    });
    const db = getPrisma();
    expect(
      await syncDocumentKeywordIndex(knowledgeSystemContextForTests(), db, {
        projectId: project.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
      }),
    ).toEqual({ outcome: "indexed" });
    expect(
      await db.documentSearchChunk.count({
        where: { documentId: document.id },
      }),
    ).toBe(0);
  });

  it("knowledge review: keyword publication waits through a long project publisher lock", async () => {
    const { context, db, project, document } =
      await setupEnrichmentDocument("long-project-lock");
    const acquired = deferred();
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${project.id}::uuid FOR UPDATE`;
        acquired.resolve();
        await new Promise((resolve) => setTimeout(resolve, 5500));
      },
      { timeout: 10000 },
    );
    await acquired.promise;
    const sync = syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    const results = await Promise.allSettled([blocker, sync]);
    expect(results[1]).toEqual({
      status: "fulfilled",
      value: { outcome: "indexed" },
    });
  });

  it("publishes deterministic chunks and full-text search for an exact document SHA", async () => {
    const { caller, project } = await setupEditor("document");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Operations Manual",
      contentJson: parseDocumentBody(
        "Introduction.\n\n## Deployment\n\nRotate the runbookneedle credential before release.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const payload = {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    };

    const source = await loadDocumentIndexSource(context, db, payload);
    expect(source?.title).toBe("Operations Manual");
    expect(source?.body).toContain("runbookneedle");
    await expect(
      syncDocumentKeywordIndex(context, db, payload),
    ).resolves.toMatchObject({ outcome: "indexed" });

    const state = await db.documentIndexState.findUnique({
      where: { documentId: document.id },
    });
    expect(state).toMatchObject({
      projectId: project.id,
      targetSha: document.headCommitSha,
      keywordIndexedSha: document.headCommitSha,
      status: "ready",
    });

    const navigationAnchors = await db.$queryRaw<
      Array<{ navigationAnchor: string | null }>
    >`SELECT "navigationAnchor" FROM "DocumentSearchChunk" WHERE "documentId" = ${document.id}::uuid ORDER BY "ordinal"`;
    expect(
      navigationAnchors.some(
        (row) => row.navigationAnchor === "section-deployment",
      ),
    ).toBe(true);

    const chunks = await db.documentSearchChunk.findMany({
      where: { documentId: document.id },
      orderBy: { ordinal: "asc" },
      select: {
        id: true,
        ordinal: true,
        sourceCommitSha: true,
        contentHash: true,
        headingPath: true,
        content: true,
      },
    });
    expect(chunks).toHaveLength(2);
    const deploymentChunk = chunks.find(
      (chunk) =>
        chunk.headingPath.join(" / ") === "Operations Manual / Deployment",
    );
    expect(deploymentChunk?.content).toContain("runbookneedle");
    expect(chunks.every((chunk) => /^[0-9a-f]{64}$/.test(chunk.id))).toBe(true);

    const fullTextHits = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "DocumentSearchChunk"
      WHERE "projectId" = ${project.id}::uuid
        AND "documentId" = ${document.id}::uuid
        AND "searchVector" @@ plainto_tsquery('simple', ${"runbookneedle"})
    `;
    expect(fullTextHits.map((hit) => hit.id)).toEqual([chunks[1]!.id]);

    // Title and heading words live only in headingPath and must be searchable.
    const headingHits = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "DocumentSearchChunk"
      WHERE "documentId" = ${document.id}::uuid
        AND "searchVector" @@ plainto_tsquery('simple', ${"Manual"})
      ORDER BY "ordinal"
    `;
    expect(headingHits.map((hit) => hit.id)).toEqual(
      chunks.map((chunk) => chunk.id),
    );
    const titleSearch = await caller.search.query({
      query: "Manual",
      limitPerGroup: 8,
    });
    expect(titleSearch.mode).toBe("keyword");
    expect(titleSearch.documents.map((item) => item.documentId)).toEqual([
      document.id,
    ]);

    await syncDocumentKeywordIndex(context, db, payload);
    expect(
      await db.documentSearchChunk.findMany({
        where: { documentId: document.id },
        orderBy: { ordinal: "asc" },
        select: {
          id: true,
          ordinal: true,
          sourceCommitSha: true,
          contentHash: true,
          headingPath: true,
          content: true,
        },
      }),
    ).toEqual(chunks);
  });

  it("flows an oversized fenced block through bounded enrichment requests", async () => {
    const { caller, project } = await setupEditor("oversized-fence");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Oversized Fence",
      contentJson: parseDocumentBody(
        `# Oversized Fence\n\n\`\`\`txt\n${"x".repeat(70_000)}\n\`\`\`\n`,
      ),
    });
    const db = getPrisma();
    const context = knowledgeSystemContextForTests();
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    const generation = await makeGenerationDocument(db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      configFingerprint: "oversized-fence-config",
    });
    const envelopes: number[] = [];
    const provider = enrichmentProvider({
      async extract(request) {
        envelopes.push(JSON.stringify(request).length);
        return {
          data: { entities: [], relations: [] },
          usage: successfulExtractionUsage,
        };
      },
    });

    await expect(
      enrichGenerationDocument(context, db, provider, {
        projectId: project.id,
        generationId: generation.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        configFingerprint: generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).resolves.toMatchObject({ outcome: "enriched" });

    expect(envelopes.length).toBeGreaterThan(1);
    expect(envelopes.every((length) => length <= 64_000)).toBe(true);
    expect(
      await db.documentSearchChunk.findMany({
        where: { documentId: document.id, supersededAt: null },
        select: { content: true },
      }),
    ).toSatisfy((chunks: Array<{ content: string }>) =>
      chunks.every((chunk) => chunk.content.length <= 9_000),
    );
  });

  it("publishes before a repository writer can commit a newer rename", async () => {
    const { caller, editor, project } = await setupEditor("writer-lock");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Locked Source",
      contentJson: parseDocumentBody(
        "# Locked Source\n\nRepository mutex marker.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const payload = {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    };
    const sourceCallbackReturned = deferred();
    const releaseSourceCall = deferred();
    const originalWithExistingProjectRepoReader =
      gitStore.withExistingProjectRepoReader;
    const sourceGate = vi
      .spyOn(gitStore, "withExistingProjectRepoReader")
      .mockImplementation(async (projectId, fn) => {
        const result = await originalWithExistingProjectRepoReader(
          projectId,
          fn,
        );
        if (projectId === project.id) {
          sourceCallbackReturned.resolve();
          await releaseSourceCall.promise;
        }
        return result;
      });

    const sync = syncDocumentKeywordIndex(context, db, payload);
    let stateBeforeRename: Awaited<
      ReturnType<typeof db.documentIndexState.findUnique>
    > = null;
    let renamedSha = "";
    try {
      await sourceCallbackReturned.promise;
      renamedSha = await gitStore.withProjectRepo(project.id, async (repo) => {
        await repo.mv(document.path, "locked-source-renamed.md");
        return repo.commitAll("external rename during indexing", {
          name: null,
          email: editor.email,
          userId: editor.id,
        });
      });
      stateBeforeRename = await db.documentIndexState.findUnique({
        where: { documentId: document.id },
      });
    } finally {
      releaseSourceCall.resolve();
      await sync;
      sourceGate.mockRestore();
    }

    expect(renamedSha).not.toBe(document.headCommitSha);
    expect(stateBeforeRename).toMatchObject({
      projectId: project.id,
      keywordIndexedSha: document.headCommitSha,
      status: "ready",
    });
  });

  it("indexes table definitions without publishing row data", async () => {
    const { caller, project } = await setupEditor("table");
    const ownerColumnId = randomUUID();
    const dateColumnId = randomUUID();
    const table = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Release Inventory",
      columns: [
        { id: ownerColumnId, name: "Service owner", type: "text" },
        { id: dateColumnId, name: "Launch date", type: "date" },
      ],
      rows: [
        {
          id: randomUUID(),
          cells: {
            [ownerColumnId]: "rowcellphantom",
            [dateColumnId]: "2026-08-29",
          },
        },
      ],
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const payload = {
      projectId: project.id,
      tableId: table.id,
      sourceCommitSha: table.headCommitSha,
      pathAtSha: table.path,
    };

    await expect(loadTableSearchSource(context, db, payload)).resolves.toEqual({
      title: "Release Inventory",
      schemaText: "Service owner (text)\nLaunch date (date)",
    });
    await expect(syncTableKeywordIndex(context, db, payload)).resolves.toEqual({
      outcome: "indexed",
    });

    const projection = await db.tableSearchProjection.findUnique({
      where: { tableId: table.id },
    });
    expect(projection).toMatchObject({
      projectId: project.id,
      sourceCommitSha: table.headCommitSha,
      title: "Release Inventory",
      schemaText: "Service owner (text)\nLaunch date (date)",
    });
    expect(projection?.schemaText).not.toContain("rowcellphantom");

    const rowTextHits = await db.$queryRaw<Array<{ tableId: string }>>`
      SELECT "tableId"
      FROM "TableSearchProjection"
      WHERE "projectId" = ${project.id}::uuid
        AND "searchVector" @@ plainto_tsquery('simple', ${"rowcellphantom"})
    `;
    expect(rowTextHits).toEqual([]);
  });

  it("loads a renamed document at its historical path but rejects a mismatched frontmatter ID", async () => {
    const { caller, project } = await setupEditor("historical");
    const original = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Original Name",
      contentJson: parseDocumentBody(
        "# Original Name\n\nHistorical source marker.\n",
      ),
    });
    const renamed = await caller.document.update({
      projectId: project.id,
      documentId: original.id,
      baseCommitSha: original.headCommitSha,
      title: "Renamed Source",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody(
          "# Renamed Source\n\nCurrent source marker.\n",
        ),
      },
      changeSummary: "Rename source",
    });
    expect(renamed.path).not.toBe(original.path);

    const db = getPrisma();
    const context = knowledgeSystemContextForTests();
    const historicalPayload = {
      projectId: project.id,
      documentId: original.id,
      sourceCommitSha: original.headCommitSha,
      pathAtSha: original.path,
    };
    const historicalSource = await loadDocumentIndexSource(
      context,
      db,
      historicalPayload,
    );
    expect(historicalSource?.title).toBe("Original Name");
    expect(historicalSource?.body).toContain("Historical source marker");
    await expect(
      syncDocumentKeywordIndex(context, db, historicalPayload),
    ).resolves.toEqual({ outcome: "stale" });
    expect(
      await db.documentIndexState.findUnique({
        where: { documentId: original.id },
      }),
    ).toBeNull();

    const other = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Other Source",
      contentJson: parseDocumentBody("# Other Source\n\nOther body.\n"),
    });
    const mismatchedPayload = {
      ...historicalPayload,
      documentId: other.id,
    };
    await expect(
      loadDocumentIndexSource(context, db, mismatchedPayload),
    ).resolves.toBeNull();
    await expect(
      syncDocumentKeywordIndex(context, db, mismatchedPayload),
    ).resolves.toEqual({ outcome: "missing" });
    expect(
      await db.documentSearchChunk.count({
        where: { documentId: other.id },
      }),
    ).toBe(0);
    expect(
      await db.documentIndexState.findUnique({
        where: { documentId: other.id },
      }),
    ).toBeNull();
  });

  it("returns missing without publishing when the exact Git path is absent", async () => {
    const { caller, project } = await setupEditor("missing");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Missing Source",
      contentJson: parseDocumentBody("# Missing Source\n\nBody.\n"),
    });
    const db = getPrisma();
    const context = knowledgeSystemContextForTests();
    const payload = {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: "not-present.md",
    };

    await expect(
      loadDocumentIndexSource(context, db, payload),
    ).resolves.toBeNull();
    await expect(
      syncDocumentKeywordIndex(context, db, payload),
    ).resolves.toEqual({ outcome: "missing" });
    expect(
      await db.documentSearchChunk.count({
        where: { documentId: document.id },
      }),
    ).toBe(0);
    expect(
      await db.documentIndexState.findUnique({
        where: { documentId: document.id },
      }),
    ).toBeNull();
  });

  it("rechecks locked project liveness before publishing derived document state", async () => {
    const { caller, project } = await setupEditor("project-delete");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Project Liveness",
      contentJson: parseDocumentBody(
        "# Project Liveness\n\nSoft delete marker.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const payload = {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    };
    const originalWithExistingProjectRepoReader =
      gitStore.withExistingProjectRepoReader;
    const livenessGate = vi
      .spyOn(gitStore, "withExistingProjectRepoReader")
      .mockImplementation(async (projectId, useRepo) => {
        await db.project.update({
          where: { id: project.id },
          data: { deletedAt: new Date() },
        });
        return originalWithExistingProjectRepoReader(projectId, useRepo);
      });

    let result: Awaited<ReturnType<typeof syncDocumentKeywordIndex>>;
    try {
      result = await syncDocumentKeywordIndex(context, db, payload);
    } finally {
      livenessGate.mockRestore();
    }

    expect(result).toEqual({ outcome: "missing" });
    expect(
      await db.documentSearchChunk.count({
        where: { documentId: document.id },
      }),
    ).toBe(0);
    expect(
      await db.documentIndexState.findUnique({
        where: { documentId: document.id },
      }),
    ).toBeNull();
  });

  it("reconciles only missing, stale, and orphan local projections", async () => {
    const { caller, project } = await setupEditor("reconcile-local");
    const missingDocument = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Missing Keyword State",
      contentJson: parseDocumentBody("# Missing\n\nBody.\n"),
    });
    const staleDocument = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Stale Keyword State",
      contentJson: parseDocumentBody("# Stale\n\nBody.\n"),
    });
    const currentDocument = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Current Keyword State",
      contentJson: parseDocumentBody("# Current\n\nBody.\n"),
    });
    const missingTable = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Missing Table Projection",
    });
    const currentTable = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Current Table Projection",
    });
    const orphanDocumentId = randomUUID();
    const orphanTableId = randomUUID();
    const db = getPrisma();
    await db.documentIndexState.createMany({
      data: [
        {
          documentId: staleDocument.id,
          projectId: project.id,
          targetSha: staleDocument.headCommitSha,
          keywordIndexedSha: "0".repeat(40),
          status: "ready",
        },
        {
          documentId: currentDocument.id,
          projectId: project.id,
          targetSha: currentDocument.headCommitSha,
          keywordIndexedSha: currentDocument.headCommitSha,
          status: "ready",
        },
        {
          documentId: orphanDocumentId,
          projectId: project.id,
          targetSha: "a".repeat(40),
          keywordIndexedSha: "a".repeat(40),
          status: "ready",
        },
      ],
    });
    await db.tableSearchProjection.createMany({
      data: [
        {
          tableId: currentTable.id,
          projectId: project.id,
          sourceCommitSha: currentTable.headCommitSha,
          title: currentTable.title,
          schemaText: "Name (text)",
        },
        {
          tableId: orphanTableId,
          projectId: project.id,
          sourceCommitSha: "b".repeat(40),
          title: "Orphan",
          schemaText: "Name (text)",
        },
      ],
    });
    knowledgeQueue.jobs.length = 0;

    await reconcileProjectKnowledge(
      knowledgeSystemContextForTests(),
      db,
      project.id,
    );

    expect(
      knowledgeQueue.jobs
        .filter((job) => job.name === "document.search-sync")
        .map((job) => job.data),
    ).toEqual(
      [missingDocument, staleDocument]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((document) => ({
          projectId: project.id,
          documentId: document.id,
          sourceCommitSha: document.headCommitSha,
          pathAtSha: document.path,
        })),
    );
    expect(
      knowledgeQueue.jobs
        .filter((job) => job.name === "table.search-sync")
        .map((job) => job.data),
    ).toEqual([
      {
        projectId: project.id,
        tableId: missingTable.id,
        sourceCommitSha: missingTable.headCommitSha,
        pathAtSha: missingTable.path,
      },
    ]);
    expect(
      knowledgeQueue.jobs
        .filter((job) => job.name === "content.delete")
        .map((job) => job.data),
    ).toEqual([
      {
        projectId: project.id,
        sourceType: "document",
        sourceId: orphanDocumentId,
        sourceCommitSha: "a".repeat(40),
      },
      {
        projectId: project.id,
        sourceType: "table",
        sourceId: orphanTableId,
        sourceCommitSha: "b".repeat(40),
      },
    ]);
  });

  it("reconciles active and building generation drift without touching current generation state", async () => {
    const { caller, project } = await setupEditor("reconcile-generation");
    const current = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Current Generation Document",
      contentJson: parseDocumentBody("# Current\n\nBody.\n"),
    });
    const stale = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Stale Generation Document",
      contentJson: parseDocumentBody("# Stale\n\nBody.\n"),
    });
    const db = getPrisma();
    await db.documentIndexState.createMany({
      data: [current, stale].map((document) => ({
        documentId: document.id,
        projectId: project.id,
        targetSha: document.headCommitSha,
        keywordIndexedSha: document.headCommitSha,
        status: "ready" as const,
      })),
    });
    const active = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "active-config",
        embeddingModel: "embedding-model",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "active",
      },
    });
    const building = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "building-config",
        embeddingModel: "embedding-model",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "building",
      },
    });
    const superseded = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "superseded-config",
        embeddingModel: "embedding-model",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "superseded",
      },
    });
    const orphanGenerationDocumentId = randomUUID();
    await db.knowledgeGenerationDocument.createMany({
      data: [
        {
          generationId: active.id,
          documentId: current.id,
          projectId: project.id,
          targetSha: current.headCommitSha,
          semanticIndexedSha: current.headCommitSha,
          graphIndexedSha: current.headCommitSha,
          configFingerprint: active.configFingerprint,
          status: "ready",
        },
        {
          generationId: active.id,
          documentId: stale.id,
          projectId: project.id,
          targetSha: "0".repeat(40),
          semanticIndexedSha: "0".repeat(40),
          graphIndexedSha: "0".repeat(40),
          configFingerprint: active.configFingerprint,
          status: "ready",
        },
        {
          generationId: building.id,
          documentId: current.id,
          projectId: project.id,
          targetSha: current.headCommitSha,
          semanticIndexedSha: current.headCommitSha,
          graphIndexedSha: current.headCommitSha,
          configFingerprint: building.configFingerprint,
          status: "ready",
        },
        {
          generationId: superseded.id,
          documentId: stale.id,
          projectId: project.id,
          targetSha: stale.headCommitSha,
          configFingerprint: superseded.configFingerprint,
          status: "pending",
        },
        {
          generationId: superseded.id,
          documentId: orphanGenerationDocumentId,
          projectId: project.id,
          targetSha: "c".repeat(40),
          configFingerprint: superseded.configFingerprint,
          status: "ready",
        },
      ],
    });
    knowledgeQueue.jobs.length = 0;

    await reconcileProjectKnowledge(
      knowledgeSystemContextForTests(),
      db,
      project.id,
    );

    expect(knowledgeQueue.jobs).toHaveLength(3);
    expect(knowledgeQueue.jobs).toEqual(
      expect.arrayContaining([
        {
          name: "document.ai-enrich",
          data: {
            projectId: project.id,
            documentId: stale.id,
            sourceCommitSha: stale.headCommitSha,
            pathAtSha: stale.path,
            generationId: active.id,
            configFingerprint: active.configFingerprint,
          },
        },
        {
          name: "document.ai-enrich",
          data: {
            projectId: project.id,
            documentId: stale.id,
            sourceCommitSha: stale.headCommitSha,
            pathAtSha: stale.path,
            generationId: building.id,
            configFingerprint: building.configFingerprint,
          },
        },
        {
          name: "content.delete",
          data: {
            projectId: project.id,
            sourceType: "document",
            sourceId: orphanGenerationDocumentId,
            sourceCommitSha: "c".repeat(40),
          },
        },
      ]),
    );
  });

  it("requeues repairable generation work but not processing or controlled failures", async () => {
    const { caller, project } = await setupEditor("reconcile-status-matrix");
    const fixtures = await Promise.all(
      [
        "Missing",
        "Stale Source",
        "Stale Config",
        "Pending",
        "Processing",
        "Failed",
        "Blocked Configuration",
      ].map((title) =>
        caller.document.create({
          projectId: project.id,
          folderPath: [],
          title,
          contentJson: parseDocumentBody(`# ${title}\n\nBody.\n`),
        }),
      ),
    );
    const missing = fixtures[0]!;
    const staleSource = fixtures[1]!;
    const staleConfig = fixtures[2]!;
    const pending = fixtures[3]!;
    const controlled = fixtures.slice(4);
    const db = getPrisma();
    await db.documentIndexState.createMany({
      data: fixtures.map((document) => ({
        documentId: document.id,
        projectId: project.id,
        targetSha: document.headCommitSha,
        keywordIndexedSha: document.headCommitSha,
        status: "ready" as const,
      })),
    });
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "status-matrix-config",
        embeddingModel: "embedding-model",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "active",
      },
    });
    await db.knowledgeGenerationDocument.createMany({
      data: [
        {
          generationId: generation.id,
          documentId: staleSource.id,
          projectId: project.id,
          targetSha: "0".repeat(40),
          configFingerprint: generation.configFingerprint,
          status: "pending",
        },
        {
          generationId: generation.id,
          documentId: staleConfig.id,
          projectId: project.id,
          targetSha: staleConfig.headCommitSha,
          configFingerprint: "old-config",
          status: "failed",
        },
        {
          generationId: generation.id,
          documentId: pending.id,
          projectId: project.id,
          targetSha: pending.headCommitSha,
          configFingerprint: generation.configFingerprint,
          status: "pending",
        },
        ...controlled.map((document, index) => ({
          generationId: generation.id,
          documentId: document.id,
          projectId: project.id,
          targetSha: document.headCommitSha,
          configFingerprint: generation.configFingerprint,
          status: ["processing", "failed", "blocked_configuration"][index] as
            "processing" | "failed" | "blocked_configuration",
          lastAttemptAt: index === 0 ? new Date() : null,
        })),
      ],
    });
    knowledgeQueue.jobs.length = 0;

    await reconcileProjectKnowledge(
      knowledgeSystemContextForTests(),
      db,
      project.id,
    );

    expect(knowledgeQueue.jobs).toEqual(
      [missing, staleSource, staleConfig, pending]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((document) => ({
          name: "document.ai-enrich" as const,
          data: {
            projectId: project.id,
            documentId: document.id,
            sourceCommitSha: document.headCommitSha,
            pathAtSha: document.path,
            generationId: generation.id,
            configFingerprint: generation.configFingerprint,
          },
        })),
    );
    const recoveryQueue = new FakeJobQueue();
    setJobQueueForTests(recoveryQueue);
    await reconcileProjectKnowledge(
      knowledgeSystemContextForTests(),
      db,
      project.id,
      { liveConfigFingerprint: generation.configFingerprint },
    );
    expect(
      recoveryQueue.jobs.some(
        (job) =>
          job.name === "document.ai-enrich" &&
          job.data.documentId === fixtures[6]!.id,
      ),
    ).toBe(true);
    expect(
      (
        await db.knowledgeGenerationDocument.findUniqueOrThrow({
          where: {
            generationId_documentId: {
              generationId: generation.id,
              documentId: fixtures[6]!.id,
            },
          },
        })
      ).status,
    ).toBe("pending");
  });

  it("pages more than 200 generation-only orphans with bounded SQL and no duplicate cleanup", async () => {
    const project = await makeProject("Generation orphan paging");
    const db = getPrisma();
    const firstGeneration = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "orphan-page-first",
        embeddingModel: "embedding-model",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "superseded",
      },
    });
    const secondGeneration = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "orphan-page-second",
        embeddingModel: "embedding-model",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "superseded",
      },
    });
    const orphanIds = Array.from({ length: 205 }, () => randomUUID()).sort();
    await db.knowledgeGenerationDocument.createMany({
      data: orphanIds.flatMap((documentId) => [
        {
          generationId: firstGeneration.id,
          documentId,
          projectId: project.id,
          targetSha: "d".repeat(40),
          configFingerprint: firstGeneration.configFingerprint,
          status: "ready" as const,
        },
        {
          generationId: secondGeneration.id,
          documentId,
          projectId: project.id,
          targetSha: "e".repeat(40),
          configFingerprint: secondGeneration.configFingerprint,
          status: "ready" as const,
        },
      ]),
    });
    knowledgeQueue.jobs.length = 0;
    const queries: string[] = [];
    const queryDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
      log: [{ emit: "event", level: "query" }],
    });
    queryDb.$on("query", (event) => {
      queries.push(event.query);
    });

    try {
      await reconcileProjectKnowledge(
        knowledgeSystemContextForTests(),
        queryDb,
        project.id,
      );
    } finally {
      await queryDb.$disconnect();
    }

    const deletionIds = knowledgeQueue.jobs
      .filter((job) => job.name === "content.delete")
      .map((job) => job.data.sourceId);
    expect(deletionIds).toHaveLength(205);
    expect(new Set(deletionIds).size).toBe(205);
    expect([...deletionIds].sort()).toEqual(orphanIds);
    const pageQueries = queries.filter((query) =>
      query.includes('"KnowledgeGenerationDocument"'),
    );
    expect(pageQueries.length).toBeGreaterThanOrEqual(2);
    expect(pageQueries.every((query) => /\bLIMIT\b/i.test(query))).toBe(true);
  });

  it("reuses document vectors across generations that share the index fingerprint", async () => {
    const fixture = await setupEmbeddingDocument("embedding-route-reuse");
    const input = {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    };
    const provider = embeddingProvider(async (texts) => ({
      vectors: texts.map(() => Array(1536).fill(0.2) as number[]),
      usage: successfulExtractionUsage,
    }));
    await embedGenerationDocument(fixture.context, fixture.db, provider, input);
    const next = await makeGenerationDocument(fixture.db, {
      ...input,
      configFingerprint: input.configFingerprint,
    });
    await expect(
      embedGenerationDocument(
        fixture.context,
        fixture.db,
        embeddingProvider(async () => {
          throw new Error("Compatible vectors should be reused");
        }),
        {
          ...input,
          generationId: next.id,
          configFingerprint: next.configFingerprint,
        },
      ),
    ).resolves.toMatchObject({
      outcome: "embedded",
      embeddedCount: 0,
      reusedCount: 2,
    });
  });

  it("persists generation-scoped vectors and reuses only compatible content", async () => {
    const fixture = await setupEmbeddingDocument("persist-reuse");
    const calls: string[][] = [];
    const provider = embeddingProvider(async (input) => {
      calls.push(input);
      return {
        vectors: input.map((_, index) =>
          Array.from({ length: 1536 }, () => (index + 1) / 10),
        ),
        usage: {
          inputTokens: 10,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 10,
          durationMs: 12,
        },
      };
    });
    const input = {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    };

    await expect(
      embedGenerationDocument(fixture.context, fixture.db, provider, input),
    ).resolves.toMatchObject({
      outcome: "embedded",
      embeddedCount: 2,
      reusedCount: 0,
    });

    const stored = await fixture.db.$queryRaw<
      Array<{
        generationId: string;
        ownerId: string;
        contentHash: string;
        configFingerprint: string;
        model: string;
        embeddingDimensions: number;
        vectorDimensions: number;
      }>
    >`
      SELECT "generationId", "ownerId", "contentHash", "configFingerprint",
             "model", "embeddingDimensions", vector_dims("embedding") AS "vectorDimensions"
      FROM "KnowledgeEmbedding"
      WHERE "projectId" = ${fixture.project.id}::uuid
        AND "generationId" = ${fixture.generation.id}::uuid
      ORDER BY "ownerId" ASC
    `;
    expect(stored).toHaveLength(2);
    expect(
      stored.every(
        (row) =>
          row.generationId === fixture.generation.id &&
          row.configFingerprint === fixture.generation.configFingerprint &&
          row.model === embeddingIdentity.embeddingModel &&
          row.embeddingDimensions === 1536 &&
          row.vectorDimensions === 1536,
      ),
    ).toBe(true);
    expect(calls).toHaveLength(1);

    expect(
      await fixture.db.aiUsage.findMany({
        where: { projectId: fixture.project.id },
        select: {
          operation: true,
          documentId: true,
          provider: true,
          connectionId: true,
          model: true,
          configFingerprint: true,
          inputTokens: true,
          outputTokens: true,
          durationMs: true,
          outcome: true,
          costMicros: true,
          currency: true,
        },
      }),
    ).toEqual([
      {
        operation: "document_chunk_embedding",
        documentId: fixture.document.id,
        provider: "test-provider",
        connectionId: embeddingConnectionId,
        model: "test-embedding",
        configFingerprint: fixture.generation.configFingerprint,
        inputTokens: 10,
        outputTokens: 0,
        durationMs: 12,
        outcome: "success",
        costMicros: 10n,
        currency: "USD",
      },
    ]);

    const nextGeneration = await makeGenerationDocument(fixture.db, {
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
    });
    await expect(
      embedGenerationDocument(fixture.context, fixture.db, provider, {
        ...input,
        generationId: nextGeneration.id,
      }),
    ).resolves.toMatchObject({
      outcome: "embedded",
      embeddedCount: 0,
      reusedCount: 2,
    });

    expect(calls).toHaveLength(1);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: nextGeneration.id },
      }),
    ).toBe(2);
    expect(
      await fixture.db.aiUsage.count({
        where: { projectId: fixture.project.id },
      }),
    ).toBe(1);
  });

  it("stores embedding timestamps as UTC wall-clock like Prisma writes", async () => {
    const fixture = await setupEmbeddingDocument("embedding-utc");
    const provider = embeddingProvider(async (input) => ({
      vectors: input.map(() => Array.from({ length: 1536 }, () => 0.1)),
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 10,
        durationMs: 12,
      },
    }));

    await embedGenerationDocument(fixture.context, fixture.db, provider, {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    });

    const rows = await fixture.db.knowledgeEmbedding.findMany({
      where: { generationId: fixture.generation.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expectRecentUtc(row.createdAt);
  });

  it("does not reuse vectors with mismatched project, config, or dimensions", async () => {
    const fixture = await setupEmbeddingDocument(
      "compatibility",
      "target-config",
    );
    const [chunk] = await fixture.db.documentSearchChunk.findMany({
      where: {
        projectId: fixture.project.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
      },
      orderBy: { ordinal: "asc" },
      take: 1,
    });
    expect(chunk).toBeDefined();
    await fixture.db.documentSearchChunk.deleteMany({
      where: {
        documentId: fixture.document.id,
        id: { not: chunk!.id },
      },
    });

    const configMismatch = await fixture.db.knowledgeGeneration.create({
      data: {
        projectId: fixture.project.id,
        configFingerprint: "other-config",
        embeddingModel: embeddingIdentity.embeddingModel,
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "superseded",
      },
    });
    const dimensionMismatch = await fixture.db.knowledgeGeneration.create({
      data: {
        projectId: fixture.project.id,
        configFingerprint: "target-config",
        embeddingModel: embeddingIdentity.embeddingModel,
        embeddingDimensions: 3,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "superseded",
      },
    });
    await seedRawEmbedding(fixture.db, {
      projectId: fixture.project.id,
      generationId: configMismatch.id,
      ownerId: chunk!.id,
      contentHash: chunk!.contentHash,
      configFingerprint: "other-config",
      model: embeddingIdentity.embeddingModel,
      vector: Array.from({ length: 1536 }, () => 0.1),
    });
    await seedRawEmbedding(fixture.db, {
      projectId: fixture.project.id,
      generationId: dimensionMismatch.id,
      ownerId: chunk!.id,
      contentHash: chunk!.contentHash,
      configFingerprint: "target-config",
      model: embeddingIdentity.embeddingModel,
      vector: [0.1, 0.2, 0.3],
    });
    const otherProject = await makeProject("Embedding isolation");
    const otherGeneration = await fixture.db.knowledgeGeneration.create({
      data: {
        projectId: otherProject.id,
        configFingerprint: "target-config",
        embeddingModel: embeddingIdentity.embeddingModel,
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "superseded",
      },
    });
    await seedRawEmbedding(fixture.db, {
      projectId: otherProject.id,
      generationId: otherGeneration.id,
      ownerId: chunk!.id,
      contentHash: chunk!.contentHash,
      configFingerprint: "target-config",
      model: embeddingIdentity.embeddingModel,
      vector: Array.from({ length: 1536 }, () => 0.3),
    });
    let providerCalls = 0;
    const provider = embeddingProvider(async (input) => {
      providerCalls += 1;
      return {
        vectors: input.map(() => Array(1536).fill(0.9) as number[]),
        usage: {
          inputTokens: 1,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 1,
          durationMs: 1,
        },
      };
    });

    await embedGenerationDocument(fixture.context, fixture.db, provider, {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: "target-config",
      ...embeddingIdentity,
    });

    expect(providerCalls).toBe(1);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(1);
  });

  it("reuses vectors recorded under another embedding model name with the same fingerprint", async () => {
    const fixture = await setupEmbeddingDocument(
      "compatible-name",
      "shared-space",
    );
    const [chunk] = await fixture.db.documentSearchChunk.findMany({
      where: {
        projectId: fixture.project.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
      },
      orderBy: { ordinal: "asc" },
      take: 1,
    });
    await fixture.db.documentSearchChunk.deleteMany({
      where: { documentId: fixture.document.id, id: { not: chunk!.id } },
    });
    const otherName = await fixture.db.knowledgeGeneration.create({
      data: {
        projectId: fixture.project.id,
        configFingerprint: "shared-space",
        embeddingModel: "qwen/qwen3-embedding-4b",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "superseded",
      },
    });
    await seedRawEmbedding(fixture.db, {
      projectId: fixture.project.id,
      generationId: otherName.id,
      ownerId: chunk!.id,
      contentHash: chunk!.contentHash,
      configFingerprint: "shared-space",
      model: "qwen/qwen3-embedding-4b",
      vector: Array.from({ length: 1536 }, () => 0.4),
    });

    await expect(
      embedGenerationDocument(
        fixture.context,
        fixture.db,
        embeddingProvider(async () => {
          throw new Error("Compatible vectors should be reused");
        }),
        {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          sourceCommitSha: fixture.document.headCommitSha,
          configFingerprint: "shared-space",
          ...embeddingIdentity,
        },
      ),
    ).resolves.toMatchObject({ outcome: "embedded", reusedCount: 1 });
  });

  it("records provider and validation failures without persisting vectors", async () => {
    const fixture = await setupEmbeddingDocument("failure-outcomes");
    const input = {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    };
    const providerFailure = embeddingProvider(async () => {
      throw new AiProviderError("provider unavailable", {
        kind: "provider",
        retryable: true,
      });
    });

    await expect(
      embedGenerationDocument(
        fixture.context,
        fixture.db,
        providerFailure,
        input,
      ),
    ).rejects.toMatchObject({ retryable: true });

    const validationFailure = embeddingProvider(async (providerInput) => ({
      vectors: providerInput.map(() => [Number.NaN]),
      usage: {
        inputTokens: 3,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 3,
        durationMs: 5,
      },
    }));
    await expect(
      embedGenerationDocument(
        fixture.context,
        fixture.db,
        validationFailure,
        input,
      ),
    ).rejects.toMatchObject({ retryable: false });

    const usageRows = await fixture.db.aiUsage.findMany({
      where: { projectId: fixture.project.id },
      orderBy: { createdAt: "asc" },
      select: {
        outcome: true,
        inputTokens: true,
        outputTokens: true,
        durationMs: true,
      },
    });
    expect(usageRows).toEqual([
      {
        outcome: "provider_failure",
        inputTokens: null,
        outputTokens: null,
        durationMs: usageRows[0]!.durationMs,
      },
      {
        outcome: "validation_failure",
        inputTokens: 3,
        outputTokens: 0,
        durationMs: 5,
      },
    ]);
    expect(usageRows[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
  });

  it("discards a provider result when the document becomes stale and accounts for it", async () => {
    const fixture = await setupEmbeddingDocument("stale-discard");
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const provider = embeddingProvider(async (input) => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return {
        vectors: input.map(() => Array(1536).fill(0.4) as number[]),
        usage: {
          inputTokens: 4,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 4,
          durationMs: 8,
        },
      };
    });
    const embedding = embedGenerationDocument(
      fixture.context,
      fixture.db,
      provider,
      {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...embeddingIdentity,
      },
    );

    await providerStarted.promise;
    await fixture.db.document.update({
      where: { id: fixture.document.id },
      data: { headCommitSha: "f".repeat(40) },
    });
    releaseProvider.resolve();

    await expect(embedding).resolves.toMatchObject({
      outcome: "stale",
      embeddedCount: 0,
      reusedCount: 0,
    });
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { projectId: fixture.project.id },
        select: { outcome: true, inputTokens: true },
      }),
    ).toEqual([{ outcome: "stale_discarded", inputTokens: 4 }]);
  });

  it("batches provider input at 32 chunks and 120 KiB of UTF-8 text", async () => {
    const fixture = await setupEmbeddingDocument("batch-limits");
    await fixture.db.documentSearchChunk.deleteMany({
      where: { documentId: fixture.document.id },
    });
    const contents = [
      ...Array.from({ length: 32 }, (_, index) =>
        String(index).padStart(2, "0").padEnd(1_000, "x"),
      ),
      "y".repeat(40_000),
      "z".repeat(30_000),
    ];
    await fixture.db.documentSearchChunk.createMany({
      data: contents.map((content, ordinal) => ({
        id: createHash("sha256").update(`batch-${ordinal}`).digest("hex"),
        projectId: fixture.project.id,
        documentId: fixture.document.id,
        ordinal,
        sourceCommitSha: fixture.document.headCommitSha,
        contentHash: createHash("sha256").update(content).digest("hex"),
        headingPath: ["Embedding Source"],
        content,
      })),
    });
    const batches: string[][] = [];
    const provider = embeddingProvider(async (input) => {
      batches.push(input);
      return {
        vectors: input.map(() => Array(1536).fill(0.6) as number[]),
        usage: {
          inputTokens: input.length,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: input.length,
          durationMs: 2,
        },
      };
    });

    await embedGenerationDocument(fixture.context, fixture.db, provider, {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    });

    expect(batches.map((batch) => batch.length)).toEqual([32, 2]);
    expect(
      batches.every(
        (batch) =>
          batch.length <= 32 &&
          batch.reduce(
            (total, content) => total + Buffer.byteLength(content, "utf8"),
            0,
          ) <=
            120 * 1_024,
      ),
    ).toBe(true);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(34);
  });

  it("splits multibyte embedding input before the provider request cap", async () => {
    const fixture = await setupEmbeddingDocument("batch-utf8");
    await fixture.db.documentSearchChunk.deleteMany({
      where: { documentId: fixture.document.id },
    });
    const contents = Array.from({ length: 6 }, (_, ordinal) =>
      `${ordinal}`.padEnd(8_000, "界"),
    );
    await fixture.db.documentSearchChunk.createMany({
      data: contents.map((content, ordinal) => ({
        id: createHash("sha256").update(`batch-utf8-${ordinal}`).digest("hex"),
        projectId: fixture.project.id,
        documentId: fixture.document.id,
        ordinal,
        sourceCommitSha: fixture.document.headCommitSha,
        contentHash: createHash("sha256").update(content).digest("hex"),
        headingPath: ["Embedding Source"],
        content,
      })),
    });
    const batches: string[][] = [];
    const provider = embeddingProvider(async (input) => {
      batches.push(input);
      return {
        vectors: input.map(() => Array(1536).fill(0.6) as number[]),
        usage: {
          inputTokens: input.length,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: input.length,
          durationMs: 2,
        },
      };
    });

    await embedGenerationDocument(fixture.context, fixture.db, provider, {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    });

    expect(batches.map((batch) => batch.length)).toEqual([5, 1]);
  });

  it("splits JSON-escaped embedding input before the provider request cap", async () => {
    const fixture = await setupEmbeddingDocument("batch-json-escaping");
    await fixture.db.documentSearchChunk.deleteMany({
      where: { documentId: fixture.document.id },
    });
    const contents = Array.from({ length: 13 }, () => '"'.repeat(9_000));
    await fixture.db.documentSearchChunk.createMany({
      data: contents.map((content, ordinal) => ({
        id: createHash("sha256")
          .update(`batch-json-escaping-${ordinal}`)
          .digest("hex"),
        projectId: fixture.project.id,
        documentId: fixture.document.id,
        ordinal,
        sourceCommitSha: fixture.document.headCommitSha,
        contentHash: createHash("sha256").update(content).digest("hex"),
        headingPath: ["Embedding Source"],
        content,
      })),
    });
    const batches: string[][] = [];
    const provider = embeddingProvider(async (input) => {
      batches.push(input);
      return {
        vectors: input.map(() => Array(1536).fill(0.6) as number[]),
        usage: {
          inputTokens: input.length,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: input.length,
          durationMs: 2,
        },
      };
    });

    await embedGenerationDocument(fixture.context, fixture.db, provider, {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    });

    expect(batches.map((batch) => batch.length)).toEqual([7, 6]);
    expect(
      batches.every(
        (batch) =>
          Buffer.byteLength(
            JSON.stringify({
              model: embeddingIdentity.embeddingModel,
              input: batch,
            }),
            "utf8",
          ) <=
          128 * 1_024,
      ),
    ).toBe(true);
  });

  it("splits an exact-limit batch before a dimensions-sending transport exceeds the cap", async () => {
    const fixture = await setupEmbeddingDocument("batch-dimensions-envelope");
    await fixture.db.documentSearchChunk.deleteMany({
      where: { documentId: fixture.document.id },
    });
    const contents = [
      ...Array.from({ length: 14 }, () => "x".repeat(9_000)),
      "y".repeat(4_991),
    ];
    expect(
      Buffer.byteLength(
        JSON.stringify({
          model: embeddingIdentity.embeddingModel,
          input: contents,
        }),
        "utf8",
      ),
    ).toBe(128 * 1_024);
    await fixture.db.documentSearchChunk.createMany({
      data: contents.map((content, ordinal) => ({
        id: createHash("sha256")
          .update(`batch-dimensions-envelope-${ordinal}`)
          .digest("hex"),
        projectId: fixture.project.id,
        documentId: fixture.document.id,
        ordinal,
        sourceCommitSha: fixture.document.headCommitSha,
        contentHash: createHash("sha256").update(content).digest("hex"),
        headingPath: ["Embedding Source"],
        content,
      })),
    });
    const requestBodies: string[] = [];
    const provider = createKnowledgeProvider(
      {
        extraction: {
          connectionId: "ollama-connection",
          connectionName: "Ollama",
          providerType: "ollama",
          endpoint: "http://ollama.test",
          requestTimeoutMs: 1_000,
          enabled: true,
          modelId: "extraction-model-id",
          providerModelId: "test-extraction",
          displayName: "Extraction",
          contextWindow: 32_000,
          embeddingDimensions: null,
          embeddingDimensionMode: "native",
          upstreamProvider: null,
          reasoningMode: "provider_default",
          capabilities: ["chat", "json_output"],
          inputCostMicrosPerMillion: null,
          outputCostMicrosPerMillion: null,
          currency: null,
        },
        embedding: {
          connectionId: "ollama-connection",
          connectionName: "Ollama",
          providerType: "ollama",
          endpoint: "http://ollama.test",
          requestTimeoutMs: 1_000,
          enabled: true,
          modelId: "embedding-model-id",
          providerModelId: embeddingIdentity.embeddingModel,
          displayName: "Embedding",
          contextWindow: null,
          embeddingDimensions: 1536,
          embeddingDimensionMode: "matryoshka",
          upstreamProvider: null,
          reasoningMode: "provider_default",
          capabilities: ["embedding"],
          inputCostMicrosPerMillion: null,
          outputCostMicrosPerMillion: null,
          currency: null,
        },
        embeddingDimensions: 1536,
        configFingerprint: fixture.generation.configFingerprint,
        extractionFingerprint: "test-extraction-fingerprint",
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
      } satisfies KnowledgeRouting,
      { resolveCredential: async () => "" },
      async (_url, init) => {
        const requestBody = init?.body as string;
        requestBodies.push(requestBody);
        const body = JSON.parse(requestBody) as { input: string[] };
        return new Response(
          JSON.stringify({
            data: body.input.map((_, index) => ({
              index,
              embedding: Array(1536).fill(0.25),
            })),
          }),
        );
      },
    );
    // A measured fast provider leaves the byte cap as the only batch limit.
    await provider.embed(["w".repeat(100_000)]);
    requestBodies.length = 0;

    await embedGenerationDocument(fixture.context, fixture.db, provider, {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    });

    expect(
      requestBodies.map((requestBody) => {
        const payload = JSON.parse(requestBody) as {
          input: string[];
          dimensions: number;
        };
        return {
          batchSize: payload.input.length,
          dimensions: payload.dimensions,
          bytes: Buffer.byteLength(requestBody, "utf8"),
        };
      }),
    ).toEqual([
      { batchSize: 14, dimensions: 1536, bytes: 126_096 },
      { batchSize: 1, dimensions: 1536, bytes: 5_048 },
    ]);
  });

  it("does not reuse a compatible cached embedding with zero cosine norm", async () => {
    const fixture = await setupEmbeddingDocument("zero-cache", "zero-cache");
    const [chunk] = await fixture.db.documentSearchChunk.findMany({
      where: { documentId: fixture.document.id },
      orderBy: { ordinal: "asc" },
      take: 1,
    });
    if (!chunk) throw new Error("expected a chunk");
    await fixture.db.documentSearchChunk.deleteMany({
      where: { documentId: fixture.document.id, id: { not: chunk.id } },
    });
    const cacheGeneration = await fixture.db.knowledgeGeneration.create({
      data: {
        ...generationConfiguration(fixture.project.id, "zero-cache"),
        status: "superseded",
        supersededAt: new Date(),
      },
    });
    await seedRawEmbedding(fixture.db, {
      projectId: fixture.project.id,
      generationId: cacheGeneration.id,
      ownerId: chunk.id,
      contentHash: chunk.contentHash,
      configFingerprint: "zero-cache",
      model: embeddingIdentity.embeddingModel,
      vector: Array(1536).fill(0) as number[],
    });
    let providerCalls = 0;
    const provider = embeddingProvider(async (values) => {
      providerCalls += 1;
      return {
        vectors: values.map(() => Array(1536).fill(0.5) as number[]),
        usage: {
          inputTokens: 1,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 1,
          durationMs: 1,
        },
      };
    });

    await expect(
      embedGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...embeddingIdentity,
      }),
    ).resolves.toMatchObject({ embeddedCount: 1, reusedCount: 0 });
    expect(providerCalls).toBe(1);
  });

  it("leaves the target generation untouched when reused vectors become stale before final publication", async () => {
    const fixture = await setupEmbeddingDocument("stale-after-reuse");
    const provider = embeddingProvider(async (input) => ({
      vectors: input.map(() => Array(1536).fill(0.7) as number[]),
      usage: {
        inputTokens: input.length,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: input.length,
        durationMs: 3,
      },
    }));
    await embedGenerationDocument(fixture.context, fixture.db, provider, {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    });
    const target = await makeGenerationDocument(fixture.db, {
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
    });
    const originalQueryRaw = fixture.db.$queryRaw.bind(fixture.db);
    let staleInjected = false;
    const querySpy = vi
      .spyOn(fixture.db, "$queryRaw")
      .mockImplementation((async (query: Prisma.Sql) => {
        const result = await originalQueryRaw(query);
        const sql = (query as unknown as { sql?: string }).sql ?? "";
        if (!staleInjected && sql.includes('"embedding"::text')) {
          staleInjected = true;
          await fixture.db.document.update({
            where: { id: fixture.document.id },
            data: { headCommitSha: "a".repeat(40) },
          });
        }
        return result;
      }) as typeof fixture.db.$queryRaw);

    let result: Awaited<ReturnType<typeof embedGenerationDocument>>;
    try {
      result = await embedGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        {
          projectId: fixture.project.id,
          generationId: target.id,
          documentId: fixture.document.id,
          sourceCommitSha: fixture.document.headCommitSha,
          configFingerprint: fixture.generation.configFingerprint,
          ...embeddingIdentity,
        },
      );
    } finally {
      querySpy.mockRestore();
    }

    expect(staleInjected).toBe(true);
    expect(result).toMatchObject({
      outcome: "stale",
      embeddedCount: 0,
      reusedCount: 0,
    });
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: target.id },
      }),
    ).toBe(0);
  });

  it("rolls back every batch when the document becomes stale during the last provider call", async () => {
    const fixture = await setupEmbeddingDocument("stale-last-batch");
    await fixture.db.documentSearchChunk.deleteMany({
      where: { documentId: fixture.document.id },
    });
    const contents = [
      ...Array.from({ length: 32 }, (_, index) =>
        String(index).padStart(2, "0").padEnd(1_000, "x"),
      ),
      "y".repeat(40_000),
      "z".repeat(30_000),
    ];
    await fixture.db.documentSearchChunk.createMany({
      data: contents.map((content, ordinal) => ({
        id: createHash("sha256").update(`stale-batch-${ordinal}`).digest("hex"),
        projectId: fixture.project.id,
        documentId: fixture.document.id,
        ordinal,
        sourceCommitSha: fixture.document.headCommitSha,
        contentHash: createHash("sha256").update(content).digest("hex"),
        headingPath: ["Embedding Source"],
        content,
      })),
    });
    let providerCalls = 0;
    const provider = embeddingProvider(async (input) => {
      providerCalls += 1;
      if (providerCalls === 2) {
        await fixture.db.document.update({
          where: { id: fixture.document.id },
          data: { headCommitSha: "b".repeat(40) },
        });
      }
      return {
        vectors: input.map(() => Array(1536).fill(0.8) as number[]),
        usage: {
          inputTokens: input.length,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: input.length,
          durationMs: 4,
        },
      };
    });

    await expect(
      embedGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...embeddingIdentity,
      }),
    ).resolves.toMatchObject({
      outcome: "stale",
      embeddedCount: 0,
      reusedCount: 0,
    });

    expect(providerCalls).toBe(2);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { projectId: fixture.project.id },
        orderBy: { createdAt: "asc" },
        select: { outcome: true },
      }),
    ).toEqual([{ outcome: "stale_discarded" }, { outcome: "stale_discarded" }]);
  });

  it("locks the project before generation rows so soft delete cannot publish first", async () => {
    const fixture = await setupEmbeddingDocument("project-lock-order");
    const blockerDb = createTestPrisma();
    const deleteDb = createTestPrisma();
    const observerDb = createTestPrisma();
    const blockerReady = deferred();
    const releaseBlocker = deferred();
    let blockerPid = 0;
    const blocker = blockerDb.$transaction(async (tx) => {
      const [pid] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid
      `;
      blockerPid = pid!.pid;
      await tx.$executeRaw`
        SELECT "id"
        FROM "KnowledgeGeneration"
        WHERE "id" = ${fixture.generation.id}::uuid
        FOR UPDATE
      `;
      blockerReady.resolve();
      await releaseBlocker.promise;
    });
    await blockerReady.promise;
    const provider = embeddingProvider(async (input) => ({
      vectors: input.map(() => Array(1536).fill(0.5) as number[]),
      usage: {
        inputTokens: input.length,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: input.length,
        durationMs: 2,
      },
    }));
    const embedding = embedGenerationDocument(
      fixture.context,
      fixture.db,
      provider,
      {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...embeddingIdentity,
      },
    );
    await waitForCondition(async () => {
      const [state] = await observerDb.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> ${blockerPid}
            AND wait_event_type = 'Lock'
            AND query LIKE '%KnowledgeGeneration%'
        ) AS waiting
      `;
      return state?.waiting ? true : null;
    });
    const [deletePidRow] = await deleteDb.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid() AS pid
    `;
    let deletionFinished = false;
    const deletion = deleteDb.project
      .update({
        where: { id: fixture.project.id },
        data: { deletedAt: new Date() },
      })
      .then(() => {
        deletionFinished = true;
      });

    let observed: "blocked" | "committed" = "committed";
    let embeddingResult:
      Awaited<ReturnType<typeof embedGenerationDocument>> | undefined;
    try {
      observed = await waitForCondition(async () => {
        if (deletionFinished) return "committed" as const;
        const [state] = await observerDb.$queryRaw<
          Array<{ waitEventType: string | null }>
        >`
          SELECT wait_event_type AS "waitEventType"
          FROM pg_stat_activity
          WHERE pid = ${deletePidRow!.pid}
        `;
        return state?.waitEventType === "Lock" ? ("blocked" as const) : null;
      });
    } finally {
      releaseBlocker.resolve();
      await blocker;
      embeddingResult = await embedding;
      await deletion;
      await blockerDb.$disconnect();
      await deleteDb.$disconnect();
      await observerDb.$disconnect();
    }

    expect(observed).toBe("blocked");
    expect(embeddingResult).toMatchObject({ outcome: "embedded" });
  });

  it("rolls back document vectors when durable usage accounting fails", async () => {
    const fixture = await setupEmbeddingDocument("accounting-rollback");
    const provider = embeddingProvider(async (input) => ({
      vectors: input.map(() => Array(1536).fill(0.45) as number[]),
      usage: {
        inputTokens: input.length,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: input.length,
        durationMs: 3,
      },
    }));
    await fixture.db.$executeRawUnsafe(`
      CREATE FUNCTION task8_fail_ai_usage() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'accounting unavailable';
      END;
      $$
    `);
    await fixture.db.$executeRawUnsafe(`
      CREATE TRIGGER task8_fail_ai_usage_trigger
      BEFORE INSERT ON "AiUsage"
      FOR EACH ROW EXECUTE FUNCTION task8_fail_ai_usage()
    `);

    let embeddingCount = -1;
    try {
      await expect(
        embedGenerationDocument(fixture.context, fixture.db, provider, {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          sourceCommitSha: fixture.document.headCommitSha,
          configFingerprint: fixture.generation.configFingerprint,
          ...embeddingIdentity,
        }),
      ).rejects.toThrow("accounting unavailable");
      embeddingCount = await fixture.db.knowledgeEmbedding.count({
        where: { generationId: fixture.generation.id },
      });
    } finally {
      await fixture.db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS task8_fail_ai_usage_trigger ON "AiUsage"',
      );
      await fixture.db.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS task8_fail_ai_usage()",
      );
    }

    expect(embeddingCount).toBe(0);
  });

  it("replaces a cross-project row occupying the target unique identity", async () => {
    const fixture = await setupEmbeddingDocument("target-project-mismatch");
    const [chunk] = await fixture.db.documentSearchChunk.findMany({
      where: {
        projectId: fixture.project.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
      },
      orderBy: { ordinal: "asc" },
      take: 1,
    });
    expect(chunk).toBeDefined();
    await fixture.db.documentSearchChunk.deleteMany({
      where: {
        documentId: fixture.document.id,
        id: { not: chunk!.id },
      },
    });
    const otherProject = await makeProject("Target row mismatch");
    await seedRawEmbedding(fixture.db, {
      projectId: otherProject.id,
      generationId: fixture.generation.id,
      ownerId: chunk!.id,
      contentHash: chunk!.contentHash,
      configFingerprint: fixture.generation.configFingerprint,
      model: embeddingIdentity.embeddingModel,
      vector: Array.from({ length: 1536 }, () => 0.1),
    });
    let providerCalls = 0;
    const provider = embeddingProvider(async (input) => {
      providerCalls += 1;
      return {
        vectors: input.map(() => Array(1536).fill(0.95) as number[]),
        usage: {
          inputTokens: 1,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 1,
          durationMs: 2,
        },
      };
    });

    await embedGenerationDocument(fixture.context, fixture.db, provider, {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...embeddingIdentity,
    });

    expect(providerCalls).toBe(1);
    expect(
      await fixture.db.knowledgeEmbedding.findMany({
        where: {
          generationId: fixture.generation.id,
          ownerType: "document_chunk",
          ownerId: chunk!.id,
        },
        select: {
          projectId: true,
          contentHash: true,
          configFingerprint: true,
          model: true,
          embeddingDimensions: true,
        },
      }),
    ).toEqual([
      {
        projectId: fixture.project.id,
        contentHash: chunk!.contentHash,
        configFingerprint: fixture.generation.configFingerprint,
        model: embeddingIdentity.embeddingModel,
        embeddingDimensions: 1536,
      },
    ]);
  });

  it("publishes source-bound temporal graph evidence and invalidates it on a newer SHA", async () => {
    const fixture = await setupEnrichmentDocument("temporal");
    const extractionRequests: Array<{
      documentId: string;
      chunkId: string;
      title: string;
      headingPath: string[];
      text: string;
    }> = [];
    const embeddingInputs: string[][] = [];
    const provider = enrichmentProvider({
      async extract(request) {
        extractionRequests.push(request);
        return {
          data: graphExtraction,
          usage: successfulExtractionUsage,
        };
      },
      async embed(values) {
        embeddingInputs.push(values);
        return {
          vectors: values.map(() => Array(1536).fill(0.35) as number[]),
          usage: {
            inputTokens: 20,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: 20,
            durationMs: 5,
          },
        };
      },
    });
    const input = {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...enrichmentIdentity,
      extractionModel: enrichmentIdentity.embeddingModel,
    };

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, input),
    ).resolves.toEqual({
      outcome: "enriched",
      entityCount: 2,
      relationCount: 1,
      embeddedCount: 2,
      reusedCount: 0,
    });

    const chunks = await fixture.db.documentSearchChunk.findMany({
      where: {
        projectId: fixture.project.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        supersededAt: null,
      },
      orderBy: { ordinal: "asc" },
    });
    expect(extractionRequests).toEqual(
      chunks.map((chunk) => ({
        documentId: fixture.document.id,
        chunkId: chunk.id,
        title: "Graph Source",
        headingPath: chunk.headingPath,
        text: chunk.content,
      })),
    );
    const canonicalInputs = [
      "Acme GmbH\nType: Organization\nAliases: ACME\nA manufacturing company.",
      "Atlas Platform\nType: Product\nAliases: Atlas\nAn operations platform.",
    ];
    expect(embeddingInputs).toEqual([canonicalInputs]);

    const entities = await fixture.db.graphEntity.findMany({
      where: {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
      },
      orderBy: { normalizedName: "asc" },
      include: { aliases: { orderBy: { normalizedAlias: "asc" } } },
    });
    expect(entities).toHaveLength(2);
    expect(
      entities.map((entity) => ({
        canonicalName: entity.canonicalName,
        entityType: entity.entityType,
        normalizedName: entity.normalizedName,
        aliases: entity.aliases.map((alias) => alias.alias),
      })),
    ).toEqual([
      {
        canonicalName: "Acme GmbH",
        entityType: "Organization",
        normalizedName: "acme gmbh",
        aliases: ["ACME"],
      },
      {
        canonicalName: "Atlas Platform",
        entityType: "Product",
        normalizedName: "atlas platform",
        aliases: ["Atlas"],
      },
    ]);

    const mentions = await fixture.db.entityMention.findMany({
      where: { generationId: fixture.generation.id },
      orderBy: { mentionText: "asc" },
    });
    expect(mentions).toHaveLength(2);
    expect(
      mentions.every(
        (mention) =>
          mention.projectId === fixture.project.id &&
          mention.generationId === fixture.generation.id &&
          mention.documentId === fixture.document.id &&
          mention.sourceChunkId === chunks[0]!.id &&
          mention.sourceCommitSha === fixture.document.headCommitSha &&
          mention.recordedAt instanceof Date &&
          mention.invalidatedAt === null &&
          mention.validFrom === null &&
          mention.validTo === null,
      ),
    ).toBe(true);
    expect(mentions.map((mention) => mention.confidence)).toEqual([0.95, 0.9]);

    const relations = await fixture.db.graphRelation.findMany({
      where: { generationId: fixture.generation.id },
      include: { evidence: true },
    });
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      relationType: "Uses Product",
      normalizedType: "uses_product",
    });
    expect(relations[0]!.evidence).toHaveLength(1);
    expect(relations[0]!.evidence[0]).toMatchObject({
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceChunkId: chunks[0]!.id,
      sourceCommitSha: fixture.document.headCommitSha,
      evidenceText: "Acme uses Atlas.",
      confidence: 0.85,
      validFrom: new Date("2026-01-02T00:00:00.000Z"),
      validTo: new Date("2026-12-31T00:00:00.000Z"),
      invalidatedAt: null,
    });
    expect(relations[0]!.evidence[0]!.recordedAt).toBeInstanceOf(Date);

    const storedEmbeddings = await fixture.db.$queryRaw<
      Array<{
        ownerId: string;
        contentHash: string;
        model: string;
        embeddingDimensions: number;
        vectorDimensions: number;
      }>
    >`
      SELECT "ownerId", "contentHash", "model", "embeddingDimensions",
             vector_dims("embedding") AS "vectorDimensions"
      FROM "KnowledgeEmbedding"
      WHERE "projectId" = ${fixture.project.id}::uuid
        AND "generationId" = ${fixture.generation.id}::uuid
        AND "ownerType" = 'entity'
      ORDER BY "contentHash" ASC
    `;
    expect(storedEmbeddings).toHaveLength(2);
    expect(storedEmbeddings.map((row) => row.contentHash).sort()).toEqual(
      canonicalInputs
        .map((value) => createHash("sha256").update(value).digest("hex"))
        .sort(),
    );
    expect(
      storedEmbeddings.every(
        (row) =>
          entities.some((entity) => entity.id === row.ownerId) &&
          row.model === enrichmentIdentity.embeddingModel &&
          row.embeddingDimensions === 1536 &&
          row.vectorDimensions === 1536,
      ),
    ).toBe(true);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { projectId: fixture.project.id },
        orderBy: { operation: "asc" },
        select: {
          operation: true,
          provider: true,
          connectionId: true,
          model: true,
          costMicros: true,
          currency: true,
        },
      }),
    ).toEqual([
      {
        operation: "document_graph_extraction",
        provider: enrichmentIdentity.extractionProviderName,
        connectionId: extractionConnectionId,
        model: enrichmentIdentity.embeddingModel,
        costMicros: 57n,
        currency: "EUR",
      },
      {
        operation: "entity_embedding",
        provider: enrichmentIdentity.providerName,
        connectionId: embeddingConnectionId,
        model: enrichmentIdentity.embeddingModel,
        costMicros: 20n,
        currency: "USD",
      },
    ]);
    expect(
      await fixture.db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: fixture.generation.id,
            documentId: fixture.document.id,
          },
        },
        select: { semanticIndexedSha: true, graphIndexedSha: true },
      }),
    ).toEqual({
      semanticIndexedSha: fixture.document.headCommitSha,
      graphIndexedSha: fixture.document.headCommitSha,
    });

    const updated = await fixture.caller.document.update({
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      baseCommitSha: fixture.document.headCommitSha,
      title: "Graph Source",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody(
          "# Graph Source\n\nAcme continues to use Atlas for operations.\n",
        ),
      },
      changeSummary: "Refresh graph evidence",
    });
    await syncDocumentKeywordIndex(fixture.context, fixture.db, {
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      sourceCommitSha: updated.headCommitSha,
      pathAtSha: updated.path,
    });
    await fixture.db.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
        },
      },
      data: { targetSha: updated.headCommitSha, status: "processing" },
    });

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        ...input,
        sourceCommitSha: updated.headCommitSha,
      }),
    ).resolves.toMatchObject({
      outcome: "enriched",
      entityCount: 2,
      relationCount: 1,
      embeddedCount: 0,
      reusedCount: 2,
    });

    const temporalMentions = await fixture.db.entityMention.findMany({
      where: { generationId: fixture.generation.id },
      orderBy: [{ sourceCommitSha: "asc" }, { mentionText: "asc" }],
    });
    expect(temporalMentions).toHaveLength(4);
    expect(
      temporalMentions
        .filter(
          (mention) =>
            mention.sourceCommitSha === fixture.document.headCommitSha,
        )
        .every((mention) => mention.invalidatedAt instanceof Date),
    ).toBe(true);
    expect(
      temporalMentions
        .filter((mention) => mention.sourceCommitSha === updated.headCommitSha)
        .every((mention) => mention.invalidatedAt === null),
    ).toBe(true);
    const temporalEvidence = await fixture.db.relationEvidence.findMany({
      where: { generationId: fixture.generation.id },
      orderBy: { sourceCommitSha: "asc" },
    });
    expect(temporalEvidence).toHaveLength(2);
    expect(
      temporalEvidence.find(
        (evidence) =>
          evidence.sourceCommitSha === fixture.document.headCommitSha,
      )?.invalidatedAt,
    ).toBeInstanceOf(Date);
    expect(
      temporalEvidence.find(
        (evidence) => evidence.sourceCommitSha === updated.headCommitSha,
      )?.invalidatedAt,
    ).toBeNull();
  });

  it("stores entity embedding timestamps as UTC wall-clock like Prisma writes", async () => {
    const fixture = await setupEnrichmentDocument("entity-utc");

    await enrichGenerationDocument(
      fixture.context,
      fixture.db,
      enrichmentProvider({}),
      {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
        extractionModel: enrichmentIdentity.embeddingModel,
      },
    );

    const rows = await fixture.db.knowledgeEmbedding.findMany({
      where: { generationId: fixture.generation.id, ownerType: "entity" },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expectRecentUtc(row.createdAt);
  });

  it("reuses compatible entity embeddings across generations but not configurations", async () => {
    const fixture = await setupEnrichmentDocument("entity-reuse");
    let embeddingCalls = 0;
    const provider = enrichmentProvider({
      async embed(values) {
        embeddingCalls += 1;
        return {
          vectors: values.map(() => Array(1536).fill(0.45) as number[]),
          usage: {
            inputTokens: values.length,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: values.length,
            durationMs: 3,
          },
        };
      },
    });
    const baseInput = {
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...enrichmentIdentity,
    };
    await enrichGenerationDocument(fixture.context, fixture.db, provider, {
      ...baseInput,
      generationId: fixture.generation.id,
    });
    expect(embeddingCalls).toBe(1);

    const compatible = await makeGenerationDocument(fixture.db, {
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
    });
    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        ...baseInput,
        generationId: compatible.id,
      }),
    ).resolves.toMatchObject({ embeddedCount: 0, reusedCount: 2 });
    expect(embeddingCalls).toBe(1);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: compatible.id, ownerType: "entity" },
      }),
    ).toBe(2);

    const incompatible = await makeGenerationDocument(fixture.db, {
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: "different-enrichment-config",
    });
    await enrichGenerationDocument(fixture.context, fixture.db, provider, {
      ...baseInput,
      generationId: incompatible.id,
      configFingerprint: "different-enrichment-config",
    });
    expect(embeddingCalls).toBe(2);
  });

  it("discards late extraction and entity embeddings when the live SHA changes", async () => {
    const fixture = await setupEnrichmentDocument("stale-extraction");
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const provider = enrichmentProvider({
      async extract() {
        providerStarted.resolve();
        await releaseProvider.promise;
        return {
          data: graphExtraction,
          usage: successfulExtractionUsage,
        };
      },
    });
    const enrichment = enrichGenerationDocument(
      fixture.context,
      fixture.db,
      provider,
      {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      },
    );

    await providerStarted.promise;
    await fixture.db.document.update({
      where: { id: fixture.document.id },
      data: { headCommitSha: "f".repeat(40) },
    });
    releaseProvider.resolve();

    await expect(enrichment).resolves.toEqual({
      outcome: "stale",
      entityCount: 0,
      relationCount: 0,
      embeddedCount: 0,
      reusedCount: 0,
    });
    expect(
      await fixture.db.graphEntity.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.entityMention.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.graphRelation.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.relationEvidence.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: {
          generationId: fixture.generation.id,
          ownerType: "entity",
        },
      }),
    ).toBe(0);
    const usage = await fixture.db.aiUsage.findMany({
      where: { projectId: fixture.project.id },
      orderBy: { createdAt: "asc" },
      select: { operation: true, outcome: true },
    });
    expect(usage.length).toBeGreaterThan(0);
    expect(usage).toContainEqual({
      operation: "document_graph_extraction",
      outcome: "stale_discarded",
    });
    expect(usage.every((row) => row.outcome === "stale_discarded")).toBe(true);
  });

  it("rejects inverted source validity and records validation failure", async () => {
    const fixture = await setupEnrichmentDocument("invalid-temporal");
    const provider = enrichmentProvider({
      async extract() {
        return {
          data: {
            ...graphExtraction,
            relations: [
              {
                ...graphExtraction.relations[0]!,
                validFrom: "2026-12-31T00:00:00.000Z",
                validTo: "2026-01-02T00:00:00.000Z",
              },
            ],
          },
          usage: successfulExtractionUsage,
        };
      },
    });

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).rejects.toMatchObject({ kind: "validation", retryable: false });
    expect(
      await fixture.db.graphEntity.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { projectId: fixture.project.id },
        select: {
          operation: true,
          outcome: true,
          inputTokens: true,
          outputTokens: true,
          durationMs: true,
        },
      }),
    ).toEqual([
      {
        operation: "document_graph_extraction",
        outcome: "validation_failure",
        inputTokens: 11,
        outputTokens: 7,
        durationMs: 6,
      },
    ]);
  });

  it("does not enrich before the exact keyword projection is ready", async () => {
    const { caller, project } = await setupEditor("enrichment-before-keyword");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Not Keyword Ready",
      contentJson: parseDocumentBody(
        "# Not Keyword Ready\n\nAcme uses Atlas.\n",
      ),
    });
    const db = getPrisma();
    const generation = await makeGenerationDocument(db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      configFingerprint: "before-keyword-config",
    });
    let providerCalls = 0;
    const provider = enrichmentProvider({
      async extract() {
        providerCalls += 1;
        return {
          data: graphExtraction,
          usage: successfulExtractionUsage,
        };
      },
      async embed(values) {
        providerCalls += 1;
        return {
          vectors: values.map(() => Array(1536).fill(0.2) as number[]),
          usage: {
            inputTokens: values.length,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: values.length,
            durationMs: 1,
          },
        };
      },
    });

    await expect(
      enrichGenerationDocument(knowledgeSystemContextForTests(), db, provider, {
        projectId: project.id,
        generationId: generation.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        configFingerprint: generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).resolves.toMatchObject({ outcome: "stale" });
    expect(providerCalls).toBe(0);
    expect(
      await db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        select: { semanticIndexedSha: true, graphIndexedSha: true },
      }),
    ).toEqual({ semanticIndexedSha: null, graphIndexedSha: null });
  });

  it("discards provider work when keyword readiness changes before publication", async () => {
    const fixture = await setupEnrichmentDocument("keyword-race");
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const provider = enrichmentProvider({
      async extract() {
        providerStarted.resolve();
        await releaseProvider.promise;
        return {
          data: graphExtraction,
          usage: successfulExtractionUsage,
        };
      },
    });
    const enrichment = enrichGenerationDocument(
      fixture.context,
      fixture.db,
      provider,
      {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      },
    );

    await providerStarted.promise;
    await fixture.db.documentIndexState.update({
      where: { documentId: fixture.document.id },
      data: { status: "processing", keywordIndexedSha: null },
    });
    releaseProvider.resolve();

    await expect(enrichment).resolves.toMatchObject({ outcome: "stale" });
    expect(
      await fixture.db.graphEntity.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { projectId: fixture.project.id },
        select: { operation: true, outcome: true },
      }),
    ).toEqual([
      {
        operation: "document_graph_extraction",
        outcome: "stale_discarded",
      },
    ]);
  });

  it("re-resolves concurrent documents before publishing aliases and entity vectors", async () => {
    const fixture = await setupEnrichmentDocument("concurrent-resolution");
    const secondDocument = await fixture.caller.document.create({
      projectId: fixture.project.id,
      folderPath: [],
      title: "Second Graph Source",
      contentJson: parseDocumentBody(
        "# Second Graph Source\n\nShared is referenced here.\n",
      ),
    });
    await syncDocumentKeywordIndex(fixture.context, fixture.db, {
      projectId: fixture.project.id,
      documentId: secondDocument.id,
      sourceCommitSha: secondDocument.headCommitSha,
      pathAtSha: secondDocument.path,
    });
    await fixture.db.knowledgeGenerationDocument.create({
      data: {
        generationId: fixture.generation.id,
        documentId: secondDocument.id,
        projectId: fixture.project.id,
        targetSha: secondDocument.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        status: "processing",
      },
    });

    const firstAliases = [
      "Shared",
      ...Array.from({ length: 19 }, (_, index) => `Primary ${index + 1}`),
    ];
    const secondAliases = Array.from(
      { length: 20 },
      (_, index) => `Secondary ${index + 1}`,
    );
    const firstEmbeddingStarted = deferred();
    const secondEmbeddingStarted = deferred();
    const releaseFirstEmbedding = deferred();
    const releaseSecondEmbedding = deferred();
    const provider = enrichmentProvider({
      async extract(request) {
        const first = request.documentId === fixture.document.id;
        return {
          data: {
            entities: [
              {
                key: "entity",
                name: first ? "Atlas Platform" : "Shared",
                type: "Product",
                aliases: first ? firstAliases : secondAliases,
                description: "Concurrent entity.",
                mentionText: first ? "Atlas Platform" : "Shared",
                confidence: 0.9,
              },
            ],
            relations: [],
          },
          usage: successfulExtractionUsage,
        };
      },
      async embed(values) {
        if (values[0]!.startsWith("Atlas Platform\n")) {
          firstEmbeddingStarted.resolve();
          await releaseFirstEmbedding.promise;
        } else {
          secondEmbeddingStarted.resolve();
          await releaseSecondEmbedding.promise;
        }
        return {
          vectors: values.map(() => Array(1536).fill(0.55) as number[]),
          usage: {
            inputTokens: values.length,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: values.length,
            durationMs: 2,
          },
        };
      },
    });
    const first = enrichGenerationDocument(
      fixture.context,
      fixture.db,
      provider,
      {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      },
    );
    const second = enrichGenerationDocument(
      fixture.context,
      fixture.db,
      provider,
      {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: secondDocument.id,
        sourceCommitSha: secondDocument.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      },
    );

    await firstEmbeddingStarted.promise;
    await secondEmbeddingStarted.promise;
    releaseFirstEmbedding.resolve();
    await first;
    releaseSecondEmbedding.resolve();
    await second;

    const entities = await fixture.db.graphEntity.findMany({
      where: { generationId: fixture.generation.id },
      include: { aliases: true, mentions: true },
    });
    expect(entities).toHaveLength(1);
    expect(entities[0]!.aliases).toHaveLength(20);
    expect(
      new Set(entities[0]!.mentions.map((mention) => mention.entityId)),
    ).toEqual(new Set([entities[0]!.id]));
    expect(entities[0]!.mentions).toHaveLength(2);

    const aliases = entities[0]!.aliases
      .map((alias) => alias.alias)
      .sort((left, right) => left.localeCompare(right));
    const canonicalText = `${entities[0]!.canonicalName}\nType: ${entities[0]!.entityType}\nAliases: ${aliases.join(", ")}\n${entities[0]!.description ?? ""}`;
    expect(
      await fixture.db.knowledgeEmbedding.findFirst({
        where: {
          generationId: fixture.generation.id,
          ownerType: "entity",
          ownerId: entities[0]!.id,
        },
        select: { contentHash: true },
      }),
    ).toEqual({
      contentHash: createHash("sha256").update(canonicalText).digest("hex"),
    });
  });

  it("reuses one run-local entity after an ambiguous first occurrence", async () => {
    const fixture = await setupEnrichmentDocument("run-local-ambiguity");
    await replaceWithTwoEnrichmentChunks(fixture.db, {
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
    });
    for (const canonicalName of ["Shared One", "Shared Two"]) {
      const entity = await fixture.db.graphEntity.create({
        data: {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          entityType: "Product",
          canonicalName,
          normalizedName: canonicalName.toLowerCase(),
        },
      });
      await fixture.db.graphEntityAlias.create({
        data: {
          projectId: fixture.project.id,
          entityId: entity.id,
          alias: "Shared",
          normalizedAlias: "shared",
        },
      });
    }
    const providerInputs: string[][] = [];
    const provider = enrichmentProvider({
      async extract() {
        return {
          data: {
            entities: [
              {
                key: "shared",
                name: "Shared",
                type: "Product",
                aliases: ["Shared Alias"],
                description: "Ambiguous extracted entity.",
                mentionText: "Shared",
                confidence: 0.8,
              },
            ],
            relations: [],
          },
          usage: successfulExtractionUsage,
        };
      },
      async embed(values) {
        providerInputs.push(values);
        return {
          vectors: values.map(() => Array(1536).fill(0.65) as number[]),
          usage: {
            inputTokens: values.length,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: values.length,
            durationMs: 2,
          },
        };
      },
    });

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).resolves.toMatchObject({
      outcome: "enriched",
      entityCount: 1,
      embeddedCount: 1,
    });
    expect(providerInputs).toHaveLength(1);
    const activeMentions = await fixture.db.entityMention.findMany({
      where: {
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        invalidatedAt: null,
      },
      select: { entityId: true },
    });
    expect(activeMentions).toHaveLength(2);
    expect(
      new Set(activeMentions.map((mention) => mention.entityId)).size,
    ).toBe(1);
  });

  it("reuses the exact canonical entity despite an alias candidate", async () => {
    const fixture = await setupEnrichmentDocument("canonical-alias-ambiguity");
    const exact = await fixture.db.graphEntity.create({
      data: {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        entityType: "Product",
        canonicalName: "Shared",
        normalizedName: "shared",
        description: "The exact canonical candidate.",
      },
    });
    await fixture.db.graphEntity.create({
      data: {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        entityType: "Product",
        canonicalName: "Other Product",
        normalizedName: "other product",
        description: "The alias candidate.",
        aliases: {
          create: {
            projectId: fixture.project.id,
            alias: "Shared",
            normalizedAlias: "shared",
          },
        },
      },
    });
    const embeddingInputs: string[][] = [];
    let extractionCalls = 0;
    const provider = enrichmentProvider({
      async extract() {
        extractionCalls += 1;
        return {
          data: {
            entities: [
              {
                key: "shared",
                name: "Shared",
                type: "Product",
                aliases: ["Shared Alias"],
                description: "A separately resolved ambiguous entity.",
                mentionText: "Shared",
                confidence: 0.9,
              },
            ],
            relations: [],
          },
          usage: successfulExtractionUsage,
        };
      },
      async embed(values) {
        embeddingInputs.push(values);
        return {
          vectors: values.map(() => Array(1536).fill(0.77) as number[]),
          usage: {
            inputTokens: values.length,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: values.length,
            durationMs: 2,
          },
        };
      },
    });
    const input = {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...enrichmentIdentity,
    };

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, input),
    ).resolves.toMatchObject({
      outcome: "enriched",
      entityCount: 1,
      embeddedCount: 1,
    });

    const entities = await fixture.db.graphEntity.findMany({
      where: { generationId: fixture.generation.id },
      include: { aliases: { orderBy: { normalizedAlias: "asc" } } },
      orderBy: { createdAt: "asc" },
    });
    expect(entities).toHaveLength(2);
    const distinct = entities.find((entity) => entity.id === exact.id);
    expect(distinct).toBeDefined();
    expect(distinct).toMatchObject({
      canonicalName: "Shared",
      entityType: "Product",
      description: "A separately resolved ambiguous entity.",
    });
    expect(distinct!.normalizedName).toBe("shared");
    expect(
      distinct!.aliases.map((alias) => ({
        alias: alias.alias,
        normalizedAlias: alias.normalizedAlias,
      })),
    ).toEqual([{ alias: "Shared Alias", normalizedAlias: "shared alias" }]);

    const canonicalText =
      "Shared\nType: Product\nAliases: Shared Alias\nA separately resolved ambiguous entity.";
    expect(embeddingInputs).toEqual([[canonicalText]]);
    const [storedEmbedding] = await fixture.db.$queryRaw<
      Array<{ ownerId: string; contentHash: string; embedding: string }>
    >`
      SELECT "ownerId", "contentHash", "embedding"::text AS "embedding"
      FROM "KnowledgeEmbedding"
      WHERE "generationId" = ${fixture.generation.id}::uuid
        AND "ownerType" = 'entity'
    `;
    expect(storedEmbedding).toMatchObject({
      ownerId: distinct!.id,
      contentHash: createHash("sha256").update(canonicalText).digest("hex"),
    });
    expect(pgvector.fromSql(storedEmbedding!.embedding)).toEqual(
      Array(1536).fill(0.77),
    );
    expect(
      await fixture.db.entityMention.findMany({
        where: {
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          invalidatedAt: null,
        },
        select: { entityId: true },
      }),
    ).toEqual([{ entityId: distinct!.id }]);

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, input),
    ).resolves.toEqual({
      outcome: "enriched",
      entityCount: 0,
      relationCount: 0,
      embeddedCount: 0,
      reusedCount: 0,
    });
    expect(extractionCalls).toBe(1);
    expect(
      await fixture.db.graphEntity.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(2);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: {
          generationId: fixture.generation.id,
          ownerType: "entity",
        },
      }),
    ).toBe(1);
  });

  it("reuses NFKC-equivalent canonical and entity-type candidates", async () => {
    const fixture = await setupEnrichmentDocument("nfkc-entity-reuse");
    const existing = await fixture.db.graphEntity.create({
      data: {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        entityType: "Ｐｒｏｄｕｃｔ",
        canonicalName: "Ａｔｌａｓ",
        normalizedName: "atlas",
        description: "Compatibility-normalized existing entity.",
      },
    });
    const provider = enrichmentProvider({
      async extract() {
        return {
          data: {
            entities: [
              {
                key: "atlas",
                name: "Atlas",
                type: "Product",
                aliases: ["Atlas Platform"],
                description: null,
                mentionText: "Atlas",
                confidence: 0.9,
              },
            ],
            relations: [],
          },
          usage: successfulExtractionUsage,
        };
      },
    });

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).resolves.toMatchObject({
      outcome: "enriched",
      entityCount: 1,
      embeddedCount: 1,
    });
    expect(
      await fixture.db.graphEntity.findMany({
        where: { generationId: fixture.generation.id },
        include: { aliases: true },
      }),
    ).toEqual([
      expect.objectContaining({
        id: existing.id,
        canonicalName: "Ａｔｌａｓ",
        entityType: "Ｐｒｏｄｕｃｔ",
        aliases: [
          expect.objectContaining({
            alias: "Atlas Platform",
            normalizedAlias: "atlas platform",
          }),
        ],
      }),
    ]);
    expect(
      await fixture.db.entityMention.findMany({
        where: {
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          invalidatedAt: null,
        },
        select: { entityId: true },
      }),
    ).toEqual([{ entityId: existing.id }]);
  });

  it("reuses an NFKC-compatible candidate after older incompatible name matches", async () => {
    const fixture = await setupEnrichmentDocument("paged-nfkc-reuse");
    await fixture.db.graphEntity.createMany({
      data: [
        {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          entityType: "Organization",
          canonicalName: "Atlas",
          normalizedName: "atlas",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          entityType: "Person",
          canonicalName: "Atlas",
          normalizedName: "atlas",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ],
    });
    const compatible = await fixture.db.graphEntity.create({
      data: {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        entityType: "Ｐｒｏｄｕｃｔ",
        canonicalName: "Ａｔｌａｓ",
        normalizedName: "atlas",
        description: "The compatible candidate behind older rows.",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
    });
    let extractionCalls = 0;
    const provider = enrichmentProvider({
      async extract() {
        extractionCalls += 1;
        return {
          data: {
            entities: [
              {
                key: "atlas",
                name: "Atlas",
                type: "Product",
                aliases: ["Atlas Platform"],
                description: null,
                mentionText: "Atlas",
                confidence: 0.9,
              },
            ],
            relations: [],
          },
          usage: successfulExtractionUsage,
        };
      },
    });
    const input = {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...enrichmentIdentity,
    };

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, input),
    ).resolves.toMatchObject({
      outcome: "enriched",
      entityCount: 1,
      embeddedCount: 1,
    });
    expect(
      await fixture.db.graphEntity.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(3);
    expect(
      await fixture.db.entityMention.findMany({
        where: {
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          invalidatedAt: null,
        },
        select: { entityId: true },
      }),
    ).toEqual([{ entityId: compatible.id }]);
    expect(
      await fixture.db.graphEntity.findUnique({
        where: { id: compatible.id },
        select: { canonicalName: true, entityType: true },
      }),
    ).toEqual({ canonicalName: "Ａｔｌａｓ", entityType: "Ｐｒｏｄｕｃｔ" });

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, input),
    ).resolves.toMatchObject({ entityCount: 0, embeddedCount: 0 });
    expect(extractionCalls).toBe(1);
  });

  it("sees an exact raw identity behind older aliases before publishing ambiguity", async () => {
    const fixture = await setupEnrichmentDocument("hidden-raw-identity");
    const aliasCandidates: string[] = [];
    for (const [index, canonicalName] of ["Older One", "Older Two"].entries()) {
      const candidate = await fixture.db.graphEntity.create({
        data: {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          entityType: "Product",
          canonicalName,
          normalizedName: canonicalName.toLowerCase(),
          createdAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
          aliases: {
            create: {
              projectId: fixture.project.id,
              alias: "Shared",
              normalizedAlias: "shared",
            },
          },
        },
      });
      aliasCandidates.push(candidate.id);
    }
    const exact = await fixture.db.graphEntity.create({
      data: {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        entityType: "Product",
        canonicalName: "Shared",
        normalizedName: "shared",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
    });
    let extractionCalls = 0;
    const provider = enrichmentProvider({
      async extract() {
        extractionCalls += 1;
        return {
          data: {
            entities: [
              {
                key: "shared",
                name: "Shared",
                type: "Product",
                aliases: ["Shared Result"],
                description: "A distinct ambiguous result.",
                mentionText: "Shared",
                confidence: 0.9,
              },
            ],
            relations: [],
          },
          usage: successfulExtractionUsage,
        };
      },
    });
    const input = {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...enrichmentIdentity,
    };

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, input),
    ).resolves.toMatchObject({
      outcome: "enriched",
      entityCount: 1,
      embeddedCount: 1,
    });
    const entities = await fixture.db.graphEntity.findMany({
      where: { generationId: fixture.generation.id },
      include: { aliases: { orderBy: { normalizedAlias: "asc" } } },
    });
    expect(entities).toHaveLength(3);
    const distinct = entities.find((entity) => entity.id === exact.id);
    expect(distinct).toMatchObject({
      canonicalName: "Shared",
      entityType: "Product",
      description: "A distinct ambiguous result.",
    });
    expect(distinct!.normalizedName).toBe("shared");
    expect(
      distinct!.aliases.map((alias) => ({
        alias: alias.alias,
        normalizedAlias: alias.normalizedAlias,
      })),
    ).toEqual([{ alias: "Shared Result", normalizedAlias: "shared result" }]);
    expect(
      await fixture.db.entityMention.findMany({
        where: {
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          invalidatedAt: null,
        },
        select: { entityId: true },
      }),
    ).toEqual([{ entityId: distinct!.id }]);

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, input),
    ).resolves.toMatchObject({ entityCount: 0, embeddedCount: 0 });
    expect(extractionCalls).toBe(1);
    expect(
      await fixture.db.graphEntity.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(3);
  });

  it("filters incompatible types before bounding normalized entity candidates", async () => {
    const fixture = await setupEnrichmentDocument("candidate-overflow");
    await fixture.db.graphEntity.createMany({
      data: Array.from({ length: 16 }, (_, index) => ({
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        entityType: `Incompatible ${index}`,
        canonicalName: "Overflowed",
        normalizedName: "overflowed",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })),
    });
    const hiddenCompatible = await fixture.db.graphEntity.create({
      data: {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        entityType: "Ｐｒｏｄｕｃｔ",
        canonicalName: "Ｏｖｅｒｆｌｏｗｅｄ",
        normalizedName: "overflowed",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    });
    const provider = enrichmentProvider({
      async extract() {
        return {
          data: {
            entities: [
              {
                key: "overflowed",
                name: "Overflowed",
                type: "Product",
                aliases: [],
                description: null,
                mentionText: "Overflowed",
                confidence: 0.9,
              },
            ],
            relations: [],
          },
          usage: successfulExtractionUsage,
        };
      },
    });

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).resolves.toMatchObject({
      outcome: "enriched",
      entityCount: 1,
      embeddedCount: 1,
    });
    const [mention] = await fixture.db.entityMention.findMany({
      where: {
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        invalidatedAt: null,
      },
      select: { entityId: true },
    });
    expect(mention!.entityId).toBe(hiddenCompatible.id);
    const distinct = await fixture.db.graphEntity.findUniqueOrThrow({
      where: { id: mention!.entityId },
      include: { aliases: true },
    });
    expect(distinct).toMatchObject({
      canonicalName: "Ｏｖｅｒｆｌｏｗｅｄ",
      entityType: "Ｐｒｏｄｕｃｔ",
    });
    expect(distinct.normalizedName).toBe("overflowed");
    expect(distinct.aliases).toEqual([]);
    expect(
      await fixture.db.graphEntity.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(17);
  });

  it("rejects an extraction request whose complete serialized payload exceeds 64000 characters", async () => {
    const fixture = await setupEnrichmentDocument("request-boundary");
    const chunk = await fixture.db.documentSearchChunk.findFirstOrThrow({
      where: { documentId: fixture.document.id, supersededAt: null },
    });
    const baseRequest = {
      documentId: fixture.document.id,
      chunkId: chunk.id,
      title: "Graph Source",
      headingPath: ["h".repeat(200)],
      text: "",
    };
    const text = "x".repeat(64_001 - JSON.stringify(baseRequest).length);
    const request = { ...baseRequest, text };
    expect(JSON.stringify(request)).toHaveLength(64_001);
    await fixture.db.documentSearchChunk.update({
      where: { id: chunk.id },
      data: { headingPath: request.headingPath, content: text },
    });
    let extractionCalls = 0;
    const provider = enrichmentProvider({
      async extract() {
        extractionCalls += 1;
        return {
          data: graphExtraction,
          usage: successfulExtractionUsage,
        };
      },
    });

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).rejects.toMatchObject({ kind: "validation", retryable: false });
    expect(extractionCalls).toBe(0);
  });

  it("replaces stale same-SHA chunk identities and surplus ordinals atomically", async () => {
    const { caller, project } = await setupEditor("same-sha-repair");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Same SHA",
      contentJson: parseDocumentBody("# Same SHA\n\nCurrent content."),
    });
    const db = getPrisma();
    const context = knowledgeSystemContextForTests();
    const payload = {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    };
    await syncDocumentKeywordIndex(context, db, payload);
    const original = await db.documentSearchChunk.findFirstOrThrow({
      where: { documentId: document.id },
    });
    await db.documentSearchChunk.deleteMany({
      where: { documentId: document.id },
    });
    await db.documentSearchChunk.createMany({
      data: [0, 99].map((ordinal) => ({
        ...original,
        id: createHash("sha256").update(`old-${ordinal}`).digest("hex"),
        ordinal,
        content: "obsolete chunking",
      })),
    });
    await expect(
      syncDocumentKeywordIndex(context, db, payload),
    ).resolves.toEqual({ outcome: "indexed" });
    const chunks = await db.documentSearchChunk.findMany({
      where: { documentId: document.id, supersededAt: null },
    });
    expect(chunks.map((chunk) => chunk.id)).toEqual([original.id]);
    expect(chunks[0]!.content).toBe(original.content);
  });

  it("records a terminal keyword validation failure and stops reconciliation retries", async () => {
    const { caller, project } = await setupEditor("keyword-terminal");
    const markdown = Array.from(
      { length: 257 },
      (_, index) => `# Section ${index}\n\nBody ${index}.`,
    ).join("\n\n");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Too many sections",
      contentJson: parseDocumentBody(markdown),
    });
    const db = getPrisma();
    const context = knowledgeSystemContextForTests();
    await expect(
      syncDocumentKeywordIndex(context, db, {
        projectId: project.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
      }),
    ).resolves.toEqual({ outcome: "failed" });
    expect(
      await db.documentIndexState.findUnique({
        where: { documentId: document.id },
      }),
    ).toMatchObject({
      status: "failed",
      failureKind: "validation",
      completedAt: expect.any(Date),
    });
    knowledgeQueue.jobs.length = 0;
    await reconcileProjectKnowledge(context, db, project.id);
    expect(
      knowledgeQueue.jobs.filter((job) => job.name === "document.search-sync"),
    ).toEqual([]);
  });

  it("accepts the aggregate document maximum of 50 entities and 100 relations", async () => {
    const fixture = await setupEnrichmentDocument("aggregate-maximum");
    const chunks = await replaceWithTwoEnrichmentChunks(fixture.db, {
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
    });
    const provider = enrichmentProvider({
      async extract(request) {
        const first = request.chunkId === chunks[0]!.id;
        return {
          data: extractionBatch(first ? 0 : 25, 25, 50),
          usage: successfulExtractionUsage,
        };
      },
    });

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).resolves.toMatchObject({
      outcome: "enriched",
      entityCount: 50,
      relationCount: 100,
    });
    expect(
      await fixture.db.graphEntity.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(50);
    expect(
      await fixture.db.relationEvidence.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(100);
  });

  it("accepts more than 50 entities across independently bounded chunks", async () => {
    const fixture = await setupEnrichmentDocument("aggregate-overflow");
    const chunks = await replaceWithTwoEnrichmentChunks(fixture.db, {
      projectId: fixture.project.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
    });
    const provider = enrichmentProvider({
      async extract(request) {
        const first = request.chunkId === chunks[0]!.id;
        return {
          data: extractionBatch(first ? 0 : 26, first ? 26 : 25, 0),
          usage: successfulExtractionUsage,
        };
      },
    });

    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).resolves.toMatchObject({ outcome: "enriched", entityCount: 51 });
    expect(
      await fixture.db.graphEntity.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(51);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { projectId: fixture.project.id },
        orderBy: { createdAt: "asc" },
        select: { outcome: true },
      }),
    ).toEqual(Array.from({ length: 4 }, () => ({ outcome: "success" })));
  });

  it("reuses the current generation but always creates a fresh explicit rebuild", async () => {
    const { caller, project } = await setupEditor("generation-ensure");
    const firstDocument = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Generation First",
      contentJson: parseDocumentBody("# Generation First\n\nFirst source.\n"),
    });
    const secondDocument = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Generation Second",
      contentJson: parseDocumentBody("# Generation Second\n\nSecond source.\n"),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const configuration = generationConfiguration(
      project.id,
      "generation-config-current",
    );
    knowledgeQueue.jobs.length = 0;

    const first = await ensureGenerationForCurrentConfig(
      context,
      db,
      configuration,
    );
    if (!first) throw new Error("expected a generation");

    expect(first.status).toBe("building");
    expect(
      await db.knowledgeGenerationDocument.findMany({
        where: { generationId: first.id },
        orderBy: { documentId: "asc" },
        select: {
          documentId: true,
          targetSha: true,
          status: true,
          configFingerprint: true,
        },
      }),
    ).toEqual(
      [firstDocument, secondDocument]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((document) => ({
          documentId: document.id,
          targetSha: document.headCommitSha,
          status: "pending",
          configFingerprint: configuration.configFingerprint,
        })),
    );
    expect(knowledgeQueue.jobs).toEqual(
      [firstDocument, secondDocument]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((document) => ({
          name: "document.ai-enrich" as const,
          data: {
            projectId: project.id,
            generationId: first.id,
            documentId: document.id,
            sourceCommitSha: document.headCommitSha,
            pathAtSha: document.path,
            configFingerprint: configuration.configFingerprint,
          },
        })),
    );

    knowledgeQueue.jobs.length = 0;
    const reusedBuilding = await ensureGenerationForCurrentConfig(
      context,
      db,
      configuration,
    );
    expect(reusedBuilding?.id).toBe(first.id);
    expect(knowledgeQueue.jobs).toEqual(
      [firstDocument, secondDocument]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((document) => ({
          name: "document.ai-enrich" as const,
          data: {
            projectId: project.id,
            generationId: first.id,
            documentId: document.id,
            sourceCommitSha: document.headCommitSha,
            pathAtSha: document.path,
            configFingerprint: configuration.configFingerprint,
          },
        })),
    );

    await markLiveGenerationDocumentsReady(db, project.id, first.id);
    await expect(
      activateCompletedGeneration(context, db, {
        projectId: project.id,
        generationId: first.id,
      }),
    ).resolves.toBe(true);
    const reusedActive = await ensureGenerationForCurrentConfig(
      context,
      db,
      configuration,
    );
    expect(reusedActive?.id).toBe(first.id);

    const explicit = await startGenerationBuild(context, db, configuration);
    if (!explicit) throw new Error("expected an explicit generation");
    expect(explicit.id).not.toBe(first.id);
    expect(explicit.status).toBe("building");
    expect(
      await db.knowledgeGeneration.findUnique({
        where: { id: first.id },
        select: { status: true },
      }),
    ).toEqual({ status: "active" });

    await db.knowledgeGenerationDocument.delete({
      where: {
        generationId_documentId: {
          generationId: explicit.id,
          documentId: firstDocument.id,
        },
      },
    });
    knowledgeQueue.jobs.length = 0;
    await resumeGenerationBuild(context, db, {
      projectId: project.id,
      generationId: explicit.id,
      configFingerprint: explicit.configFingerprint,
    });
    expect(
      await db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: explicit.id,
            documentId: firstDocument.id,
          },
        },
        select: { status: true, targetSha: true },
      }),
    ).toEqual({ status: "pending", targetSha: firstDocument.headCommitSha });
    expect(knowledgeQueue.jobs).toContainEqual({
      name: "document.ai-enrich",
      data: {
        projectId: project.id,
        generationId: explicit.id,
        documentId: firstDocument.id,
        sourceCommitSha: firstDocument.headCommitSha,
        pathAtSha: firstDocument.path,
        configFingerprint: explicit.configFingerprint,
      },
    });
  });

  it("stores generation document timestamps as UTC wall-clock like Prisma writes", async () => {
    const { caller, project } = await setupEditor("generation-utc");
    await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Generation UTC",
      contentJson: parseDocumentBody("# Generation UTC\n\nSource.\n"),
    });
    const db = getPrisma();
    knowledgeQueue.jobs.length = 0;

    const generation = await ensureGenerationForCurrentConfig(
      knowledgeSystemContextForTests(),
      db,
      generationConfiguration(project.id, "generation-config-utc"),
    );
    if (!generation) throw new Error("expected a generation");

    const states = await db.knowledgeGenerationDocument.findMany({
      where: { generationId: generation.id },
    });
    expect(states).toHaveLength(1);
    expectRecentUtc(states[0]!.createdAt);
    expectRecentUtc(states[0]!.updatedAt);
  });

  it("recovers pending generation work after the initial queue send fails", async () => {
    const { caller, project } = await setupEditor(
      "generation-enqueue-recovery",
    );
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Generation Enqueue Recovery",
      contentJson: parseDocumentBody(
        "# Generation Enqueue Recovery\n\nRecover this source.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const configuration = generationConfiguration(
      project.id,
      "generation-enqueue-recovery-config",
    );
    const enqueueFailure = vi
      .spyOn(knowledgeQueue, "send")
      .mockRejectedValueOnce(new Error("queue unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const generation = await ensureGenerationForCurrentConfig(
        context,
        db,
        configuration,
      );
      if (!generation) throw new Error("expected a generation");
      expect(consoleError).toHaveBeenCalledWith(
        "Knowledge enqueue failed after generation commit (ref none)",
      );
      expect(
        await db.knowledgeGenerationDocument.findUnique({
          where: {
            generationId_documentId: {
              generationId: generation.id,
              documentId: document.id,
            },
          },
          select: { status: true },
        }),
      ).toEqual({ status: "pending" });

      enqueueFailure.mockRestore();
      knowledgeQueue.jobs.length = 0;
      const resumed = await ensureGenerationForCurrentConfig(
        context,
        db,
        configuration,
      );

      expect(resumed?.id).toBe(generation.id);
      expect(knowledgeQueue.jobs).toEqual([
        {
          name: "document.ai-enrich",
          data: {
            projectId: project.id,
            generationId: generation.id,
            documentId: document.id,
            sourceCommitSha: document.headCommitSha,
            pathAtSha: document.path,
            configFingerprint: configuration.configFingerprint,
          },
        },
      ]);
    } finally {
      enqueueFailure.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("deduplicates repeated ensure and reconciliation before a pending claim", async () => {
    const { caller, project } = await setupEditor(
      "generation-enqueue-idempotency",
    );
    await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Generation Enqueue Idempotency",
      contentJson: parseDocumentBody(
        "# Generation Enqueue Idempotency\n\nQueue this target once.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const configuration = generationConfiguration(
      project.id,
      "generation-enqueue-idempotency-config",
    );
    knowledgeQueue.jobs.length = 0;

    const generations = await Promise.all([
      ensureGenerationForCurrentConfig(context, db, configuration),
      ensureGenerationForCurrentConfig(context, db, configuration),
    ]);
    await Promise.all([
      reconcileProjectKnowledge(context, db, project.id),
      reconcileProjectKnowledge(context, db, project.id),
    ]);

    expect(generations[0]?.id).toBe(generations[1]?.id);
    expect(
      knowledgeQueue.jobs.filter((job) => job.name === "document.ai-enrich"),
    ).toHaveLength(1);
  });

  it("requeues an expired processing claim for durable recovery", async () => {
    const { caller, project } = await setupEditor("generation-expired-claim");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Generation Expired Claim",
      contentJson: parseDocumentBody(
        "# Generation Expired Claim\n\nRecover abandoned processing.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const configuration = generationConfiguration(
      project.id,
      "generation-expired-claim-config",
    );
    const generation = await ensureGenerationForCurrentConfig(
      context,
      db,
      configuration,
    );
    if (!generation) throw new Error("expected a generation");
    await db.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId: generation.id,
          documentId: document.id,
        },
      },
      data: {
        status: "processing",
        attempts: 1,
        lastAttemptAt: new Date(
          Date.now() - (KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS + 60) * 1_000,
        ),
      },
    });
    knowledgeQueue.jobs.length = 0;

    await ensureGenerationForCurrentConfig(context, db, configuration);

    expect(knowledgeQueue.jobs).toEqual([
      {
        name: "document.ai-enrich",
        data: {
          projectId: project.id,
          generationId: generation.id,
          documentId: document.id,
          sourceCommitSha: document.headCommitSha,
          pathAtSha: document.path,
          configFingerprint: generation.configFingerprint,
        },
      },
    ]);
  });

  it("requires every persisted identity field before reusing a generation", async () => {
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const cases = [
      { name: "schema", persisted: { extractionSchemaVersion: 2 } },
      { name: "dimensions", persisted: { embeddingDimensions: 3 } },
    ] as const;

    for (const identityCase of cases) {
      const project = await makeProject(
        `Generation identity ${identityCase.name}`,
      );
      const configuration = generationConfiguration(
        project.id,
        `generation-identity-${identityCase.name}`,
      );
      const prior = await db.knowledgeGeneration.create({
        data: {
          ...configuration,
          ...identityCase.persisted,
          status: "active",
        },
      });

      const ensured = await ensureGenerationForCurrentConfig(
        context,
        db,
        configuration,
      );

      expect(ensured?.id).not.toBe(prior.id);
      expect(
        await db.knowledgeGeneration.findUnique({
          where: { id: ensured!.id },
          select: {
            configFingerprint: true,
            promptVersion: true,
            extractionSchemaVersion: true,
            embeddingModel: true,
            embeddingDimensions: true,
          },
        }),
      ).toEqual({
        configFingerprint: configuration.configFingerprint,
        promptVersion: configuration.promptVersion,
        extractionSchemaVersion: configuration.extractionSchemaVersion,
        embeddingModel: configuration.embeddingModel,
        embeddingDimensions: configuration.embeddingDimensions,
      });
    }
  });

  it("reuses the active generation when only prompt version or embedding model name differ", async () => {
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const project = await makeProject("Generation provenance only");
    const configuration = generationConfiguration(
      project.id,
      "provenance-only",
    );
    const prior = await db.knowledgeGeneration.create({
      data: {
        ...configuration,
        promptVersion: "prompt-v0",
        embeddingModel: "qwen/qwen3-embedding-4b",
        status: "active",
      },
    });

    const ensured = await ensureGenerationForCurrentConfig(
      context,
      db,
      configuration,
    );

    expect(ensured?.id).toBe(prior.id);
  });

  it("activates a zero-document generation after snapshot and resume", async () => {
    const firstProject = await makeProject("Zero document snapshot");
    const secondProject = await makeProject("Zero document resume");
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();

    const snapshotted = await startGenerationBuild(
      context,
      db,
      generationConfiguration(firstProject.id, "zero-document-snapshot"),
    );
    if (!snapshotted) throw new Error("expected a generation");
    expect(
      await db.knowledgeGeneration.findUnique({
        where: { id: snapshotted.id },
        select: { status: true, documentTotal: true },
      }),
    ).toEqual({ status: "active", documentTotal: 0 });

    const building = await db.knowledgeGeneration.create({
      data: {
        projectId: secondProject.id,
        configFingerprint: "zero-document-resume",
        embeddingModel: embeddingIdentity.embeddingModel,
        embeddingDimensions: embeddingIdentity.embeddingDimensions,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "building",
      },
    });
    await resumeGenerationBuild(context, db, {
      projectId: secondProject.id,
      generationId: building.id,
      configFingerprint: building.configFingerprint,
    });
    expect(
      await db.knowledgeGeneration.findUnique({
        where: { id: building.id },
        select: { status: true, documentTotal: true },
      }),
    ).toEqual({ status: "active", documentTotal: 0 });
  });

  it("snapshots generation documents in stable pages with a continuation", async () => {
    const project = await makeProject("Paged generation snapshot");
    const db = getPrisma();
    const now = new Date();
    const documents = Array.from({ length: 205 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, "0");
      return {
        id: `00000000-0000-4000-8000-${suffix}`,
        projectId: project.id,
        path: `paged-${index + 1}.md`,
        slug: `paged-${index + 1}`,
        title: `Paged ${index + 1}`,
        excerpt: "Paged source",
        headCommitSha: (index + 1).toString(16).padStart(40, "0"),
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      };
    });
    await db.document.createMany({ data: documents });
    const context = knowledgeSystemContextForTests();

    const generation = await startGenerationBuild(
      context,
      db,
      generationConfiguration(project.id, "paged-generation"),
    );
    if (!generation) throw new Error("expected a generation");

    expect(
      await db.knowledgeGenerationDocument.count({
        where: { generationId: generation.id },
      }),
    ).toBe(200);
    const firstPageAiJobs = knowledgeQueue.jobs.filter(
      (job) => job.name === "document.ai-enrich",
    );
    const continuation = knowledgeQueue.jobs.find(
      (job) => job.name === "project.generation-build",
    );
    expect(firstPageAiJobs).toHaveLength(200);
    expect(continuation).toMatchObject({
      data: {
        projectId: project.id,
        generationId: generation.id,
        configFingerprint: generation.configFingerprint,
        cursor: documents[199]!.id,
      },
    });

    if (continuation?.name !== "project.generation-build") {
      throw new Error("expected a generation continuation");
    }
    await resumeGenerationBuild(context, db, continuation.data);

    expect(
      await db.knowledgeGenerationDocument.count({
        where: { generationId: generation.id },
      }),
    ).toBe(205);
    expect(
      knowledgeQueue.jobs.filter((job) => job.name === "document.ai-enrich"),
    ).toHaveLength(205);
    expect(
      await db.knowledgeGeneration.findUnique({
        where: { id: generation.id },
        select: { documentTotal: true, status: true },
      }),
    ).toEqual({ documentTotal: 205, status: "building" });

    await db.$executeRaw`
      UPDATE "KnowledgeGenerationDocument"
      SET "semanticIndexedSha" = "targetSha",
          "graphIndexedSha" = "targetSha",
          "status" = 'ready',
          "completedAt" = now(),
          "updatedAt" = now()
      WHERE "generationId" = ${generation.id}::uuid
    `;
    await expect(
      activateCompletedGeneration(context, db, {
        projectId: project.id,
        generationId: generation.id,
      }),
    ).resolves.toBe(true);
    await expect(
      db.knowledgeGeneration.findUnique({
        where: { id: generation.id },
        select: {
          documentTotal: true,
          documentReadyCount: true,
          documentFailedCount: true,
          status: true,
        },
      }),
    ).resolves.toEqual({
      documentTotal: 205,
      documentReadyCount: 205,
      documentFailedCount: 0,
      status: "active",
    });

    const blocked = await db.knowledgeGeneration.create({
      data: generationConfiguration(project.id, "paged-blocked"),
    });
    knowledgeQueue.jobs.length = 0;
    await blockGenerationBuildForConfiguration(context, db, {
      projectId: project.id,
      generationId: blocked.id,
      configFingerprint: blocked.configFingerprint,
    });
    expect(
      await db.knowledgeGenerationDocument.count({
        where: { generationId: blocked.id },
      }),
    ).toBe(200);
    const blockedContinuation = knowledgeQueue.jobs.find(
      (job) => job.name === "project.generation-build",
    );
    if (blockedContinuation?.name !== "project.generation-build") {
      throw new Error("expected a blocked-generation continuation");
    }
    await blockGenerationBuildForConfiguration(
      context,
      db,
      blockedContinuation.data,
    );
    await expect(
      db.knowledgeGeneration.findUnique({
        where: { id: blocked.id },
        select: { documentTotal: true, documentFailedCount: true },
      }),
    ).resolves.toEqual({ documentTotal: 205, documentFailedCount: 205 });
  });

  it("stops provider work and publication when an enrichment lease is aborted", async () => {
    const { context, db, document, generation, project } =
      await setupEnrichmentDocument("lease-abort");
    const controller = new AbortController();
    let providerCalls = 0;
    const provider: AiProvider = {
      embeddingRequestByteLength,
      async embed(values) {
        providerCalls += 1;
        controller.abort(new DOMException("Lease expired", "AbortError"));
        return {
          vectors: values.map(() => Array(1536).fill(0.2) as number[]),
          usage: successfulExtractionUsage,
        };
      },
      async extract() {
        providerCalls += 1;
        return {
          data: { entities: [], relations: [] },
          usage: successfulExtractionUsage,
        };
      },
    };

    await expect(
      processGenerationDocument(
        context,
        db,
        provider,
        {
          projectId: project.id,
          generationId: generation.id,
          documentId: document.id,
          sourceCommitSha: document.headCommitSha,
          pathAtSha: document.path,
          configFingerprint: generation.configFingerprint,
          ...enrichmentIdentity,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(providerCalls).toBe(1);
    expect(
      await db.knowledgeEmbedding.count({
        where: { generationId: generation.id },
      }),
    ).toBe(0);
    expect(
      await db.entityMention.count({ where: { generationId: generation.id } }),
    ).toBe(0);
    expect(
      await db.aiUsage.findMany({
        where: { documentId: document.id },
        select: { operation: true, outcome: true, inputTokens: true },
      }),
    ).toEqual([
      {
        operation: "document_chunk_embedding",
        outcome: "stale_discarded",
        inputTokens: successfulExtractionUsage.inputTokens,
      },
    ]);
  });

  it("records completed embedding calls as stale_discarded when a later batch is aborted", async () => {
    const fixture = await setupEmbeddingDocument("abort-usage");
    const controller = new AbortController();
    let providerCalls = 0;
    const provider: AiProvider = {
      ...embeddingProvider(async (input) => {
        providerCalls += 1;
        if (providerCalls === 2) {
          controller.abort(new DOMException("Lease expired", "AbortError"));
          throw new DOMException("Embedding aborted", "AbortError");
        }
        return {
          vectors: input.map(() => Array(1536).fill(0.3) as number[]),
          usage: {
            inputTokens: 4,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: 4,
            durationMs: 2,
          },
        };
      }),
      embeddingCharacterBudget: () => 1,
    };

    await expect(
      embedGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          sourceCommitSha: fixture.document.headCommitSha,
          configFingerprint: fixture.generation.configFingerprint,
          ...embeddingIdentity,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(providerCalls).toBe(2);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { documentId: fixture.document.id },
        select: { operation: true, outcome: true, inputTokens: true },
      }),
    ).toEqual([
      {
        operation: "document_chunk_embedding",
        outcome: "stale_discarded",
        inputTokens: 4,
      },
    ]);
  });

  it("records completed extraction calls as stale_discarded when a later chunk is aborted", async () => {
    const fixture = await setupEmbeddingDocument("abort-extraction-usage");
    const controller = new AbortController();
    let extractionCalls = 0;
    let embeddingCalls = 0;
    const provider = enrichmentProvider({
      async extract() {
        extractionCalls += 1;
        if (extractionCalls === 2) {
          controller.abort(new DOMException("Lease expired", "AbortError"));
          throw new DOMException("Extraction aborted", "AbortError");
        }
        return {
          data: { entities: [], relations: [] },
          usage: successfulExtractionUsage,
        };
      },
      async embed() {
        embeddingCalls += 1;
        throw new Error("not used");
      },
    });

    await expect(
      enrichGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          sourceCommitSha: fixture.document.headCommitSha,
          configFingerprint: fixture.generation.configFingerprint,
          ...enrichmentIdentity,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(extractionCalls).toBe(2);
    expect(embeddingCalls).toBe(0);
    expect(
      await fixture.db.entityMention.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { documentId: fixture.document.id },
        select: { operation: true, outcome: true, inputTokens: true },
      }),
    ).toEqual([
      {
        operation: "document_graph_extraction",
        outcome: "stale_discarded",
        inputTokens: successfulExtractionUsage.inputTokens,
      },
    ]);
  });

  it("records a completed extraction rejected during cancellation as stale_discarded", async () => {
    const fixture = await setupEmbeddingDocument("abort-rejected-extraction");
    const controller = new AbortController();
    const rejectedUsage = {
      inputTokens: 5,
      outputTokens: 3,
      cachedTokens: 0,
      totalTokens: 8,
      durationMs: 2,
    };
    let extractionCalls = 0;
    const provider = enrichmentProvider({
      async extract() {
        extractionCalls += 1;
        controller.abort(new DOMException("Lease expired", "AbortError"));
        // What extractWithCorrection rethrows when cancelled during a correction turn.
        throw new AiProviderError("AI provider returned invalid extraction", {
          kind: "validation",
          retryable: false,
          usage: rejectedUsage,
          details: { stage: "schema" },
        });
      },
      async embed() {
        throw new Error("not used");
      },
    });

    await expect(
      enrichGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          sourceCommitSha: fixture.document.headCommitSha,
          configFingerprint: fixture.generation.configFingerprint,
          ...enrichmentIdentity,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(extractionCalls).toBe(1);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { documentId: fixture.document.id },
        select: { operation: true, outcome: true, inputTokens: true },
      }),
    ).toEqual([
      {
        operation: "document_graph_extraction",
        outcome: "stale_discarded",
        inputTokens: rejectedUsage.inputTokens,
      },
    ]);
  });

  it("records a completed entity embedding rejected during cancellation as stale_discarded", async () => {
    const fixture = await setupEmbeddingDocument(
      "abort-rejected-entity-embedding",
    );
    const controller = new AbortController();
    const rejectedUsage = {
      inputTokens: 9,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 9,
      durationMs: 2,
    };
    let embeddingCalls = 0;
    const provider = enrichmentProvider({
      async embed() {
        embeddingCalls += 1;
        controller.abort(new DOMException("Lease expired", "AbortError"));
        throw new AiProviderError("AI provider returned invalid embeddings", {
          kind: "validation",
          retryable: false,
          usage: rejectedUsage,
        });
      },
    });

    await expect(
      enrichGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          sourceCommitSha: fixture.document.headCommitSha,
          configFingerprint: fixture.generation.configFingerprint,
          ...enrichmentIdentity,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(embeddingCalls).toBe(1);
    expect(
      await fixture.db.entityMention.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    // The fixture document has two heading sections, so two extraction chunks.
    expect(
      await fixture.db.aiUsage.findMany({
        where: { documentId: fixture.document.id },
        orderBy: { operation: "asc" },
        select: { operation: true, outcome: true, inputTokens: true },
      }),
    ).toEqual([
      {
        operation: "document_graph_extraction",
        outcome: "stale_discarded",
        inputTokens: successfulExtractionUsage.inputTokens,
      },
      {
        operation: "document_graph_extraction",
        outcome: "stale_discarded",
        inputTokens: successfulExtractionUsage.inputTokens,
      },
      {
        operation: "entity_embedding",
        outcome: "stale_discarded",
        inputTokens: rejectedUsage.inputTokens,
      },
    ]);
  });

  it("records a completed chunk embedding rejected during cancellation as stale_discarded", async () => {
    const fixture = await setupEmbeddingDocument(
      "abort-rejected-chunk-embedding",
    );
    const controller = new AbortController();
    const rejectedUsage = {
      inputTokens: 6,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 6,
      durationMs: 2,
    };
    let providerCalls = 0;
    const provider = embeddingProvider(async () => {
      providerCalls += 1;
      controller.abort(new DOMException("Lease expired", "AbortError"));
      throw new AiProviderError("AI provider returned invalid embeddings", {
        kind: "validation",
        retryable: false,
        usage: rejectedUsage,
      });
    });

    await expect(
      embedGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          sourceCommitSha: fixture.document.headCommitSha,
          configFingerprint: fixture.generation.configFingerprint,
          ...embeddingIdentity,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(providerCalls).toBe(1);
    expect(
      await fixture.db.knowledgeEmbedding.count({
        where: { generationId: fixture.generation.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { documentId: fixture.document.id },
        select: { operation: true, outcome: true, inputTokens: true },
      }),
    ).toEqual([
      {
        operation: "document_chunk_embedding",
        outcome: "stale_discarded",
        inputTokens: rejectedUsage.inputTokens,
      },
    ]);
  });

  it("keeps completed embedding usage when enrichment outlives its deadline", async () => {
    const fixture = await setupEmbeddingDocument("deadline-usage");
    let providerCalls = 0;
    const provider: AiProvider = {
      ...enrichmentProvider({}),
      embeddingCharacterBudget: () => 1,
      embed(values, options) {
        providerCalls += 1;
        if (providerCalls === 1) {
          return Promise.resolve({
            vectors: values.map(() => Array(1536).fill(0.3) as number[]),
            usage: {
              inputTokens: 4,
              outputTokens: 0,
              cachedTokens: 0,
              totalTokens: 4,
              durationMs: 2,
            },
          });
        }
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Embedding aborted", "AbortError")),
          );
        });
      },
    };

    await expect(
      processGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        {
          projectId: fixture.project.id,
          generationId: fixture.generation.id,
          documentId: fixture.document.id,
          sourceCommitSha: fixture.document.headCommitSha,
          pathAtSha: fixture.document.path,
          configFingerprint: fixture.generation.configFingerprint,
          ...enrichmentIdentity,
        },
        { deadlineMs: 2_000 },
      ),
    ).rejects.toThrow("AI enrichment exceeded its time budget");

    expect(providerCalls).toBe(2);
    expect(
      await fixture.db.aiUsage.findMany({
        where: { documentId: fixture.document.id },
        select: { operation: true, outcome: true, inputTokens: true },
      }),
    ).toEqual([
      {
        operation: "document_chunk_embedding",
        outcome: "stale_discarded",
        inputTokens: 4,
      },
    ]);
  });

  it("classifies retryable document failures and activates after a successful retry", async () => {
    const { caller, project } = await setupEditor("generation-processing");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Generation Processing",
      contentJson: parseDocumentBody(
        "# Generation Processing\n\nRetry this source.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    const generation = await startGenerationBuild(
      context,
      db,
      generationConfiguration(project.id, "generation-processing-config"),
    );
    if (!generation) throw new Error("expected a processing generation");
    let failEmbedding = true;
    const retryableError = new AiProviderError("AI provider request failed", {
      kind: "provider",
      retryable: true,
    });
    const provider = enrichmentProvider({
      async embed(values) {
        if (failEmbedding) throw retryableError;
        return {
          vectors: values.map(() => Array(1536).fill(0.2) as number[]),
          usage: {
            inputTokens: values.length,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: values.length,
            durationMs: 3,
          },
        };
      },
      async extract() {
        return {
          data: { entities: [], relations: [] },
          usage: successfulExtractionUsage,
        };
      },
    });
    const input = {
      projectId: project.id,
      generationId: generation.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      configFingerprint: generation.configFingerprint,
      ...enrichmentIdentity,
    };

    await expect(
      processGenerationDocument(context, db, provider, input),
    ).rejects.toBe(retryableError);
    expect(
      await db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        select: {
          status: true,
          attempts: true,
          failureKind: true,
          failureSummary: true,
        },
      }),
    ).toEqual({
      status: "failed",
      attempts: 1,
      failureKind: "provider",
      failureSummary: "AI provider request failed",
    });
    expect(
      await db.knowledgeGeneration.findUnique({
        where: { id: generation.id },
        select: { documentFailedCount: true, status: true },
      }),
    ).toEqual({ documentFailedCount: 1, status: "building" });

    failEmbedding = false;
    await expect(
      processGenerationDocument(context, db, provider, input),
    ).resolves.toEqual({ outcome: "ready" });
    expect(
      await db.knowledgeGeneration.findUnique({
        where: { id: generation.id },
        select: {
          status: true,
          documentTotal: true,
          documentReadyCount: true,
          documentFailedCount: true,
        },
      }),
    ).toEqual({
      status: "active",
      documentTotal: 1,
      documentReadyCount: 1,
      documentFailedCount: 0,
    });
  });

  it("does not overwrite missing with ready when deletion wins before final state", async () => {
    const { caller, project } = await setupEditor(
      "generation-ready-delete-race",
    );
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Ready Delete Race",
      contentJson: parseDocumentBody(
        "# Ready Delete Race\n\nDelete after publication.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    const generation = await startGenerationBuild(
      context,
      db,
      generationConfiguration(project.id, "generation-ready-delete-race"),
    );
    if (!generation) throw new Error("expected a generation");
    const input = {
      projectId: project.id,
      generationId: generation.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      configFingerprint: generation.configFingerprint,
      ...enrichmentIdentity,
    };

    await deleteDocumentBeforeTransaction(
      db,
      5,
      {
        projectId: project.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
      },
      () =>
        processGenerationDocument(
          context,
          db,
          enrichmentProvider({
            async extract() {
              return {
                data: { entities: [], relations: [] },
                usage: successfulExtractionUsage,
              };
            },
          }),
          input,
        ),
    );

    expect(
      await db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        select: { status: true, failureKind: true },
      }),
    ).toEqual({ status: "missing", failureKind: "source_missing" });
  });

  it("does not overwrite missing with failure when deletion wins before final state", async () => {
    const { caller, project } = await setupEditor(
      "generation-failure-delete-race",
    );
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Failure Delete Race",
      contentJson: parseDocumentBody(
        "# Failure Delete Race\n\nDelete after failure.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    const generation = await startGenerationBuild(
      context,
      db,
      generationConfiguration(project.id, "generation-failure-delete-race"),
    );
    if (!generation) throw new Error("expected a generation");
    const providerFailure = new AiProviderError("provider unavailable", {
      kind: "provider",
      retryable: true,
    });

    await expect(
      deleteDocumentBeforeTransaction(
        db,
        3,
        {
          projectId: project.id,
          documentId: document.id,
          sourceCommitSha: document.headCommitSha,
        },
        () =>
          processGenerationDocument(
            context,
            db,
            enrichmentProvider({
              async embed() {
                throw providerFailure;
              },
            }),
            {
              projectId: project.id,
              generationId: generation.id,
              documentId: document.id,
              sourceCommitSha: document.headCommitSha,
              pathAtSha: document.path,
              configFingerprint: generation.configFingerprint,
              ...enrichmentIdentity,
            },
          ),
      ),
    ).rejects.toBe(providerFailure);
    expect(
      await db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        select: { status: true, failureKind: true },
      }),
    ).toEqual({ status: "missing", failureKind: "source_missing" });
  });

  it("does not overwrite missing with blocked when deletion wins before final state", async () => {
    const { caller, project } = await setupEditor(
      "generation-blocked-delete-race",
    );
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Blocked Delete Race",
      contentJson: parseDocumentBody(
        "# Blocked Delete Race\n\nDelete before blocking.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const generation = await startGenerationBuild(
      context,
      db,
      generationConfiguration(project.id, "generation-blocked-delete-race"),
    );
    if (!generation) throw new Error("expected a generation");

    await deleteDocumentBeforeTransaction(
      db,
      2,
      {
        projectId: project.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
      },
      () =>
        blockGenerationDocumentForConfiguration(context, db, {
          projectId: project.id,
          generationId: generation.id,
          documentId: document.id,
          sourceCommitSha: document.headCommitSha,
          pathAtSha: document.path,
          configFingerprint: generation.configFingerprint,
        }),
    );
    expect(
      await db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        select: { status: true, failureKind: true },
      }),
    ).toEqual({ status: "missing", failureKind: "source_missing" });
  });

  it("allows only one identical job to claim and run provider work", async () => {
    const { caller, project } = await setupEditor("generation-claim-race");
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Generation Claim Race",
      contentJson: parseDocumentBody(
        "# Generation Claim Race\n\nOnly one worker may publish this source.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    const generation = await startGenerationBuild(
      context,
      db,
      generationConfiguration(project.id, "generation-claim-race-config"),
    );
    if (!generation) throw new Error("expected a generation");
    const providerEntered = deferred();
    const releaseProvider = deferred();
    let embedCalls = 0;
    let extractCalls = 0;
    const provider = enrichmentProvider({
      async embed(values) {
        embedCalls += 1;
        providerEntered.resolve();
        await releaseProvider.promise;
        return {
          vectors: values.map(() => Array(1536).fill(0.4) as number[]),
          usage: {
            inputTokens: values.length,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: values.length,
            durationMs: 2,
          },
        };
      },
      async extract() {
        extractCalls += 1;
        return {
          data: { entities: [], relations: [] },
          usage: successfulExtractionUsage,
        };
      },
    });
    const input = {
      projectId: project.id,
      generationId: generation.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      configFingerprint: generation.configFingerprint,
      ...enrichmentIdentity,
    };

    const first = processGenerationDocument(context, db, provider, input);
    await providerEntered.promise;
    const second = processGenerationDocument(context, db, provider, input);
    const observedSecond = await Promise.race([
      second.then((outcome) => ({ settled: true as const, outcome })),
      new Promise<{ settled: false }>((resolve) =>
        setTimeout(() => resolve({ settled: false }), 100),
      ),
    ]);
    releaseProvider.resolve();
    const outcomes = await Promise.all([first, second]);

    expect(observedSecond).toEqual({
      settled: true,
      outcome: { outcome: "stale" },
    });
    expect(outcomes).toEqual([{ outcome: "ready" }, { outcome: "stale" }]);
    expect({ embedCalls, extractCalls }).toEqual({
      embedCalls: 1,
      extractCalls: 1,
    });
    expect(
      await db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        select: { attempts: true, status: true },
      }),
    ).toEqual({ attempts: 1, status: "ready" });
    expect(
      await db.knowledgeEmbedding.count({
        where: { generationId: generation.id },
      }),
    ).toBe(1);

    knowledgeQueue.jobs.length = 0;
    await recordDocumentChangeForGenerations(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    expect(knowledgeQueue.jobs).toEqual([]);
  });

  it("does not reclaim an exact controlled failure", async () => {
    const { caller, project } = await setupEditor(
      "generation-controlled-claim",
    );
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Generation Controlled Claim",
      contentJson: parseDocumentBody(
        "# Generation Controlled Claim\n\nDo not repeat invalid work.\n",
      ),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    const generation = await startGenerationBuild(
      context,
      db,
      generationConfiguration(project.id, "generation-controlled-claim-config"),
    );
    if (!generation) throw new Error("expected a generation");
    let providerCalls = 0;
    const validationFailure = new AiProviderError("invalid embedding", {
      kind: "validation",
      retryable: false,
    });
    const provider = enrichmentProvider({
      async embed() {
        providerCalls += 1;
        throw validationFailure;
      },
    });
    const input = {
      projectId: project.id,
      generationId: generation.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      configFingerprint: generation.configFingerprint,
      ...enrichmentIdentity,
    };

    await expect(
      processGenerationDocument(context, db, provider, input),
    ).resolves.toEqual({ outcome: "failed" });
    await expect(
      processGenerationDocument(context, db, provider, input),
    ).resolves.toEqual({ outcome: "stale" });

    expect(providerCalls).toBe(1);
    expect(
      await db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        select: { attempts: true, status: true },
      }),
    ).toEqual({ attempts: 1, status: "failed" });
  });

  it("marks a building generation failed without disturbing the active fallback", async () => {
    const { caller, project } = await setupEditor("failed-generation-fallback");
    await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Failed Generation Fallback",
      contentJson: parseDocumentBody(
        "# Failed Generation Fallback\n\nKeep the candidate building.\n",
      ),
    });
    const db = getPrisma();
    const context = knowledgeSystemContextForTests();
    const active = await db.knowledgeGeneration.create({
      data: {
        ...generationConfiguration(project.id, "failed-active"),
        status: "active",
      },
    });
    const building = await startGenerationBuild(
      context,
      db,
      generationConfiguration(project.id, "failed-building"),
    );
    if (!building) throw new Error("expected a failed candidate");

    await expect(
      failGeneration(context, db, {
        projectId: project.id,
        generationId: building.id,
        failureKind: "internal",
        failureSummary: `  ${"failure ".repeat(60)}  `,
      }),
    ).resolves.toBe(true);
    const generations = await db.knowledgeGeneration.findMany({
      where: { id: { in: [active.id, building.id] } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        status: true,
        failureKind: true,
        failureSummary: true,
      },
    });
    expect(
      generations.find((generation) => generation.id === active.id),
    ).toMatchObject({
      status: "active",
      failureKind: null,
      failureSummary: null,
    });
    const failed = generations.find(
      (generation) => generation.id === building.id,
    );
    expect(failed).toMatchObject({ status: "failed", failureKind: "internal" });
    expect(failed?.failureSummary).toHaveLength(300);
  });

  it("keeps the active generation queryable until a complete shadow cuts over", async () => {
    const { caller, project } = await setupEditor("generation-shadow");
    const firstDocument = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Shadow First",
      contentJson: parseDocumentBody("# Shadow First\n\nFirst source.\n"),
    });
    const secondDocument = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Shadow Second",
      contentJson: parseDocumentBody("# Shadow Second\n\nSecond source.\n"),
    });
    const context = knowledgeSystemContextForTests();
    const db = getPrisma();
    const active = await startGenerationBuild(
      context,
      db,
      generationConfiguration(project.id, "generation-config-old"),
    );
    if (!active) throw new Error("expected an active candidate");
    await markLiveGenerationDocumentsReady(db, project.id, active.id);
    await activateCompletedGeneration(context, db, {
      projectId: project.id,
      generationId: active.id,
    });

    const shadowConfiguration = generationConfiguration(
      project.id,
      "generation-config-new",
    );
    const shadow = await ensureGenerationForCurrentConfig(
      context,
      db,
      shadowConfiguration,
    );
    if (!shadow) throw new Error("expected a shadow generation");
    const shadowStates = await db.knowledgeGenerationDocument.findMany({
      where: { generationId: shadow.id },
      orderBy: { documentId: "asc" },
    });
    await db.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId: shadow.id,
          documentId: shadowStates[0]!.documentId,
        },
      },
      data: {
        semanticIndexedSha: shadowStates[0]!.targetSha,
        graphIndexedSha: shadowStates[0]!.targetSha,
        status: "ready",
      },
    });
    await db.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId: shadow.id,
          documentId: shadowStates[1]!.documentId,
        },
      },
      data: {
        status: "failed",
        failureKind: "provider",
        failureSummary: "Provider unavailable",
      },
    });

    await expect(
      activateCompletedGeneration(context, db, {
        projectId: project.id,
        generationId: shadow.id,
      }),
    ).resolves.toBe(false);
    expect(
      await db.knowledgeGeneration.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          status: true,
          documentTotal: true,
          documentReadyCount: true,
          documentFailedCount: true,
        },
      }),
    ).toEqual([
      {
        id: active.id,
        status: "active",
        documentTotal: 2,
        documentReadyCount: 2,
        documentFailedCount: 0,
      },
      {
        id: shadow.id,
        status: "building",
        documentTotal: 2,
        documentReadyCount: 1,
        documentFailedCount: 1,
      },
    ]);

    const duringBuild = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Committed During Build",
      contentJson: parseDocumentBody(
        "# Committed During Build\n\nNewest source.\n",
      ),
    });
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: duringBuild.id,
      sourceCommitSha: duringBuild.headCommitSha,
      pathAtSha: duringBuild.path,
    });
    knowledgeQueue.jobs.length = 0;
    await recordDocumentChangeForGenerations(context, db, {
      projectId: project.id,
      documentId: duringBuild.id,
      sourceCommitSha: duringBuild.headCommitSha,
      pathAtSha: duringBuild.path,
    });

    expect(
      await db.knowledgeGenerationDocument.findMany({
        where: {
          documentId: duringBuild.id,
          generationId: { in: [active.id, shadow.id] },
        },
        orderBy: { generationId: "asc" },
        select: { generationId: true, targetSha: true, status: true },
      }),
    ).toEqual(
      [active.id, shadow.id].sort().map((generationId) => ({
        generationId,
        targetSha: duringBuild.headCommitSha,
        status: "pending",
      })),
    );
    const generationJobs = [...knowledgeQueue.jobs].sort((left, right) => {
      if (
        left.name !== "document.ai-enrich" ||
        right.name !== "document.ai-enrich"
      ) {
        return left.name.localeCompare(right.name);
      }
      return left.data.generationId.localeCompare(right.data.generationId);
    });
    expect(generationJobs).toEqual(
      [active, shadow]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((generation) => ({
          name: "document.ai-enrich" as const,
          data: {
            projectId: project.id,
            generationId: generation.id,
            documentId: duringBuild.id,
            sourceCommitSha: duringBuild.headCommitSha,
            pathAtSha: duringBuild.path,
            configFingerprint: generation.configFingerprint,
          },
        })),
    );

    await markLiveGenerationDocumentsReady(db, project.id, shadow.id);
    await expect(
      activateCompletedGeneration(context, db, {
        projectId: project.id,
        generationId: shadow.id,
      }),
    ).resolves.toBe(true);
    const activatedGenerations = await db.knowledgeGeneration.findMany({
      where: { id: { in: [active.id, shadow.id] } },
      orderBy: { id: "asc" },
      select: { id: true, status: true, supersededAt: true },
    });
    expect(
      activatedGenerations.map(({ id, status }) => ({ id, status })),
    ).toEqual(
      [
        { id: active.id, status: "superseded" },
        { id: shadow.id, status: "active" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(
      activatedGenerations.find((generation) => generation.id === active.id)
        ?.supersededAt,
    ).toBeInstanceOf(Date);
    expect(
      activatedGenerations.find((generation) => generation.id === shadow.id)
        ?.supersededAt,
    ).toBeNull();
    expect(firstDocument.id).not.toBe(secondDocument.id);
  });

  it("invalidates deleted content across active and building generations", async () => {
    const project = await makeProject("Knowledge deletion");
    const db = getPrisma();
    const context = knowledgeSystemContextForTests();
    const documentId = randomUUID();
    const tableId = randomUUID();
    const sourceCommitSha = "d".repeat(40);
    const now = new Date();
    await db.document.create({
      data: {
        id: documentId,
        projectId: project.id,
        path: "deleted.md",
        slug: "deleted",
        title: "Deleted",
        excerpt: "Deleted source",
        headCommitSha: sourceCommitSha,
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.dataTable.create({
      data: {
        id: tableId,
        projectId: project.id,
        path: "tables/deleted",
        slug: "deleted-table",
        title: "Deleted table",
        rowCount: 0,
        headCommitSha: sourceCommitSha,
        lastEditedAt: now,
        createdAt: now,
      },
    });
    const active = await db.knowledgeGeneration.create({
      data: {
        ...generationConfiguration(project.id, "delete-active"),
        status: "active",
      },
    });
    const building = await db.knowledgeGeneration.create({
      data: generationConfiguration(project.id, "delete-building"),
    });
    await db.knowledgeGenerationDocument.createMany({
      data: [active, building].map((generation) => ({
        generationId: generation.id,
        projectId: project.id,
        documentId,
        targetSha: sourceCommitSha,
        semanticIndexedSha: sourceCommitSha,
        graphIndexedSha: sourceCommitSha,
        configFingerprint: generation.configFingerprint,
        status: "ready" as const,
      })),
    });
    await db.documentIndexState.create({
      data: {
        documentId,
        projectId: project.id,
        targetSha: sourceCommitSha,
        keywordIndexedSha: sourceCommitSha,
        status: "ready",
      },
    });
    await db.tableSearchProjection.create({
      data: {
        tableId,
        projectId: project.id,
        sourceCommitSha,
        title: "Deleted table",
        schemaText: "Name (text)",
      },
    });
    const sourceEntity = await db.graphEntity.create({
      data: {
        projectId: project.id,
        generationId: active.id,
        entityType: "Concept",
        canonicalName: "Source",
        normalizedName: "source",
      },
    });
    const targetEntity = await db.graphEntity.create({
      data: {
        projectId: project.id,
        generationId: active.id,
        entityType: "Concept",
        canonicalName: "Target",
        normalizedName: "target",
      },
    });
    const relation = await db.graphRelation.create({
      data: {
        projectId: project.id,
        generationId: active.id,
        sourceEntityId: sourceEntity.id,
        targetEntityId: targetEntity.id,
        relationType: "References",
        normalizedType: "references",
      },
    });
    const mention = await db.entityMention.create({
      data: {
        projectId: project.id,
        generationId: active.id,
        entityId: sourceEntity.id,
        documentId,
        sourceChunkId: "deleted-chunk",
        sourceCommitSha,
        mentionText: "Source",
        confidence: 0.8,
      },
    });
    const evidence = await db.relationEvidence.create({
      data: {
        projectId: project.id,
        generationId: active.id,
        relationId: relation.id,
        documentId,
        sourceChunkId: "deleted-chunk",
        sourceCommitSha,
        evidenceText: "Source references Target",
        confidence: 0.75,
      },
    });
    await db.document.delete({ where: { id: documentId } });
    await db.dataTable.delete({ where: { id: tableId } });

    await deleteKnowledgeContent(context, db, {
      projectId: project.id,
      sourceType: "document",
      sourceId: documentId,
      sourceCommitSha,
    });
    await deleteKnowledgeContent(context, db, {
      projectId: project.id,
      sourceType: "table",
      sourceId: tableId,
      sourceCommitSha,
    });

    expect(
      await db.knowledgeGenerationDocument.findMany({
        where: { documentId },
        orderBy: { generationId: "asc" },
        select: { status: true, failureKind: true },
      }),
    ).toEqual([
      { status: "missing", failureKind: "source_missing" },
      { status: "missing", failureKind: "source_missing" },
    ]);
    expect(
      await db.documentIndexState.findUnique({ where: { documentId } }),
    ).toBeNull();
    expect(
      await db.tableSearchProjection.findUnique({ where: { tableId } }),
    ).toBeNull();
    const invalidatedMention = await db.entityMention.findUnique({
      where: { id: mention.id },
      select: { invalidatedAt: true },
    });
    const invalidatedEvidence = await db.relationEvidence.findUnique({
      where: { id: evidence.id },
      select: { invalidatedAt: true },
    });
    expect(invalidatedMention?.invalidatedAt).toBeInstanceOf(Date);
    expect(invalidatedEvidence?.invalidatedAt).toBeInstanceOf(Date);
  });

  it("retains the newest superseded fallback and all generations newer than seven days", async () => {
    const db = getPrisma();
    const context = knowledgeSystemContextForTests();
    const now = new Date("2026-08-30T12:00:00.000Z");
    const fallbackProject = await makeProject("Generation fallback cleanup");
    const oldFallbacks = [];
    for (const [index, ageDays] of [30, 20, 10].entries()) {
      oldFallbacks.push(
        await db.knowledgeGeneration.create({
          data: {
            ...generationConfiguration(fallbackProject.id, `fallback-${index}`),
            status: "superseded",
            supersededAt: new Date(now.getTime() - ageDays * 86_400_000),
          },
        }),
      );
    }

    await expect(
      cleanupSupersededGenerations(context, db, fallbackProject.id, now),
    ).resolves.toBe(2);
    expect(
      await db.knowledgeGeneration.findMany({
        where: { projectId: fallbackProject.id },
        select: { id: true },
      }),
    ).toEqual([{ id: oldFallbacks[2]!.id }]);

    const recentProject = await makeProject("Recent generation cleanup");
    const recentGenerations = [];
    for (const [index, ageDays] of [15, 6, 1].entries()) {
      recentGenerations.push(
        await db.knowledgeGeneration.create({
          data: {
            ...generationConfiguration(recentProject.id, `recent-${index}`),
            status: "superseded",
            supersededAt: new Date(now.getTime() - ageDays * 86_400_000),
          },
        }),
      );
    }
    await cleanupSupersededGenerations(context, db, recentProject.id, now);
    expect(
      await db.knowledgeGeneration.findMany({
        where: { projectId: recentProject.id },
        orderBy: { supersededAt: "asc" },
        select: { id: true },
      }),
    ).toEqual([
      { id: recentGenerations[1]!.id },
      { id: recentGenerations[2]!.id },
    ]);
  });

  it("queues one reconciliation job per live project in stable pages", async () => {
    const first = await makeProject("Reconcile first");
    const second = await makeProject("Reconcile second");
    const deleted = await makeProject("Reconcile deleted");
    await getPrisma().project.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    knowledgeQueue.jobs.length = 0;

    await reconcileAllProjects(knowledgeSystemContextForTests(), getPrisma());

    expect(knowledgeQueue.jobs).toEqual(
      [first.id, second.id].sort().map((projectId) => ({
        name: "project.reconcile" as const,
        data: { projectId },
      })),
    );
  });
  it("review regression: unchanged document rebuild preserves chunks and anchors", async () => {
    const fixture = await setupEnrichmentDocument("rebuild-preserve");
    const { db, project, document } = fixture;
    const member = await db.member.findFirstOrThrow({
      where: { organization: { project: { id: project.id } } },
    });
    await db.member.update({
      where: { id: member.id },
      data: { role: "maintainer" },
    });
    const before = await db.documentSearchChunk.findMany({
      where: { documentId: document.id },
    });
    expect(before.length).toBeGreaterThan(0);
    await fixture.caller.document.rebuildIndex({ projectId: project.id });
    expect(
      await db.documentSearchChunk.findMany({
        where: { documentId: document.id },
      }),
    ).toEqual(before);
    await reconcileProjectKnowledge(fixture.context, db, project.id);
    expect(
      await db.documentSearchChunk.findMany({
        where: { documentId: document.id },
      }),
    ).toEqual(before);
  });

  it("review regression: reconciliation repairs a stale generation target after keyword publication", async () => {
    const fixture = await setupEnrichmentDocument("stale-target-repair");
    const { db, project, document, generation, context } = fixture;
    const saved = await fixture.caller.document.update({
      projectId: project.id,
      documentId: document.id,
      baseCommitSha: document.headCommitSha,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("New source text."),
      },
      changeSummary: "Advance source",
    });
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: saved.headCommitSha,
      pathAtSha: saved.path,
    });
    await reconcileProjectKnowledge(context, db, project.id);
    expect(
      await db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
      }),
    ).toMatchObject({ targetSha: saved.headCommitSha });
    await expect(
      processGenerationDocument(
        context,
        db,
        enrichmentProvider({
          extract: async () => ({
            data: { entities: [], relations: [] },
            usage: successfulExtractionUsage,
          }),
        }),
        {
          projectId: project.id,
          generationId: generation.id,
          documentId: document.id,
          sourceCommitSha: saved.headCommitSha,
          pathAtSha: saved.path,
          configFingerprint: generation.configFingerprint,
          ...enrichmentIdentity,
        },
      ),
    ).resolves.toEqual({ outcome: "ready" });
    knowledgeQueue.jobs.length = 0;
    await reconcileProjectKnowledge(context, db, project.id);
    expect(knowledgeQueue.jobs).toEqual([]);
  });

  it("review regression: entity embedding requests fit serialized multilingual byte limits", async () => {
    const fixture = await setupEnrichmentDocument("entity-byte-budget");
    const sizes: number[] = [];
    const provider = enrichmentProvider({
      async extract() {
        return {
          data: {
            entities: Array.from({ length: 12 }, (_, index) => ({
              key: `entity-${index}`,
              name: `Entity ${index}`,
              type: "Concept",
              description: "界".repeat(4000),
              aliases: [],
              mentionText: `Entity ${index}`,
              confidence: 0.9,
            })),
            relations: [],
          },
          usage: successfulExtractionUsage,
        };
      },
      async embed(values) {
        const bytes = embeddingRequestByteLength(values);
        sizes.push(bytes);
        if (bytes > 131072)
          throw new AiProviderError("Request too large", {
            kind: "validation",
            retryable: false,
          });
        return {
          vectors: values.map(() => Array(1536).fill(0.25) as number[]),
          usage: successfulExtractionUsage,
        };
      },
    });
    await expect(
      enrichGenerationDocument(fixture.context, fixture.db, provider, {
        projectId: fixture.project.id,
        generationId: fixture.generation.id,
        documentId: fixture.document.id,
        sourceCommitSha: fixture.document.headCommitSha,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      }),
    ).resolves.toMatchObject({ outcome: "enriched", entityCount: 12 });
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.every((size) => size <= 131072)).toBe(true);
  });

  it.each(["redelivery", "reconciliation"])(
    "review regression: %s activates a ready replacement after activation failure",
    async (recovery) => {
      const fixture = await setupEnrichmentDocument(`activation-${recovery}`);
      const { db, context, project, document } = fixture;
      await db.knowledgeGeneration.update({
        where: { id: fixture.generation.id },
        data: { status: "active" },
      });
      const generation = await startGenerationBuild(
        context,
        db,
        generationConfiguration(
          project.id,
          fixture.generation.configFingerprint,
        ),
      );
      if (!generation) throw new Error("missing generation");
      const input = {
        projectId: project.id,
        generationId: generation.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
        configFingerprint: generation.configFingerprint,
        ...enrichmentIdentity,
      };
      const provider = enrichmentProvider({
        extract: async () => ({
          data: { entities: [], relations: [] },
          usage: successfulExtractionUsage,
        }),
      });
      const realTransaction = db.$transaction.bind(db);
      const spy = vi.spyOn(db, "$transaction");
      spy.mockImplementation((async (
        callback: Parameters<typeof realTransaction>[0],
      ) => {
        const ready = await db.knowledgeGenerationDocument.findFirst({
          where: { generationId: generation.id, status: "ready" },
        });
        if (ready) {
          spy.mockRestore();
          throw new Error("Injected activation failure");
        }
        return realTransaction(callback);
      }) as typeof db.$transaction);
      try {
        await expect(
          processGenerationDocument(context, db, provider, input),
        ).rejects.toThrow("Injected activation failure");
      } finally {
        spy.mockRestore();
      }
      expect(
        await db.knowledgeGeneration.findUniqueOrThrow({
          where: { id: generation.id },
        }),
      ).toMatchObject({ status: "building", documentReadyCount: 1 });
      if (recovery === "redelivery")
        await processGenerationDocument(context, db, provider, input);
      else await reconcileProjectKnowledge(context, db, project.id);
      expect(
        await db.knowledgeGeneration.findUniqueOrThrow({
          where: { id: generation.id },
        }),
      ).toMatchObject({ status: "active" });
    },
  );
  it("review regression: rebuilding a missing document projection schedules its lost chunks for repair", async () => {
    const fixture = await setupEnrichmentDocument("missing-projection-repair");
    const { db, project, document } = fixture;
    const member = await db.member.findFirstOrThrow({
      where: { organization: { project: { id: project.id } } },
    });
    await db.member.update({
      where: { id: member.id },
      data: { role: "maintainer" },
    });
    await processGenerationDocument(
      fixture.context,
      db,
      enrichmentProvider({}),
      {
        projectId: project.id,
        generationId: fixture.generation.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
        configFingerprint: fixture.generation.configFingerprint,
        ...enrichmentIdentity,
      },
    );
    const semanticChunks = () =>
      db.$queryRaw<
        Array<{ ownerId: string; navigationAnchor: string | null }>
      >(Prisma.sql`
      SELECT embedding."ownerId", chunk."navigationAnchor"
      FROM "KnowledgeEmbedding" AS embedding
      JOIN "DocumentSearchChunk" AS chunk ON chunk."id" = embedding."ownerId"
      WHERE embedding."generationId" = ${fixture.generation.id}::uuid AND embedding."ownerType" = 'document_chunk'
      ORDER BY embedding."ownerId"
    `);
    const beforeSemantic = await semanticChunks();
    expect(beforeSemantic.length).toBeGreaterThan(0);
    const mentions = await db.entityMention.findMany({
      where: { generationId: fixture.generation.id },
      select: { sourceChunkId: true },
    });
    expect(mentions.length).toBeGreaterThan(0);
    await db.document.delete({ where: { id: document.id } });
    expect(await semanticChunks()).toEqual([]);
    knowledgeQueue.jobs.length = 0;
    await fixture.caller.document.rebuildIndex({ projectId: project.id });
    await reconcileProjectKnowledge(fixture.context, db, project.id);
    expect(knowledgeQueue.jobs).toContainEqual({
      name: "document.search-sync",
      data: {
        projectId: project.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
      },
    });
    await syncDocumentKeywordIndex(fixture.context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    expect(
      await db.documentSearchChunk.count({
        where: { documentId: document.id },
      }),
    ).toBeGreaterThan(0);
    expect(await semanticChunks()).toEqual(beforeSemantic);
    for (const mention of mentions) {
      expect(
        await db.documentSearchChunk.findUnique({
          where: { id: mention.sourceChunkId },
        }),
      ).toMatchObject({ navigationAnchor: expect.any(String) });
    }
    expect(
      await db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: fixture.generation.id,
            documentId: document.id,
          },
        },
      }),
    ).toMatchObject({
      status: "ready",
      semanticIndexedSha: document.headCommitSha,
      graphIndexedSha: document.headCommitSha,
    });
  });

  it("reconciliation activates a completed empty replacement alongside an active generation", async () => {
    const { project } = await setupEditor("empty-building-repair");
    const db = getPrisma();
    const config = generationConfiguration(project.id, "empty-config");
    const first = await db.knowledgeGeneration.create({
      data: { ...config, status: "active" },
    });
    const replacement = await db.knowledgeGeneration.create({
      data: { ...config, status: "building" },
    });
    await reconcileProjectKnowledge(
      knowledgeSystemContextForTests(),
      db,
      project.id,
    );
    expect(
      await db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: replacement.id },
      }),
    ).toMatchObject({ status: "active", documentTotal: 0 });
    expect(
      await db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).toMatchObject({ status: "superseded" });
  });
  it("finds a partial document title below H1 and preserves it through rebuild", async () => {
    const { caller, project, editor } = await setupEditor("h1-partial-title");
    await getPrisma().member.updateMany({
      where: { userId: editor.id },
      data: { role: "maintainer" },
    });
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Quarterly Budget",
      contentJson: parseDocumentBody("# Overview\n\nUnrelated body prose."),
    });
    await syncDocumentKeywordIndex(
      knowledgeSystemContextForTests(),
      getPrisma(),
      {
        projectId: project.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
      },
    );
    const before = await caller.search.query({
      query: "Quarterly",
      projectIds: [project.id],
    });
    expect(before.documents).toEqual([
      expect.objectContaining({ documentId: document.id }),
    ]);
    await caller.document.rebuildIndex({ projectId: project.id });
    expect(
      (
        await caller.search.query({
          query: "Quarterly",
          projectIds: [project.id],
        })
      ).documents,
    ).toEqual(before.documents);
  });
  it("rolls back document rebuild without losing chunks when projection acknowledgement fails", async () => {
    const fixture = await setupEnrichmentDocument("rebuild-rollback");
    const { db, project, document } = fixture;
    const member = await db.member.findFirstOrThrow({
      where: { organization: { project: { id: project.id } } },
    });
    await db.member.update({
      where: { id: member.id },
      data: { role: "maintainer" },
    });
    const before = await db.documentSearchChunk.findMany({
      where: { documentId: document.id },
    });
    const original = db.$transaction.bind(db);
    const spy = vi.spyOn(db, "$transaction");
    spy.mockImplementationOnce((async (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) =>
      original(async (tx) => {
        await callback(tx);
        throw new Error("Injected rebuild projection failure");
      })) as unknown as typeof db.$transaction);
    try {
      await expect(
        fixture.caller.document.rebuildIndex({ projectId: project.id }),
      ).rejects.toThrow("Injected rebuild projection failure");
    } finally {
      spy.mockRestore();
    }
    expect(
      await db.documentSearchChunk.findMany({
        where: { documentId: document.id },
      }),
    ).toEqual(before);
    await fixture.caller.document.rebuildIndex({ projectId: project.id });
    await reconcileProjectKnowledge(fixture.context, db, project.id);
    expect(
      await db.documentSearchChunk.findMany({
        where: { documentId: document.id },
      }),
    ).toEqual(before);
  });
  it("retains unchanged chunk vectors across a new SHA and prunes obsolete owners", async () => {
    const { context, db, project, document, generation, caller } =
      await setupEnrichmentDocument("reuse-revision");
    const input = {
      projectId: project.id,
      generationId: generation.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      configFingerprint: generation.configFingerprint,
      ...enrichmentIdentity,
    };
    await embedGenerationDocument(context, db, enrichmentProvider({}), input);
    const old = await db.knowledgeEmbedding.findMany({
      where: { generationId: generation.id },
    });
    const updated = await caller.document.update({
      projectId: project.id,
      documentId: document.id,
      baseCommitSha: document.headCommitSha,
      title: "Renamed source",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody(
          "# Graph Source\n\nAcme uses Atlas for operations.\n",
        ),
      },
      changeSummary: "Rename unchanged body",
    });
    const payload = {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: updated.headCommitSha,
      pathAtSha: updated.path,
    };
    await syncDocumentKeywordIndex(context, db, payload);
    await recordDocumentChangeForGenerations(context, db, payload);
    const provider = embeddingProvider(async () => {
      throw new Error("Unchanged text must reuse its vector");
    });
    await expect(
      embedGenerationDocument(context, db, provider, {
        ...input,
        sourceCommitSha: updated.headCommitSha,
      }),
    ).resolves.toMatchObject({ embeddedCount: 0, reusedCount: old.length });
    expect(
      await db.knowledgeEmbedding.count({
        where: { generationId: generation.id },
      }),
    ).toBe(old.length);
    expect(
      await db.knowledgeEmbedding.count({
        where: { ownerId: { in: old.map((row) => row.ownerId) } },
      }),
    ).toBe(0);
  });

  it("does not merge an alias from an incomplete candidate scan", async () => {
    const fixture = await setupEnrichmentDocument("alias-overflow");
    const existing = [];
    for (let index = 0; index < 17; index += 1) {
      existing.push(
        await fixture.db.graphEntity.create({
          data: {
            projectId: fixture.project.id,
            generationId: fixture.generation.id,
            canonicalName: `Candidate ${index}`,
            normalizedName: `candidate ${index}`,
            entityType: index === 0 || index === 16 ? "person" : "organization",
            createdAt: new Date(1_000 + index),
            aliases: {
              create: {
                projectId: fixture.project.id,
                alias: "shared",
                normalizedAlias: "shared",
              },
            },
          },
        }),
      );
    }
    const provider = enrichmentProvider({
      async extract() {
        return {
          data: {
            entities: [
              {
                key: "person",
                name: "shared",
                type: "person",
                aliases: [],
                description: "Unresolved person",
                mentionText: "shared",
                confidence: 0.8,
              },
            ],
            relations: [],
          },
          usage: successfulExtractionUsage,
        };
      },
    });
    await enrichGenerationDocument(fixture.context, fixture.db, provider, {
      projectId: fixture.project.id,
      generationId: fixture.generation.id,
      documentId: fixture.document.id,
      sourceCommitSha: fixture.document.headCommitSha,
      configFingerprint: fixture.generation.configFingerprint,
      ...enrichmentIdentity,
    });
    const mention = await fixture.db.entityMention.findFirstOrThrow({
      where: { documentId: fixture.document.id },
    });
    expect(existing.map((entity) => entity.id)).not.toContain(mention.entityId);
  });

  it("refreshes descriptions from current sources and invalidates changed entity vectors on deletion", async () => {
    const f = await setupEnrichmentDocument("current-descriptions");
    const provider = (description: string, confidence: number) =>
      enrichmentProvider({
        async extract() {
          return {
            data: {
              entities: [
                {
                  key: "alice",
                  name: "Alice",
                  type: "person",
                  aliases: [],
                  description,
                  mentionText: "Alice",
                  confidence,
                },
              ],
              relations: [],
            },
            usage: successfulExtractionUsage,
          };
        },
      });
    const input = {
      projectId: f.project.id,
      generationId: f.generation.id,
      documentId: f.document.id,
      sourceCommitSha: f.document.headCommitSha,
      configFingerprint: f.generation.configFingerprint,
      ...enrichmentIdentity,
    };
    await enrichGenerationDocument(
      f.context,
      f.db,
      provider("Alice is CEO", 0.9),
      input,
    );
    const other = await f.caller.document.create({
      projectId: f.project.id,
      folderPath: [],
      title: "Other source",
      contentJson: parseDocumentBody("Alice founded the company."),
    });
    const otherPayload = {
      projectId: f.project.id,
      documentId: other.id,
      sourceCommitSha: other.headCommitSha,
      pathAtSha: other.path,
    };
    await syncDocumentKeywordIndex(f.context, f.db, otherPayload);
    await recordDocumentChangeForGenerations(f.context, f.db, otherPayload);
    await enrichGenerationDocument(
      f.context,
      f.db,
      provider("Alice is founder", 0.7),
      { ...input, documentId: other.id, sourceCommitSha: other.headCommitSha },
    );
    const updated = await f.caller.document.update({
      projectId: f.project.id,
      documentId: f.document.id,
      baseCommitSha: f.document.headCommitSha,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("Alice is CFO."),
      },
      changeSummary: "Correct Alice role",
    });
    const payload = {
      projectId: f.project.id,
      documentId: f.document.id,
      sourceCommitSha: updated.headCommitSha,
      pathAtSha: updated.path,
    };
    await syncDocumentKeywordIndex(f.context, f.db, payload);
    await recordDocumentChangeForGenerations(f.context, f.db, payload);
    await enrichGenerationDocument(
      f.context,
      f.db,
      provider("Alice is CFO", 0.9),
      { ...input, sourceCommitSha: updated.headCommitSha },
    );
    const entity = await f.db.graphEntity.findFirstOrThrow({
      where: { generationId: f.generation.id },
    });
    expect(entity.description).toBe("Alice is CFO");
    expect(
      await f.db.entityMention.count({
        where: {
          entityId: entity.id,
          sourceDescription: "Alice is CFO",
          invalidatedAt: null,
        },
      }),
    ).toBe(1);
    expect(
      await f.db.knowledgeEmbedding.count({
        where: { ownerType: "entity", ownerId: entity.id },
      }),
    ).toBe(1);
    await f.db.document.delete({ where: { id: f.document.id } });
    await deleteKnowledgeContent(f.context, f.db, {
      projectId: f.project.id,
      sourceType: "document",
      sourceId: f.document.id,
      sourceCommitSha: updated.headCommitSha,
    });
    expect(
      (await f.db.graphEntity.findUniqueOrThrow({ where: { id: entity.id } }))
        .description,
    ).toBe("Alice is founder");
    expect(
      await f.db.knowledgeEmbedding.count({
        where: { ownerType: "entity", ownerId: entity.id },
      }),
    ).toBe(0);

    // The entity still has live provenance in the other document: reconciliation
    // must notice the missing vector and send that document through enrichment.
    await f.db.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId: f.generation.id,
          documentId: other.id,
        },
      },
      data: {
        status: "ready",
        processingClaimToken: randomUUID(),
        lastAttemptAt: new Date(0),
        targetSha: other.headCommitSha,
        semanticIndexedSha: other.headCommitSha,
        graphIndexedSha: other.headCommitSha,
        completedAt: new Date(),
      },
    });
    knowledgeQueue.jobs.length = 0;
    await reconcileProjectKnowledge(f.context, f.db, f.project.id);
    expect(
      knowledgeQueue.jobs
        .filter((job) => job.name === "document.ai-enrich")
        .map((job) => job.data),
    ).toContainEqual(
      expect.objectContaining({
        documentId: other.id,
        sourceCommitSha: other.headCommitSha,
        generationId: f.generation.id,
      }),
    );

    // The repair embeds the stored entity text; it never re-extracts.
    const extract = vi.fn();
    const embedded: string[][] = [];
    const repairProvider = enrichmentProvider({
      extract,
      async embed(texts: string[]) {
        embedded.push(texts);
        return {
          vectors: texts.map(() => Array(1536).fill(0.1) as number[]),
          usage: {
            inputTokens: texts.length,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: texts.length,
            durationMs: 4,
          },
        };
      },
    });
    const repairInput = {
      ...input,
      documentId: other.id,
      sourceCommitSha: other.headCommitSha,
    };
    expect(
      await repairMissingEntityEmbeddings(f.db, repairProvider, repairInput),
    ).toBe(1);
    expect(extract).not.toHaveBeenCalled();
    expect(embedded.flat().join("\n")).toContain("Alice is founder");
    expect(
      (
        await f.db.knowledgeGenerationDocument.findUniqueOrThrow({
          where: {
            generationId_documentId: {
              generationId: f.generation.id,
              documentId: other.id,
            },
          },
        })
      ).processingClaimToken,
    ).toBeNull();
    expect(
      await f.db.knowledgeEmbedding.count({
        where: { ownerType: "entity", ownerId: entity.id },
      }),
    ).toBe(1);
    expect(
      await repairMissingEntityEmbeddings(f.db, repairProvider, repairInput),
    ).toBe(0);

    knowledgeQueue.jobs.length = 0;
    await reconcileProjectKnowledge(f.context, f.db, f.project.id);
    expect(
      knowledgeQueue.jobs.filter((job) => job.name === "document.ai-enrich"),
    ).toEqual([]);
  });

  it("checks source ancestry and preserves retryability of operational Git failures", async () => {
    const f = await setupEnrichmentDocument("source-ancestry");
    const payload = {
      projectId: f.project.id,
      documentId: f.document.id,
      sourceCommitSha: f.document.headCommitSha,
      pathAtSha: f.document.path,
    };
    const original = gitStore.withExistingProjectRepoReader;
    const spy = vi.spyOn(gitStore, "withExistingProjectRepoReader");
    try {
      spy.mockImplementation((projectId, useRepo) =>
        original(projectId, (repo) =>
          useRepo({ ...repo, isAncestor: async () => false }),
        ),
      );
      await expect(
        loadDocumentIndexSource(f.context, f.db, payload),
      ).resolves.toBeNull();
      spy.mockImplementation((projectId, useRepo) =>
        original(projectId, (repo) =>
          useRepo({
            ...repo,
            isAncestor: async () => {
              throw new Error("Git temporarily unavailable");
            },
          }),
        ),
      );
      await expect(
        syncDocumentKeywordIndex(f.context, f.db, payload),
      ).rejects.toThrow("Git temporarily unavailable");
      expect(
        (
          await f.db.documentIndexState.findUniqueOrThrow({
            where: { documentId: f.document.id },
          })
        ).status,
      ).toBe("ready");
    } finally {
      spy.mockRestore();
    }
  });
});

function expectRecentUtc(value: Date | null | undefined): void {
  expect(value).toBeInstanceOf(Date);
  expect(Math.abs(value!.getTime() - Date.now())).toBeLessThan(60_000);
}
