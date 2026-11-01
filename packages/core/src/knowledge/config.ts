import type { LlmEmbeddingDimensionMode } from "@weaver/db/client";

import {
  effectiveVectorSpaceKey,
  knowledgeIndexFingerprint,
  type ExtractionModelIdentity,
  type VectorSpaceModel,
} from "./identity";

export const KNOWLEDGE_EXTRACTION_SCHEMA_VERSION = 1;
export const KNOWLEDGE_PROMPT_VERSION = "prompt-v2";
import { rawCommonSchema } from "@weaver/config/jobs";
export { MAX_KNOWLEDGE_WORKER_CONCURRENCY } from "@weaver/config/jobs";
const DEFAULT_WORKER_CONCURRENCY = 2;
const DEFAULT_RECONCILE_CRON = "*/15 * * * *";
const DEFAULT_ASSISTANT_RECONCILE_CRON = "* * * * *";
const DEFAULT_TASK_TICK_CRON = "* * * * *";

export type KnowledgeConfig = {
  jobsEnabled: boolean;
  ingestionTmpTtlMinutes: number;
  workerConcurrency: number;
  reconcileCron: string;
  assistantReconcileCron: string;
  taskTickCron: string;
};

export const knowledgeConfigSchema = rawCommonSchema.transform(
  (raw): KnowledgeConfig => ({
    jobsEnabled: raw.WEAVER_JOBS_ENABLED === "true",
    ingestionTmpTtlMinutes: raw.WEAVER_INGESTION_TMP_TTL_MINUTES,
    workerConcurrency: raw.WEAVER_JOB_WORKER_CONCURRENCY,
    reconcileCron: raw.WEAVER_KNOWLEDGE_RECONCILE_CRON,
    assistantReconcileCron: raw.WEAVER_ASSISTANT_RECONCILE_CRON,
    taskTickCron: raw.WEAVER_TASK_TICK_CRON,
  }),
);

export function parseKnowledgeConfig(
  raw: Record<string, string | undefined>,
): KnowledgeConfig {
  if (raw.SKIP_ENV_VALIDATION) {
    return {
      jobsEnabled: raw.WEAVER_JOBS_ENABLED !== "false",
      ingestionTmpTtlMinutes: 60,
      workerConcurrency: DEFAULT_WORKER_CONCURRENCY,
      reconcileCron: DEFAULT_RECONCILE_CRON,
      assistantReconcileCron: DEFAULT_ASSISTANT_RECONCILE_CRON,
      taskTickCron: DEFAULT_TASK_TICK_CRON,
    };
  }
  const withoutBlanks = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== ""),
  );
  return knowledgeConfigSchema.parse(withoutBlanks);
}

export type KnowledgeRoutingIdentity = {
  extraction: ExtractionModelIdentity;
  embedding: VectorSpaceModel & {
    embeddingDimensions: number;
    embeddingDimensionMode: LlmEmbeddingDimensionMode;
  };
};

/** Same value means comparable vectors; the extraction route and prompt are per-document provenance. */
export function knowledgeConfigFingerprint(
  routing: KnowledgeRoutingIdentity | null,
  extractionSchemaVersion: number = KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
): string {
  return knowledgeIndexFingerprint(
    routing
      ? {
          vectorSpaceKey: effectiveVectorSpaceKey(routing.embedding),
          embeddingDimensions: routing.embedding.embeddingDimensions,
          embeddingDimensionMode: routing.embedding.embeddingDimensionMode,
        }
      : null,
    extractionSchemaVersion,
  );
}
