import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { registerKnowledgeJobHandlers } from "@weaver/core/jobs/runtime";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  invalidateLlmRouteCache,
  resolveKnowledgeRouting,
} from "@weaver/core/services/llmRoutes";
import { searchKnowledge } from "@weaver/core/services/search";

import {
  getPrisma,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
} from "./_harness";
import {
  indexProject,
  sizedProvider,
  sizedRoutingSource,
  type ProviderCalls,
} from "./_knowledgePipeline";

describe("knowledge embeddings at configurable sizes", () => {
  let queue: FakeJobQueue;
  const calls: ProviderCalls = { extract: [], embed: [] };

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
      context: knowledgeSystemContextForTests(),
      db: getPrisma(),
      config: parseKnowledgeConfig({ WEAVER_JOBS_ENABLED: "true" }),
      routing: sizedRoutingSource(calls),
    });
  });
  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it.each([1024, 1000, 2560])(
    "indexes and searches %i-dimension vectors",
    async (size) => {
      const db = getPrisma();
      const { routing } = await seedTestLlmRouting();
      await db.llmModel.update({
        where: { id: routing.embedding.modelId },
        data: { embeddingDimensions: size },
      });
      invalidateLlmRouteCache();
      const live = (await resolveKnowledgeRouting(db))!;
      expect(live.embeddingDimensions).toBe(size);

      const { editor, project } = await indexProject(queue, ["Alpha", "Beta"]);

      const generation = await db.knowledgeGeneration.findFirstOrThrow({
        where: { projectId: project.id, status: "active" },
      });
      expect(generation.embeddingDimensions).toBe(size);
      const stored = await db.$queryRaw<Array<{ dims: number }>>`
        SELECT DISTINCT vector_dims("embedding") AS dims
        FROM "KnowledgeEmbedding" WHERE "generationId" = ${generation.id}::uuid
      `;
      expect(stored).toEqual([{ dims: size }]);

      const result = await searchKnowledge(
        db,
        { query: "Alpha", projectIds: [project.id] },
        securityContextFor(editor),
        { routing: live, provider: sizedProvider(size, calls) },
      );
      expect(result.mode).toBe("hybrid");
      expect(result.partial).toEqual([]);
      expect(result.documents.map((row) => row.title)).toContain("Alpha");
    },
  );
});
