import { createHash } from "node:crypto";
import type { JobExecution } from "./queue";

type DocumentSourcePayload = {
  projectId: string;
  documentId: string;
  sourceCommitSha: string;
  pathAtSha: string;
};

type TableSourcePayload = {
  projectId: string;
  tableId: string;
  sourceCommitSha: string;
  pathAtSha: string;
};

export type KnowledgeJobPayloads = {
  "artifact.notebook.prepare": {
    projectId: string;
    artifactId: string;
    contentDigest: string;
  };
  "document.search-sync": DocumentSourcePayload;
  "document.ai-enrich": DocumentSourcePayload & {
    generationId: string;
    configFingerprint: string;
  };
  "document.change-summary": {
    projectId: string;
    documentId: string;
    commitSha: string;
    baseCommitSha: string;
    pathAtSha: string;
  };
  "table.search-sync": TableSourcePayload;
  "content.delete": {
    projectId: string;
    sourceType: "document" | "table";
    sourceId: string;
    sourceCommitSha: string;
  };
  "project.reconcile": { projectId: string; repairDocumentIds?: string[] };
  "project.generation-build": {
    projectId: string;
    generationId: string;
    configFingerprint: string;
    cursor?: string;
  };
  "system.reconcile": Record<string, never>;
  "assistant.reconcile": Record<string, never>;
  "assistant.run": { runId: string };
  "ingestion.parse": IngestionStagePayload;
  "ingestion.analyze": IngestionStagePayload;
  "ingestion.link": IngestionStagePayload;
  "project.git-sync": Record<string, never>;
  "project.git-push": { projectId: string; queueToken: string };
  "project.git-pull": { projectId: string; pullToken: string };
  "task.tick": Record<string, never>;
  "exam.tick": Record<string, never>;
  "task.run": { runId: string; taskId: string };
};

export type IngestionStagePayload = {
  fileId: string;
  projectId: string;
  contentDigest: string;
  baseAttemptCount: number;
};

export type KnowledgeJobName = keyof KnowledgeJobPayloads;

export const KNOWLEDGE_JOB_EXPIRE_IN_SECONDS = 15 * 60;
/** pg-boss caps job expiration at 24 hours. */
export const KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS = 24 * 60 * 60;
/** Enrichment aborts its provider calls here, one maximum call plus margin before the lease ends. */
export const KNOWLEDGE_ENRICHMENT_DEADLINE_MS = 23 * 60 * 60 * 1_000;
/** Must exceed the parser's own OCR wall clock, or pg-boss redelivers a running scan. */
export const INGESTION_PARSE_EXPIRE_IN_SECONDS = 60 * 60;
/** Longer than the runner's own 15-minute timeout, so pg-boss never redelivers a live run. */
export const TASK_RUN_EXPIRE_IN_SECONDS = 20 * 60;
/** Longer than ASSISTANT_RUN_TIMEOUT_MS (two hours), so pg-boss never expires a live run. */
export const ASSISTANT_RUN_EXPIRE_IN_SECONDS = 125 * 60;

export function knowledgeJobExpireInSeconds(name: string): number {
  if (name === "system.reconcile") return 60 * 60;
  if (name === "document.ai-enrich")
    return KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS;
  if (name === "ingestion.parse") return INGESTION_PARSE_EXPIRE_IN_SECONDS;
  if (name === "task.run") return TASK_RUN_EXPIRE_IN_SECONDS;
  if (name === "assistant.run") return ASSISTANT_RUN_EXPIRE_IN_SECONDS;
  return KNOWLEDGE_JOB_EXPIRE_IN_SECONDS;
}

export function knowledgeJobWorkerConcurrency(
  name: string,
  configuredConcurrency: number,
): number {
  return ["document.ai-enrich", "artifact.notebook.prepare"].includes(name)
    ? 1
    : configuredConcurrency;
}

export type JobSendOptions = { singletonKey?: string };

export type ArtifactNotebookRunner = (
  payload: KnowledgeJobPayloads["artifact.notebook.prepare"],
  execution: JobExecution,
) => Promise<void>;

export type AssistantRunner = (
  payload: KnowledgeJobPayloads["assistant.run"],
  execution: JobExecution,
) => Promise<void>;

export type IngestionParseRunner = (
  payload: KnowledgeJobPayloads["ingestion.parse"],
  execution: JobExecution,
) => Promise<void>;

export type IngestionAnalyzeRunner = (
  payload: KnowledgeJobPayloads["ingestion.analyze"],
  execution: JobExecution,
) => Promise<void>;

