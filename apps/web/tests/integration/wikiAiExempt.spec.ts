import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@weaver/db/client";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { aiExemptSql, isAiExempt } from "@weaver/core/knowledge/aiExempt";
import { registerKnowledgeJobHandlers } from "@weaver/core/jobs/runtime";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { rebuildIndex } from "@weaver/core/services/documents";
import { invalidateLlmRouteCache } from "@weaver/core/services/llmRoutes";
import { getDocumentKnowledge } from "@weaver/core/services/knowledgeDocument";
import {
  blockGenerationBuildForConfiguration,
  blockGenerationDocumentForConfiguration,
  flipDocumentAiExempt,
} from "@weaver/core/services/knowledgeGenerations";
import { reconcileAllProjects } from "@weaver/core/services/knowledgeReconciliation";
import { AI_INDEXING_SKIPPED_SUMMARY } from "@weaver/core/documents/indexLight";
import {
  getPrisma,
  makeWikiInputItem,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
} from "./_harness";
import {
  drain,
  indexProject,
  sizedRoutingSource,
  type ProviderCalls,
} from "./_knowledgePipeline";

const LONG = 30_000;

describe("aiExemptSql", () => {
  it("refuses an alias that is not an identifier", () => {
    expect(() => aiExemptSql('d"; DROP')).toThrow();
  });
});

