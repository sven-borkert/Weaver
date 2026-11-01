import { randomUUID } from "node:crypto";

import type { KnowledgeRoutingSource } from "@weaver/core/ai/registry";
import {
  AiProviderError,
  type AiProvider,
  type ExtractionRequest,
} from "@weaver/core/ai/types";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import type { FakeJobQueue } from "@weaver/core/jobs/queue";
import type { KnowledgeJobName } from "@weaver/core/jobs/types";
import { resolveKnowledgeRouting } from "@weaver/core/services/llmRoutes";

import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
} from "./_harness";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  totalTokens: 2,
  durationMs: 1,
};

/** A deterministic unit vector with `size` components seeded by the text. */
export function textVector(text: string, size: number): number[] {
  const seed = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const raw = Array.from(
    { length: size },
    (_, i) => Math.sin(seed + i * 0.37) + 1.1,
  );
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

export type ProviderCalls = {
  extract: ExtractionRequest[];
  embed: string[][];
  /** When set, embedding an entity's canonical text fails with a retryable provider error. */
  rejectEntityEmbeddings?: boolean;
};

/** Embeds at the routed size; extracts the document's topic plus a shared "Weaver" entity related to it. */
export function sizedProvider(size: number, calls: ProviderCalls): AiProvider {
  return {
    embeddingRequestByteLength: (input) =>
      Buffer.byteLength(JSON.stringify({ input })),
    async embed(input) {
      calls.embed.push([...input]);
      if (
        calls.rejectEntityEmbeddings &&
        input.some((text) => text.includes("\nType: "))
      ) {
        throw new AiProviderError("Provider unavailable", {
          kind: "provider",
          retryable: true,
        });
      }
      return {
        vectors: input.map((text) => textVector(text, size)),
        usage: { ...usage, outputTokens: 0 },
      };
    },
    async extract(request) {
      calls.extract.push(request);
      return {
        usage,
        data: {
          entities: [
            {
              key: "topic",
              name: request.title,
              type: "Topic",
              aliases: [`${request.title} topic`],
              description: `About ${request.title}`,
              mentionText: request.title,
              confidence: 0.9,
            },
            {
              key: "weaver",
              name: "Weaver",
              type: "Product",
              aliases: [],
              description: "The knowledge platform",
              mentionText: "Weaver",
              confidence: 0.8,
            },
          ],
          relations: [
            {
              sourceKey: "topic",
              targetKey: "weaver",
              type: "part_of",
              description: `${request.title} belongs to Weaver`,
              confidence: 0.7,
              validFrom: null,
              validTo: null,
            },
          ],
        },
      };
    },
  };
}

export function sizedRoutingSource(
  calls: ProviderCalls,
): KnowledgeRoutingSource {
  const db = getPrisma();
  return {
    resolve: () => resolveKnowledgeRouting(db),
    resolveFresh: () => resolveKnowledgeRouting(db),
    providerFor: (routing) => sizedProvider(routing.embeddingDimensions, calls),
  };
}

/** Answers OpenAI-compatible embedding requests with vectors of `size()` components. */
export function sizedEmbeddingsFetch(size: () => number): typeof fetch {
  return (async (_url, init) => {
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : '{"input":[]}',
    ) as { input: string[] };
    return Response.json({
      data: body.input.map((text, index) => ({
        index,
        embedding: textVector(text, size()),
      })),
      usage: { prompt_tokens: 8, total_tokens: 8 },
    });
  }) as typeof fetch;
}

const PIPELINE_JOBS: KnowledgeJobName[] = [
  "document.search-sync",
  "document.ai-enrich",
  "content.delete",
  "project.reconcile",
  "project.generation-build",
];

export async function drain(queue: FakeJobQueue, from = 0): Promise<number> {
  let index = from;
  for (let guard = 0; index < queue.jobs.length && guard < 500; guard += 1) {
    const job = queue.jobs[index++]!;
    if (PIPELINE_JOBS.includes(job.name))
      await queue.run(job.name, job.data as never);
  }
  return index;
}

/** Creates a project with one document per title and runs the knowledge pipeline to an active generation. */
export async function indexProject(queue: FakeJobQueue, titles: string[]) {
  const editor = await makeUser("User", `dims-${randomUUID().slice(0, 8)}`);
  const project = await makeProject("Embedding dimensions");
  await addMembership(project.id, editor.id, "Maintainer");
  const caller = callerFor(editor);
  const documents = [];
  for (const title of titles) {
    documents.push(
      await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title,
        contentJson: parseDocumentBody(
          `# ${title}\n\n${title} is part of Weaver.\n`,
        ),
      }),
    );
  }
  let cursor = await drain(queue);
  await queue.run("project.reconcile", { projectId: project.id });
  cursor = await drain(queue, cursor);
  return { editor, caller, project, documents, cursor };
}