export type IngestionLinkRunner = (
  payload: KnowledgeJobPayloads["ingestion.link"],
  execution: JobExecution,
) => Promise<void>;

export type TaskRunner = (
  payload: KnowledgeJobPayloads["task.run"],
  execution: JobExecution,
) => Promise<void>;

export function knowledgeJobSendOptions(
  name: string,
  data: object,
): JobSendOptions | undefined {
  // No singleton key for assistant.run: pg-boss only enforces one on a queue
  // whose policy is short/singleton/stately, and this queue is standard so the
  // key would be stored and ignored. A duplicate delivery is harmless anyway —
  // leaseRunAttempt claims the run with `where: { status: "queued" }`, so every
  // extra delivery finds nothing to lease and acks as a no-op.
  if (
    ["ingestion.parse", "ingestion.analyze", "ingestion.link"].includes(name)
  ) {
    const payload = data as Partial<IngestionStagePayload>;
    return payload.fileId &&
      payload.contentDigest &&
      Number.isSafeInteger(payload.baseAttemptCount)
      ? {
          singletonKey: `${name}:${payload.fileId}:${payload.contentDigest}:${payload.baseAttemptCount}`,
        }
      : undefined;
  }
  if (name === "artifact.notebook.prepare") {
    const payload = data as Partial<
      KnowledgeJobPayloads["artifact.notebook.prepare"]
    >;
    return payload.artifactId && payload.contentDigest
      ? { singletonKey: `${payload.artifactId}:${payload.contentDigest}` }
      : undefined;
  }
  if (name === "content.delete") {
    const payload = data as Partial<KnowledgeJobPayloads["content.delete"]>;
    return payload.sourceId && payload.sourceCommitSha
      ? {
          singletonKey: `${payload.sourceType}:${payload.sourceId}:${payload.sourceCommitSha}`,
        }
      : undefined;
  }
  if (name === "project.reconcile") {
    const payload = data as Partial<KnowledgeJobPayloads["project.reconcile"]>;
    return payload.projectId
      ? {
          singletonKey: payload.repairDocumentIds?.length
            ? `${payload.projectId}:repair:${[...payload.repairDocumentIds].sort().join(",")}`
            : payload.projectId,
        }
      : undefined;
  }
  if (name === "document.search-sync") {
    const payload = data as Partial<
      KnowledgeJobPayloads["document.search-sync"]
    >;
    return payload.documentId && payload.sourceCommitSha
      ? { singletonKey: `${payload.documentId}:${payload.sourceCommitSha}` }
      : undefined;
  }
  if (name === "document.change-summary") {
    const payload = data as Partial<
      KnowledgeJobPayloads["document.change-summary"]
    >;
    return payload.projectId && payload.commitSha
      ? { singletonKey: `${payload.projectId}:${payload.commitSha}` }
      : undefined;
  }
  if (name === "task.run") {
    const payload = data as Partial<KnowledgeJobPayloads["task.run"]>;
    return payload.taskId ? { singletonKey: payload.taskId } : undefined;
  }
  if (name !== "document.ai-enrich") return undefined;
  const payload = data as Partial<KnowledgeJobPayloads["document.ai-enrich"]>;
  if (
    !payload.generationId ||
    !payload.documentId ||
    !payload.sourceCommitSha ||
    !payload.configFingerprint
  ) {
    return undefined;
  }
  const identity = JSON.stringify([
    payload.generationId,
    payload.documentId,
    payload.sourceCommitSha,
    payload.configFingerprint,
  ]);
  return {
    singletonKey: createHash("sha256").update(identity).digest("hex"),
  };
}

export const KNOWLEDGE_JOB_NAMES = [
  "artifact.notebook.prepare",
  "document.search-sync",
  "document.ai-enrich",
  "document.change-summary",
  "table.search-sync",
  "content.delete",
  "project.reconcile",
  "project.generation-build",
  "system.reconcile",
  "assistant.reconcile",
  "assistant.run",
  "ingestion.parse",
  "ingestion.analyze",
  "ingestion.link",
  "project.git-sync",
  "task.tick",
  "exam.tick",
  "task.run",
  "project.git-push",
  "project.git-pull",
] as const satisfies readonly KnowledgeJobName[];

/** Job names with a cron schedule; each is registered once per worker runtime. */
export const SCHEDULED_JOB_NAMES = [
  "system.reconcile",
  "assistant.reconcile",
  "project.git-sync",
  "task.tick",
  "exam.tick",
] as const;
export type ScheduledJobName = (typeof SCHEDULED_JOB_NAMES)[number];
