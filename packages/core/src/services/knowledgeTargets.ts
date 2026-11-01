import { Prisma, type PrismaClient } from "@weaver/db/client";

type Db = PrismaClient | Prisma.TransactionClient;
type TargetIdentity = {
  projectId: string;
  generationId: string;
  documentId: string;
  sourceCommitSha: string;
  configFingerprint: string;
  embeddingModel: string;
  embeddingDimensions: number;
  processingClaimToken?: string;
};
export type KnowledgeTarget = {
  generationId: string;
  title: string;
  semanticIndexedSha: string | null;
  graphIndexedSha: string | null;
};

export async function lockLiveKnowledgeProject(
  db: Db,
  projectId: string,
): Promise<boolean> {
  const [project] = await db.$queryRaw<
    Array<{ deletedAt: Date | null }>
  >(Prisma.sql`
    SELECT "deletedAt" FROM "Project" WHERE "id" = ${projectId}::uuid FOR NO KEY UPDATE
  `);
  return project?.deletedAt === null;
}

export async function loadKnowledgeTarget(
  db: Db,
  input: TargetIdentity,
  options: { lock?: boolean; requireKeywordReady?: boolean } = {},
): Promise<KnowledgeTarget | null> {
  if (options.lock && !(await lockLiveKnowledgeProject(db, input.projectId)))
    return null;
  const keywordJoin = options.requireKeywordReady
    ? Prisma.sql`
    JOIN "DocumentIndexState" AS keyword_state
      ON keyword_state."documentId" = state."documentId"
     AND keyword_state."projectId" = ${input.projectId}::uuid
     AND keyword_state."targetSha" = ${input.sourceCommitSha}
     AND keyword_state."keywordIndexedSha" = ${input.sourceCommitSha}
     AND keyword_state."status" = 'ready'
  `
    : Prisma.empty;
  const lock = options.lock
    ? options.requireKeywordReady
      ? Prisma.sql`FOR UPDATE OF generation, state, keyword_state, document`
      : Prisma.sql`FOR UPDATE OF generation, state, document`
    : Prisma.empty;
  const [target] = await db.$queryRaw<KnowledgeTarget[]>(Prisma.sql`
    SELECT generation."id" AS "generationId", document."title",
           state."semanticIndexedSha", state."graphIndexedSha"
    FROM "KnowledgeGeneration" AS generation
    JOIN "KnowledgeGenerationDocument" AS state
      ON state."generationId" = generation."id"
     AND state."documentId" = ${input.documentId}::uuid
     AND state."projectId" = ${input.projectId}::uuid
     AND state."targetSha" = ${input.sourceCommitSha}
     AND state."configFingerprint" = ${input.configFingerprint}
     AND (state."processingClaimToken" IS NOT DISTINCT FROM ${input.processingClaimToken ?? null}::uuid
       ${input.processingClaimToken ? Prisma.empty : Prisma.sql`OR (state."status" = 'ready' AND state."semanticIndexedSha" = ${input.sourceCommitSha} AND state."graphIndexedSha" = ${input.sourceCommitSha})`})
     ${input.processingClaimToken ? Prisma.sql`AND state."status" = 'processing'` : Prisma.empty}
    ${keywordJoin}
    JOIN "Document" AS document
      ON document."id" = state."documentId"
     AND document."projectId" = ${input.projectId}::uuid
     AND document."headCommitSha" = ${input.sourceCommitSha}
    JOIN "Project" AS project
      ON project."id" = generation."projectId" AND project."deletedAt" IS NULL
    WHERE generation."id" = ${input.generationId}::uuid
      AND generation."projectId" = ${input.projectId}::uuid
      AND generation."status" IN ('active', 'building')
      AND generation."configFingerprint" = ${input.configFingerprint}
      AND generation."embeddingDimensions" = ${input.embeddingDimensions}
    ${lock}
  `);
  return target ?? null;
}

export function knowledgeTransaction<T>(
  db: PrismaClient,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number; maxWait?: number } = {},
): Promise<T> {
  // Allow a full publication to finish before waiting writers do their own work.
  return db.$transaction(action, {
    timeout: 120_000,
    maxWait: 10_000,
    ...options,
  });
}