describe("AI-exempt documents in the knowledge pipeline", () => {
  let queue: FakeJobQueue;
  const calls: ProviderCalls = { extract: [], embed: [] };
  const context = () => knowledgeSystemContextForTests();

  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    calls.extract.length = 0;
    calls.embed.length = 0;
    await registerKnowledgeJobHandlers({
      queue,
      context: context(),
      db: getPrisma(),
      config: parseKnowledgeConfig({ WEAVER_JOBS_ENABLED: "true" }),
      routing: sizedRoutingSource(calls),
    });
    await seedTestLlmRouting();
    invalidateLlmRouteCache();
  });
  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  const state = (generationId: string, documentId: string) =>
    getPrisma().knowledgeGenerationDocument.findFirstOrThrow({
      where: { generationId, documentId },
    });

  /** Two documents, one a linked source, indexed before the link exists. */
  async function indexedWithSource() {
    const db = getPrisma();
    const indexed = await indexProject(queue, ["Plain", "Source doc"]);
    const generation = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: indexed.project.id, status: "active" },
    });
    const source = indexed.documents[1]!;
    const itemId = await makeWikiInputItem(indexed.project.id);
    return { ...indexed, db, generation, source, itemId };
  }

  it(
    "the TypeScript and SQL forms of isAiExempt agree on every row",
    async () => {
      const { db, project, source, itemId } = await indexedWithSource();
      await db.document.update({
        where: { id: source.id },
        data: { wikiSourceItemId: itemId },
      });
      const rows = await db.$queryRaw<
        Array<{ id: string; wikiSourceItemId: string | null; exempt: boolean }>
      >(Prisma.sql`
      SELECT d."id", d."wikiSourceItemId", ${aiExemptSql("d")} AS exempt
      FROM "Document" d WHERE d."projectId" = ${project.id}::uuid
    `);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.exempt).toBe(isAiExempt(row));
      expect(rows.filter((row) => row.exempt)).toHaveLength(1);
    },
    LONG,
  );

  it(
    "flip to exempt: vectors deleted, evidence invalidated, row terminal ready, active stays",
    async () => {
      const { db, project, source, itemId, generation } =
        await indexedWithSource();
      const before = await state(generation.id, source.id);
      expect(before.status).toBe("ready");
      const invalidMentions = () =>
        db.entityMention.count({
          where: { documentId: source.id, invalidatedAt: null },
        });
      expect(await invalidMentions()).toBeGreaterThan(0);

      await db.document.update({
        where: { id: source.id },
        data: { wikiSourceItemId: itemId },
      });
      await flipDocumentAiExempt(context(), db, {
        projectId: project.id,
        documentId: source.id,
      });

      expect(await invalidMentions()).toBe(0);
      expect(
        await db.relationEvidence.count({
          where: { documentId: source.id, invalidatedAt: null },
        }),
      ).toBe(0);
      const vectors = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM "KnowledgeEmbedding" e
      JOIN "DocumentSearchChunk" c ON c."id" = e."ownerId"
      WHERE e."ownerType" = 'document_chunk' AND c."documentId" = ${source.id}::uuid
    `;
      expect(Number(vectors[0]!.count)).toBe(0);
      const after = await state(generation.id, source.id);
      expect(after).toMatchObject({
        status: "ready",
        targetSha: source.headCommitSha,
        semanticIndexedSha: source.headCommitSha,
        graphIndexedSha: source.headCommitSha,
      });
      const reloaded = await db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: generation.id },
      });
      expect(reloaded.status).toBe("active");
      expect(reloaded.documentReadyCount).toBe(reloaded.documentTotal);
    },
    LONG,
  );

  it(
    "flip back: row resets to pending and enrichment is enqueued",
    async () => {
      const { db, project, source, itemId, generation } =
        await indexedWithSource();
      await db.document.update({
        where: { id: source.id },
        data: { wikiSourceItemId: itemId },
      });
      await flipDocumentAiExempt(context(), db, {
        projectId: project.id,
        documentId: source.id,
      });
      await db.document.update({
        where: { id: source.id },
        data: { wikiSourceItemId: null },
      });
      const cursor = queue.jobs.length;
      await flipDocumentAiExempt(context(), db, {
        projectId: project.id,
        documentId: source.id,
      });
      expect(await state(generation.id, source.id)).toMatchObject({
        status: "pending",
        semanticIndexedSha: null,
        graphIndexedSha: null,
      });
      expect(
        queue.jobs
          .slice(cursor)
          .filter((job) => job.name === "document.ai-enrich"),
      ).toHaveLength(1);
      await drain(queue, cursor);
      expect((await state(generation.id, source.id)).status).toBe("ready");
      expect(
        await db.entityMention.count({
          where: { documentId: source.id, invalidatedAt: null },
        }),
      ).toBeGreaterThan(0);
    },
    LONG,
  );

  it(
    "an edit to an exempt page makes no provider call and stays complete",
    async () => {
      const { db, caller, project, source, itemId, generation } =
        await indexedWithSource();
      await db.wikiInputItem.update({
        where: { id: itemId },
        data: { sourceDocumentId: source.id },
      });
      await db.document.update({
        where: { id: source.id },
        data: { wikiSourceItemId: itemId },
      });
      await flipDocumentAiExempt(context(), db, {
        projectId: project.id,
        documentId: source.id,
      });
      calls.extract.length = 0;
      calls.embed.length = 0;
      const cursor = queue.jobs.length;
      const edited = await caller.document.update({
        projectId: project.id,
        documentId: source.id,
        baseCommitSha: source.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Edited by a human.\n"),
        },
        changeSummary: "human edit",
      });
      await drain(queue, cursor);
      expect(calls.extract).toEqual([]);
      expect(calls.embed).toEqual([]);
      expect(await state(generation.id, source.id)).toMatchObject({
        status: "ready",
        targetSha: edited.headCommitSha,
        semanticIndexedSha: edited.headCommitSha,
        graphIndexedSha: edited.headCommitSha,
      });
      // A human edit never clears the link.
      expect(
        (await db.document.findUniqueOrThrow({ where: { id: source.id } }))
          .wikiSourceItemId,
      ).toBe(itemId);
    },
    LONG,
  );

  it(
    "a new build completes and activates with an exempt document",
    async () => {
      const { db, project, source, itemId } = await indexedWithSource();
      await db.document.update({
        where: { id: source.id },
        data: { wikiSourceItemId: itemId },
      });
      await flipDocumentAiExempt(context(), db, {
        projectId: project.id,
        documentId: source.id,
      });
      calls.extract.length = 0;
      const llm = await db.llmModel.findFirstOrThrow({
        where: { embeddingDimensions: { not: null } },
      });
      await db.llmModel.update({
        where: { id: llm.id },
        data: { embeddingDimensions: 1000 },
      });
      invalidateLlmRouteCache();
      const cursor = queue.jobs.length;
      await queue.run("project.reconcile", { projectId: project.id });
      await drain(queue, cursor);
      const active = await db.knowledgeGeneration.findFirstOrThrow({
        where: { projectId: project.id, status: "active" },
      });
      expect(active.embeddingDimensions).toBe(1000);
      expect(await state(active.id, source.id)).toMatchObject({
        status: "ready",
        semanticIndexedSha: source.headCommitSha,
      });
      expect(
        calls.extract.filter((request) => request.title === "Source doc"),
      ).toEqual([]);
    },
    LONG,
  );

  it(
    "the route-block paths leave an exempt document ready",
    async () => {
      const { db, project, source, itemId, generation } =
        await indexedWithSource();
      await db.document.update({
        where: { id: source.id },
        data: { wikiSourceItemId: itemId },
      });
      await blockGenerationDocumentForConfiguration(context(), db, {
        projectId: project.id,
        documentId: source.id,
        generationId: generation.id,
        configFingerprint: generation.configFingerprint,
        sourceCommitSha: source.headCommitSha,
        pathAtSha: source.path,
      });
      expect((await state(generation.id, source.id)).status).toBe("ready");

      await db.knowledgeGeneration.update({
        where: { id: generation.id },
        data: { status: "building" },
      });
      await blockGenerationBuildForConfiguration(context(), db, {
        projectId: project.id,
        generationId: generation.id,
        configFingerprint: generation.configFingerprint,
      });
      expect((await state(generation.id, source.id)).status).toBe("ready");
    },
    LONG,
  );

  it(
    "reconcile enqueues nothing for a complete exempt row; a rebuild flips on a changed link",
    async () => {
      const { db, editor, project, source, itemId, generation } =
        await indexedWithSource();
      const actor = securityContextFor(editor);
      // The projection lost its link; the item still names the page.
      await db.wikiInputItem.update({
        where: { id: itemId },
        data: { sourceDocumentId: source.id },
      });
      await rebuildIndex(db, { projectId: project.id }, actor);
      expect(
        (await db.document.findUniqueOrThrow({ where: { id: source.id } }))
          .wikiSourceItemId,
      ).toBe(itemId);
      expect(
        await db.entityMention.count({
          where: { documentId: source.id, invalidatedAt: null },
        }),
      ).toBe(0);
      const row = await state(generation.id, source.id);
      expect(row.status).toBe("ready");

      await reconcileAllProjects(context(), db);
      const cursor = queue.jobs.length;
      await queue.run("project.reconcile", { projectId: project.id });
      expect(
        queue.jobs
          .slice(cursor)
          .filter((job) => job.name === "document.ai-enrich"),
      ).toEqual([]);
    },
    LONG,
  );

  it(
    "the document index read shows the skip",
    async () => {
      const { db, editor, project, source, itemId } = await indexedWithSource();
      await db.document.update({
        where: { id: source.id },
        data: { wikiSourceItemId: itemId },
      });
      const index = await getDocumentKnowledge(
        db,
        { projectId: project.id, documentId: source.id },
        securityContextFor(editor),
      );
      expect(index.lights).toMatchObject({
        semantic: "skipped",
        graph: "skipped",
        summary: AI_INDEXING_SKIPPED_SUMMARY,
      });
    },
    LONG,
  );
});
